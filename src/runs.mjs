import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adapters } from './agents.mjs';
import { executeProcess, launchCheck } from './checks.mjs';
import { decodeImages } from './images.mjs';
import { permissionDenials, stopTree } from './claude.mjs';
import { RequestError, stageError } from './errors.mjs';
import { environmentSecrets, outputBuffer } from './output.mjs';
import { evidence, finalStatus, limits, parseAction, resolveAgent, supervisorPrompt, supervisorSchemaPath, workerPrompt } from './supervisor.mjs';
import { captureWorkspace } from './workspace.mjs';
import { mergeModels } from './usage.mjs';

export const activeStatuses = ['в очереди', 'выполнение', 'остановка'];
const diffLimit = 20000, supervisorRetries = 1, logTail = 16000, latestLimit = 400;

// Each run has its own file, so a live log does not rewrite the history of every other task twice a second.
export function createRunStore(directory) {
  const path = id => resolve(directory, `${id}.json`);
  const pending = new Map();
  return {
    async load() {
      await mkdir(directory, { recursive: true });
      const runs = [];
      for (const name of await readdir(directory)) if (name.endsWith('.json')) runs.push(JSON.parse(await readFile(resolve(directory, name), 'utf8')));
      return runs;
    },
    save(run) {
      const text = JSON.stringify(run);
      const operation = (pending.get(run.taskId) || Promise.resolve()).catch(() => {}).then(async () => {
        const temp = resolve(directory, `${run.taskId}-${randomUUID()}.tmp`);
        await writeFile(temp, text, { mode: 0o600 });
        await rename(temp, path(run.taskId));
      });
      pending.set(run.taskId, operation);
      return operation;
    },
    async remove(taskIds) { await Promise.all(taskIds.map(id => rm(path(id), { force: true }))); }
  };
}

export function createRuns({ getState, store, environmentFor, launch, stop = stopTree, capture = captureWorkspace, checkLaunch = launchCheck,
  checksEnvironment = () => process.env, snapshots = null, usage: ledger = null, images: imageStore = null, timeoutMs = 30 * 60 * 1000, supervisorTimeoutMs = 5 * 60 * 1000, maxActive = 3, budgetMs = limits.budgetMinutes * 60 * 1000, initial = [] }) {
  const runs = new Map(initial.map(run => [run.taskId, run]));
  const active = new Map(), queue = [];
  let shuttingDown = false;

  const findTask = taskId => {
    const task = getState().tasks.find(item => item.id === taskId), project = task && getState().projects.find(item => item.id === task.projectId);
    if (!project) throw new RequestError('Задача или проект не найдены', 404);
    return { task, project };
  };
  const directoryKey = path => path.replaceAll('\\', '/').toLowerCase();
  const directoryBusy = path => [...active.values()].some(item => directoryKey(item.run.directory) === directoryKey(path));
  const note = (run, kind, fields) => { run.journal.push({ at: new Date().toISOString(), kind, ...fields }); };
  const launcher = options => (launch || adapters[options.agent].launch)(options);

  async function shot(run, workspace) {
    if (!snapshots) return null;
    try { return await snapshots.take(run.taskId, run.directory, workspace); }
    catch (error) { return { error: stageError('Не удалось сделать снимок', error).message }; }
  }

  // One process with bounded output, used for the supervisor and for every worker.
  async function runAgent(running, target, { kind, role, prompt, readOnly, schemaPath, noTools, resumeSessionId, allowedTools, timeout, images = [] }) {
    const prepared = await environmentFor(role.profile, role.agent);
    // A stop during the key lookup must not start a process that nothing would then stop.
    if (running.stopReason) throw new RequestError('Остановлено до запуска процесса.', 400);
    // A picture the user attached must never be dropped silently: without it the model would answer about something else.
    const attached = await Promise.all(images.map(async image => {
      const path = imageStore?.path(running.run.taskId, image);
      try { await access(path); } catch { throw new RequestError('Файл приложенного изображения недоступен. Проверьте каталог данных приложения.', 400); }
      return { path, type: image.type };
    }));
    if (role.agent === 'codex' && attached.some(image => image.path.includes(','))) throw new RequestError('Codex не примет изображения: в пути к каталогу данных приложения есть запятая.', 400);
    const secrets = prepared.secrets || [], adapter = adapters[role.agent];
    const append = outputBuffer(target, secrets, running.changed), diagnostic = outputBuffer(target.diagnostics, secrets, running.changed), parser = adapter.stream(append);
    let child, timedOut = false;
    const outcome = await executeProcess({
      launch: () => (child = launcher({ agent: role.agent, profile: role.profile, model: role.model, cwd: running.run.directory, environment: prepared.environment, prompt, readOnly, schemaPath, noTools, resumeSessionId, allowedTools, images: attached, supervisor: !!noTools })), running,
      onStdout: chunk => parser.push(chunk), onStderr: diagnostic, timeoutMs: timeout,
      onTimeout: () => { timedOut = true; if (child) void stop(child).catch(() => {}); } });
    const streamedSession = parser.sessionId();
    const status = outcome.spawnError ? 'ошибка' : parser.finish(outcome.code);
    append('', true); diagnostic('', true);
    const answer = { output: '', outputTruncated: false };
    outputBuffer(answer, secrets, () => {})(parser.finalText?.() || '', true);
    const failure = { output: '', outputTruncated: false };
    outputBuffer(failure, secrets, () => {})(parser.errorText?.() || '', true);
    // The CLI prices tokens at Anthropic's list, which says nothing about what a proxy or DeepSeek charges.
    const priced = role.profile === 'subscription';
    if (priced) running.run.costUsd = (running.run.costUsd || 0) + (parser.cost?.() || 0);
    const usage = parser.usage?.() || { models: [], partial: false, limits: null };
    const models = usage.models.map(item => ({ ...item, model: item.model || role.model || '', costUsd: priced ? item.costUsd : null }));
    if (models.length) void ledger?.append({ at: new Date().toISOString(), taskId: running.run.taskId, kind, agentId: role.id, label: role.label, profile: role.profile, models, ...(usage.partial ? { partial: true } : {}), ...(priced && usage.limits ? { limits: usage.limits } : {}) });
    return { status, code: outcome.code, signal: outcome.signal, spawnError: outcome.spawnError, timedOut, answer: answer.output, truncated: answer.outputTruncated, failure: failure.output,
      session: running.stopReason || timedOut ? streamedSession : parser.sessionId(), denials: permissionDenials(parser.denials?.() || [], secrets), usage: { models, partial: usage.partial } };
  }

  async function decide(running, task, project) {
    const run = running.run, role = run.supervisor;
    let feedback = '';
    for (let attempt = 0; attempt <= supervisorRetries; attempt++) {
      run.phase = 'Супервизор выбирает следующий шаг'; running.changed();
      const log = { output: '', outputTruncated: false, diagnostics: { output: '', outputTruncated: false } };
      const result = await runAgent(running, log, { kind: 'supervisor', role, prompt: supervisorPrompt(run, task, project, feedback), readOnly: true, noTools: true, schemaPath: supervisorSchemaPath, timeout: supervisorTimeoutMs, images: run.images || [] });
      run.supervisorUsage = mergeModels(run.supervisorUsage, result.usage.models);
      if (running.stopReason) return null;
      if (result.spawnError) throw new RequestError(`Не удалось запустить CLI супервизора (${adapters[role.agent].name}). Проверьте, что он установлен и доступен серверу.`, 400);
      if (result.timedOut) throw new RequestError('Супервизор не ответил за отведённое время.', 400);
      if (result.status === 'ошибка') throw new RequestError(`CLI супервизора завершился ошибкой (код ${result.code ?? 'нет'}). ${result.failure || log.diagnostics.output.slice(-1000) || 'Проверьте авторизацию и лимиты.'}`.trim(), 400);
      try { return parseAction(result.answer, run, project); }
      catch (error) { if (!(error instanceof RequestError)) throw error; feedback = error.message; }
    }
    note(run, 'note', { text: `Супервизор дважды дал некорректный ответ: ${feedback}` });
    throw new RequestError(`Супервизор дважды дал некорректный ответ: ${feedback}`, 400);
  }

  async function runWorker(running, task, spec) {
    const run = running.run, write = spec.access === 'write';
    // A continued session already holds what it was shown, so it receives only the pictures that came later.
    const seen = new Set(spec.resume?.images || []), images = (run.images || []).filter(image => !seen.has(image.id));
    const worker = { id: `w${run.workers.length + 1}`, name: spec.name, rosterId: spec.agent.id, agent: spec.agent.agent, profile: spec.agent.profile, model: spec.agent.model, access: spec.access, images: [...seen, ...images.map(image => image.id)],
      prompt: spec.prompt, status: 'выполняется', startedAt: new Date().toISOString(), output: '', outputTruncated: false, diagnostics: { output: '', outputTruncated: false }, ...(spec.resume ? { continued: spec.resume.id } : {}),
      ...(write ? { before: { fingerprint: run.current.fingerprint, snapshot: run.current.snapshot } } : {}) };
    run.workers.push(worker); run.counters.workerStarts++; running.changed();
    try {
      // Grants come only from refusals the user approved, and a read-only worker never needs one.
      const allowedTools = write && spec.agent.agent === 'claude' && run.grants?.length ? run.grants : undefined;
      const result = await runAgent(running, worker, { kind: 'worker', role: spec.agent, prompt: workerPrompt(run, task, worker, images.length), readOnly: !write, resumeSessionId: spec.resume?.session, allowedTools, timeout: timeoutMs, images });
      worker.usage = result.usage.models; if (result.usage.partial) worker.usagePartial = true;
      worker.exitCode = result.code; worker.signal = result.signal; worker.answer = result.answer; worker.session = write ? result.session || spec.resume?.session : undefined;
      if (result.denials.length) worker.denials = result.denials;
      if (spec.resume && result.status !== 'ошибка' && result.session !== spec.resume.session) { worker.status = 'ошибка'; worker.error = 'CLI не подтвердил продолжение выбранной сессии.'; }
      else if (running.stopReason) worker.status = 'прервано';
      else if (result.timedOut) { worker.status = 'таймаут'; worker.error = `Воркер не завершился за ${Math.round(timeoutMs / 60000)} мин и остановлен.`; }
      else if (result.spawnError) { worker.status = 'ошибка'; worker.error = 'Не удалось запустить CLI воркера.'; }
      else if (result.status === 'ошибка') { worker.status = 'ошибка'; worker.error = (result.failure || worker.diagnostics.output.slice(-800) || `CLI завершился с кодом ${result.code ?? 'нет'}.`); }
      else if (result.status === 'требуется решение' && write) worker.status = 'отказ в правах';
      else if (!write && !worker.answer?.trim()) { worker.status = 'ошибка'; worker.error = 'Воркер не дал ответа.'; }
      else worker.status = 'готово';
    } catch (error) { worker.status = 'ошибка'; worker.error = stageError('Не удалось подготовить профиль агента', error).message; }
    if (write) await afterWrite(running, worker);
    worker.endedAt = new Date().toISOString(); running.changed();
    return worker;
  }
  // Compares snapshots rather than reading Git status: status also lists what the user had changed before the worker.
  async function pathsBetween(run, from, to) {
    if (!snapshots || !from?.tree || !to?.tree) return [];
    try { return (await snapshots.diff(run.taskId, run.directory, from.tree, to.tree)).files.map(file => file.path); }
    catch { return []; }
  }
  // Files are hashed once per writer and once at the end, not after every step: on a large repository this is the slow part.
  async function afterWrite(running, worker) {
    const run = running.run;
    try {
      const after = await capture(run.directory);
      after.snapshot = await shot(run, after);
      worker.filesChanged = after.fingerprint !== worker.before.fingerprint;
      worker.after = { fingerprint: after.fingerprint, snapshot: after.snapshot };
      worker.changedPaths = worker.filesChanged ? await pathsBetween(run, worker.before.snapshot, after.snapshot) : [];
      run.current = { fingerprint: after.fingerprint, snapshot: after.snapshot, head: after.head, branch: after.branch };
    } catch (error) { worker.error = [worker.error, stageError('Не удалось определить состояние файлов', error).message].filter(Boolean).join(' '); }
  }

  async function runChecks(running, project, ids) {
    const run = running.run, environment = { ...checksEnvironment() }, secrets = environmentSecrets(environment);
    const definitions = (project.checks || []).filter(check => ids.includes(check.id));
    const record = { id: `c${run.checkRuns.length + 1}`, startedAt: new Date().toISOString(), fingerprint: run.current.fingerprint, status: 'выполняются',
      results: definitions.map(definition => ({ definition: structuredClone(definition), status: 'не выполнена', exitCode: null, signal: null, output: '', outputTruncated: false })) };
    run.checkRuns.push(record); running.changed();
    for (const result of record.results) {
      if (running.stopReason) break;
      run.phase = `Проверка: ${result.definition.name}`; result.status = 'выполнение'; result.startedAt = new Date().toISOString(); running.changed();
      const append = outputBuffer(result, secrets, running.changed), appendError = outputBuffer(result, secrets, running.changed);
      let child, timedOut = false;
      const outcome = await executeProcess({ launch: () => (child = checkLaunch({ definition: result.definition, cwd: run.directory, environment })), running, onStdout: append, onStderr: appendError,
        timeoutMs: result.definition.timeoutSeconds * 1000, onTimeout: () => { timedOut = true; if (child) void stop(child).catch(() => {}); } });
      append('', true); appendError('', true);
      result.exitCode = outcome.code; result.signal = outcome.signal; result.endedAt = new Date().toISOString();
      result.status = timedOut ? 'таймаут' : running.stopReason ? 'отменена' : outcome.spawnError ? 'ошибка запуска' : outcome.code === 0 ? 'пройдена' : 'ошибка';
      running.changed();
    }
    record.status = running.stopReason ? 'прерваны' : record.results.every(result => result.status === 'пройдена') ? 'пройдены' : 'есть ошибки';
    record.endedAt = new Date().toISOString();
    note(run, 'checks', { id: record.id }); running.changed();
  }

  async function diffText(run) {
    const from = run.baseline.snapshot, to = run.current.snapshot;
    if (!snapshots || !from?.tree || !to?.tree) return 'Diff недоступен: снимки не сохранены.';
    try {
      const diff = await snapshots.diff(run.taskId, run.directory, from.tree, to.tree);
      if (!diff.files.length) return 'Файлы не изменились с начала задачи.';
      const text = diff.files.map(file => file.patch || `${file.status} ${file.path}`).join('\n');
      return text.length > diffLimit ? `${text.slice(0, diffLimit)}\n[…diff обрезан; файлов всего: ${diff.files.length}…]` : text;
    } catch { return 'Не удалось прочитать снимки.'; }
  }

  function finish(run, status, reason) { run.status = status; run.statusReason = reason; run.phase = ''; run.endedAt = new Date().toISOString(); }

  async function work(running) {
    const run = running.run, { task, project } = findTask(run.taskId);
    run.deadlineAt = new Date(Date.now() + budgetMs).toISOString();
    while (true) {
      if (shuttingDown) running.stopReason ??= 'остановка сервера';
      if (running.stopReason) return;
      if (Date.now() > Date.parse(run.deadlineAt)) { finish(run, 'требуется решение', `Исчерпан лимит времени (${Math.round(budgetMs / 60000)} мин). Напишите сообщение, чтобы продолжить.`); return; }
      if (run.counters.turns >= limits.turns || run.counters.workerStarts >= limits.workerStarts) { finish(run, 'требуется решение', 'Исчерпан лимит шагов. Напишите сообщение, чтобы продолжить.'); return; }
      run.counters.turns++;
      const action = await decide(running, task, project);
      if (!action || running.stopReason) return;
      note(run, 'decision', { action: action.action, reason: action.reason });
      if (action.action === 'run_workers') {
        run.phase = action.workers.length > 1 ? `Работают воркеры: ${action.workers.map(worker => worker.name).join(', ')}` : `Работает: ${action.workers[0].name}`; running.changed();
        const workers = await Promise.all(action.workers.map(worker => runWorker(running, task, worker)));
        note(run, 'workers', { ids: workers.map(worker => worker.id) });
      } else if (action.action === 'run_checks') await runChecks(running, project, action.checkIds);
      else if (action.action === 'get_diff') { run.phase = 'Собираем diff'; note(run, 'diff', { text: await diffText(run) }); }
      else if (action.action === 'ask_user') {
        run.waiting = { question: action.question, askedAt: new Date().toISOString() };
        finish(run, 'ждёт ответа', 'Супервизору нужен ваш ответ.'); return;
      } else {
        run.phase = 'Сверяем итоговое состояние файлов'; running.changed();
        let final = null;
        try { final = await capture(run.directory); if (final.fingerprint !== run.current.fingerprint) { final.snapshot = await shot(run, final); run.current = { fingerprint: final.fingerprint, snapshot: final.snapshot, head: final.head, branch: final.branch }; } } catch { /* Reported below as an undetermined state. */ }
        const facts = evidence(run, final), { status, reason } = finalStatus(action.outcome, facts);
        run.report = { outcome: action.outcome, summary: action.summary, evidence: facts, at: new Date().toISOString() };
        finish(run, status, reason); return;
      }
      running.changed();
    }
  }

  function launchRun(run) {
    const running = { run, children: new Set(), stopReason: null, dirty: false, storageFailed: false, stopping: null, changed: () => { running.dirty = true; } };
    active.set(run.taskId, running); run.status = 'выполнение'; run.startedAt ??= new Date().toISOString(); delete run.endedAt;
    let pendingSave = Promise.resolve();
    const interval = setInterval(() => {
      if (!running.dirty) return; running.dirty = false;
      pendingSave = pendingSave.then(() => store.save(run)).catch(() => {
        running.storageFailed = true; run.error = 'Не удалось сохранить журнал задачи.';
        void api.stop(run.taskId, 'ошибка сохранения').catch(() => {});
      });
    }, 500);
    void (async () => {
      try { await work(running); }
      catch (error) {
        run.error = stageError('Ошибка выполнения', error).message;
        finish(run, 'ошибка', run.error);
      } finally {
        clearInterval(interval);
        await pendingSave;
        if (running.stopReason) { run.waiting = null; finish(run, running.stopReason === 'отмена пользователем' ? 'отменена' : 'прервана', `Остановлено: ${running.stopReason}.`); }
        else if (running.storageFailed) finish(run, 'ошибка', run.error);
        active.delete(run.taskId);
        try { await store.save(run); } catch { run.error = 'Не удалось сохранить итог задачи.'; }
        pump();
      }
    })();
  }

  // Tasks in different directories run side by side; the same directory never has two at once.
  function pump() {
    if (shuttingDown) return;
    for (const taskId of [...queue]) {
      if (active.size >= maxActive) return;
      const run = runs.get(taskId);
      if (!run) { queue.splice(queue.indexOf(taskId), 1); continue; }
      if (directoryBusy(run.directory)) continue;
      queue.splice(queue.indexOf(taskId), 1);
      launchRun(run);
    }
  }

  function roster() {
    const { settings } = getState();
    return { supervisor: resolveAgent(settings.supervisor), workers: settings.workers.map(resolveAgent) };
  }
  async function begin(run) {
    run.status = 'в очереди'; run.phase = ''; run.counters = { turns: 0, workerStarts: 0 }; run.error = undefined;
    const team = roster(); run.supervisor = team.supervisor; run.roster = team.workers;
    await store.save(run); queue.push(run.taskId); pump();
  }
  // The page polls this while a task runs, so logs travel as tails; a full log is fetched only when asked for.
  const publicRun = run => run && {
    ...run, active: active.has(run.taskId), queued: queue.includes(run.taskId),
    workers: run.workers.map(worker => ({ ...worker, output: worker.output.slice(-logTail), logTrimmed: worker.output.length > logTail })),
    checkRuns: run.checkRuns.map(check => ({ ...check, results: check.results.map(result => ({ ...result, output: result.output.slice(-logTail), logTrimmed: result.output.length > logTail })) }))
  };

  const api = {
    get: taskId => { findTask(taskId); return publicRun(runs.get(taskId)) || null; },
    imagesOf(taskId) { const { task } = findTask(taskId); return runs.get(taskId)?.images || task.images || []; },
    worker(taskId, workerId) {
      findTask(taskId); const worker = runs.get(taskId)?.workers.find(item => item.id === workerId);
      if (!worker) throw new RequestError('Воркер не найден', 404);
      return worker;
    },
    statuses() { return Object.fromEntries([...runs].map(([taskId, run]) => [taskId, run.status])); },
    questions() { return Object.fromEntries([...runs].filter(([, run]) => run.waiting && !active.has(run.taskId) && !queue.includes(run.taskId)).map(([taskId, run]) => [taskId, run.waiting.question])); },
    // What a dashboard card shows. A waiting question travels separately, together with its answer box.
    latest() {
      const brief = text => text.length > latestLimit ? `${text.slice(0, latestLimit)}…` : text;
      const entries = [...runs].flatMap(([taskId, run]) => {
        const queued = queue.includes(taskId), working = active.has(taskId) || queued;
        if (working) {
          const reason = run.journal.findLast(entry => entry.kind === 'decision')?.reason;
          return [[taskId, { kind: 'decision', text: brief(reason || ''), now: queued ? 'ждёт, пока освободится директория' : run.phase || '' }]];
        }
        if (run.waiting) return [];
        if (run.report) return [[taskId, { kind: 'report', text: brief(run.report.summary) }]];
        return run.statusReason ? [[taskId, { kind: 'status', text: brief(run.statusReason) }]] : [];
      });
      return Object.fromEntries(entries);
    },
    async start(taskId) {
      if (shuttingDown) throw new RequestError('Сервер останавливается', 409);
      const { task, project } = findTask(taskId);
      if (runs.has(taskId)) throw new RequestError('Задача уже запущена', 409);
      let baseline;
      try { baseline = await capture(project.path); }
      catch (error) { throw stageError('Не удалось прочитать Git-состояние и содержимое файлов', error); }
      const run = { id: randomUUID(), taskId, directory: baseline.path, status: 'в очереди', createdAt: new Date().toISOString(), baseline, journal: [], workers: [], checkRuns: [], grants: [], images: [...(task.images || [])], counters: { turns: 0, workerStarts: 0 }, costUsd: 0 };
      baseline.snapshot = await shot(run, baseline);
      run.current = { fingerprint: baseline.fingerprint, snapshot: baseline.snapshot, head: baseline.head, branch: baseline.branch };
      note(run, 'user', { text: task.description, ...(run.images.length ? { images: run.images.map(image => image.id) } : {}) });
      runs.set(taskId, run);
      await begin(run);
      return publicRun(run);
    },
    // A message reaches a working supervisor at its next decision; a finished task simply continues.
    async message(taskId, text, allowDenied = false, imageInput) {
      if (shuttingDown) throw new RequestError('Сервер останавливается', 409);
      findTask(taskId);
      if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw new RequestError('Сообщение должно содержать от 1 до 10000 символов', 400);
      const run = runs.get(taskId);
      if (!run) throw new RequestError('Задача ещё не запускалась', 400);
      run.images ??= [];
      const decoded = decodeImages(imageInput, run.images);
      if (decoded.length && !imageStore) throw new RequestError('Хранилище изображений не настроено', 400);
      if (allowDenied) {
        // Rules come only from the stored refusals, never from the request.
        const rules = run.workers.flatMap(worker => worker.denials || []).map(denial => denial.rule).filter(Boolean).filter(rule => !run.grants.includes(rule));
        if (!rules.length) throw new RequestError('Нет отказов, которые можно разрешить, или CLI отклонил их, несмотря на выданное разрешение', 400);
        if (run.grants.length + rules.length > 20) throw new RequestError('В задаче слишком много выданных разрешений', 400);
        run.grants.push(...rules);
      }
      // Saved last among the checks, and awaited before the run can see them, so a refused message leaves no files.
      const saved = decoded.length ? await imageStore.save(taskId, decoded) : [];
      run.images.push(...saved);
      const attached = saved.length ? { images: saved.map(image => image.id) } : {};
      const waiting = run.waiting;
      if (waiting && !active.has(taskId)) { note(run, 'answer', { question: waiting.question, text: text.trim(), ...attached }); run.waiting = null; }
      else note(run, 'user', { text: text.trim(), ...attached });
      if (active.has(taskId)) { active.get(taskId).changed(); return publicRun(run); }
      if (queue.includes(taskId)) { await store.save(run); return publicRun(run); }
      if (run.report) run.previousOutcome = { outcome: run.report.outcome, summary: run.report.summary };
      run.report = null;
      await begin(run);
      return publicRun(run);
    },
    async stop(taskId, reason = 'отмена пользователем') {
      if (queue.includes(taskId)) {
        queue.splice(queue.indexOf(taskId), 1);
        const run = runs.get(taskId); finish(run, 'отменена', 'Снято с очереди.'); await store.save(run);
        return { status: 'отменена' };
      }
      const running = active.get(taskId);
      if (!running) throw new RequestError('Активный запуск не найден', 404);
      if (running.stopping) return running.stopping;
      running.stopReason = reason; running.run.status = 'остановка'; running.changed();
      running.stopping = (async () => {
        try { await Promise.all([...running.children].map(child => stop(child))); }
        catch { running.stopping = null; throw new RequestError('Не удалось подтвердить остановку дерева процессов. Повторите остановку.', 500); }
        return { status: 'остановка' };
      })();
      return running.stopping;
    },
    async diff(taskId, scope, workerId) {
      findTask(taskId); const run = runs.get(taskId);
      if (!run) throw new RequestError('Задача ещё не запускалась', 404);
      if (!['run', 'initial', 'worker'].includes(scope)) throw new RequestError('Неизвестная область diff', 400);
      const unavailable = reason => ({ scope, available: false, reason });
      if (!snapshots) return unavailable('Снимки не настроены.');
      let from, to;
      if (scope === 'worker') {
        const worker = run.workers.find(item => item.id === workerId);
        if (!worker?.before) throw new RequestError('Пишущий воркер не найден', 404);
        from = worker.before.snapshot?.tree; to = worker.after?.snapshot?.tree;
        if (!from || !to) return unavailable(worker.endedAt ? 'Снимок воркера не сохранён.' : 'Снимок появится после завершения воркера.');
      } else {
        const start = run.baseline.snapshot;
        if (!start?.tree) return unavailable(start?.error || 'Исходный снимок не сохранён.');
        if (scope === 'initial') { from = start.head; to = start.tree; }
        else { from = start.tree; to = run.current.snapshot?.tree; if (!to) return unavailable(run.current.snapshot?.error || 'Итоговый снимок не сохранён.'); }
      }
      try { return { scope, available: true, ...await snapshots.diff(taskId, run.directory, from, to) }; }
      catch (error) { return unavailable(error instanceof RequestError ? error.message : 'Не удалось прочитать снимки. Репозиторий мог быть перемещён, а объекты Git или снимка удалены.'); }
    },
    async acknowledgeRecovery() {
      for (const run of runs.values()) if (run.recoveryPending) { delete run.recoveryPending; await store.save(run); }
    },
    holds(taskIds) { return taskIds.some(id => active.has(id) || queue.includes(id)); },
    forget(taskIds) { for (const id of taskIds) runs.delete(id); },
    async shutdown() {
      shuttingDown = true; queue.length = 0;
      await Promise.all([...active.keys()].map(taskId => api.stop(taskId, 'остановка сервера')));
      while (active.size) await new Promise(next => setTimeout(next, 20));
    }
  };
  return api;
}
