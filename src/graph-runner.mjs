import { randomUUID } from 'node:crypto';
import { adapters } from './agents.mjs';
import { executeProcess } from './checks.mjs';
import { permissionDenials } from './claude.mjs';
import { RequestError, stageError } from './errors.mjs';
import { outputBuffer } from './output.mjs';
import { executorPrompt, fixPrompt, issueSignature, memberOutcome, memberPrompt, readiness, readPrompt, reviewOutcome, reviewSummary } from './graph.mjs';
import { parseReview, reviewSchemaPath } from './review.mjs';

export function initialGraphRun(graph, entry, workspace, config) {
  return { cursor: entry, entry: 'start', visits: {}, steps: [], decisions: [], issues: [], sessions: {}, fingerprint: workspace.fingerprint, snapshot: workspace.snapshot, config, waiting: null };
}
const roleOf = ({ agent, profile, model }) => ({ agent, profile, model });
const isWriter = node => ['executor', 'write'].includes(node.kind);

export function createGraphRunner({ environmentFor, launch, reviewerLaunch, inspect, snapshots, runChecks, applyFreshness, event, timeoutMs, cancel, isShuttingDown, configChanged, save, markUnhealthy }) {
  function addStep(attempt, node, extra = {}) {
    const step = { id: randomUUID(), nodeId: node.id, name: node.name, kind: node.kind, visit: attempt.graphRun.visits[node.id], status: 'выполняется', startedAt: new Date().toISOString(), ...extra };
    attempt.graphRun.steps.push(step); return step;
  }
  const finishStep = (step, status) => { step.status = status; step.endedAt = new Date().toISOString(); };
  const logs = () => ({ output: '', outputTruncated: false, diagnostics: { output: '', outputTruncated: false }, exitCode: null, signal: null });

  async function agentProcess(attempt, step, role, options, running, changed) {
    const prepared = await environmentFor(role.profile, role.agent);
    if (running.stopReason || running.storageFailed) return null;
    const adapter = adapters[role.agent], secrets = prepared.secrets || [];
    const append = outputBuffer(step, secrets, changed), diagnostic = outputBuffer(step.diagnostics, secrets, changed), parser = adapter.stream(append);
    const launcher = (options.readOnly ? reviewerLaunch : launch) || adapter.launch;
    const outcome = await executeProcess({ launch: () => launcher({ cwd: attempt.directory, environment: prepared.environment, ...role, ...options }), running,
      onStdout: chunk => parser.push(chunk), onStderr: diagnostic, timeoutMs,
      onTimeout: () => { void cancel(attempt.taskId, `таймаут шага «${step.name}»`).catch(() => {}); } });
    // A killed CLI may leave a cut-off last line, which finish() rejects along with the session of the complete events before it.
    const streamedSession = parser.sessionId();
    const status = outcome.spawnError ? 'ошибка' : parser.finish(outcome.code); append('', true); diagnostic('', true);
    step.exitCode = outcome.code; step.signal = outcome.signal;
    const answer = { output: '', outputTruncated: false };
    outputBuffer(answer, secrets, () => {})(parser.finalText?.() || '', true);
    return { status, code: outcome.code, spawnError: outcome.spawnError, session: running.stopReason ? streamedSession : parser.sessionId(), answer, denials: permissionDenials(parser.denials?.() || [], secrets) };
  }

  function stop(attempt, reason, changed, status = 'требуется решение') {
    attempt.status = status; attempt.automation.reason = reason; event(attempt, reason); changed();
    return 'stop';
  }

  async function runWriter(attempt, node, running, changed) {
    const state = attempt.graphRun, executor = node.kind === 'executor', role = roleOf(executor ? attempt : node);
    const resumeSessionId = executor ? attempt.sessionId : state.sessions[node.id];
    if (state.visits[node.id] > 1 && !resumeSessionId) return stop(attempt, `Шаг «${node.name}»: CLI не вернул сессию для продолжения.`, changed);
    // The first turn of a new run asks for the task; every later one asks to fix what was found.
    const firstTurn = executor && state.visits[node.id] === 1;
    const step = addStep(attempt, node, { ...role, ...logs(), before: { fingerprint: state.fingerprint, snapshot: state.snapshot } });
    attempt.status = 'выполнение'; event(attempt, `Шаг «${node.name}»: ${adapters[role.agent].name}, запись.`); changed();
    const result = await agentProcess(attempt, step, role, { prompt: firstTurn ? executorPrompt(attempt) : fixPrompt(node, attempt), resumeSessionId, allowedTools: executor ? attempt.allowedTools : undefined }, running, changed);
    if (!result) { finishStep(step, 'прервано'); return 'stop'; }
    let status = result.status;
    if (resumeSessionId && status !== 'ошибка' && result.session !== resumeSessionId) { status = 'ошибка'; attempt.error = 'CLI не подтвердил продолжение выбранной сессии. Следующие шаги не запускались.'; }
    if (result.session && (!resumeSessionId || result.session === resumeSessionId)) { if (executor) attempt.sessionId = result.session; else state.sessions[node.id] = result.session; }
    // A grant applies to the executor's session, so another writer's refusal cannot become one.
    if (result.denials.length) attempt.permissionDenials = executor ? result.denials : result.denials.map(denial => ({ ...denial, rule: null })); else delete attempt.permissionDenials;
    step.answer = result.answer.output;
    if (executor) { attempt.output = step.output; attempt.outputTruncated = step.outputTruncated; attempt.diagnostics = step.diagnostics; attempt.exitCode = step.exitCode; attempt.signal = step.signal; attempt.agentStatus = status; attempt.agentEndedAt = new Date().toISOString(); }
    event(attempt, status === 'выполнение завершено' ? `Шаг «${node.name}» завершён, код выхода ${result.code}. Выполнение задачи этим не подтверждается.` : `Шаг «${node.name}»: ${status}, код выхода ${result.code ?? 'отсутствует'}`);
    attempt.status = 'фиксация результата'; changed();
    try {
      const after = await inspect(attempt.directory);
      if (snapshots) after.snapshot = await snapshots.take(attempt.taskId, attempt.directory, after);
      attempt.after = after; step.after = { fingerprint: after.fingerprint, snapshot: after.snapshot };
    } catch (error) { attempt.snapshotError = stageError('Не удалось определить состояние после выполнения', error).message; }
    finishStep(step, status);
    if (running.stopReason || running.storageFailed) return 'stop';
    if (status === 'ошибка') { attempt.error ||= `Шаг «${node.name}» завершился ошибкой. Проверьте диагностику CLI.`; return stop(attempt, attempt.error, changed, 'ошибка'); }
    if (status === 'требуется решение') return stop(attempt, `Шаг «${node.name}»: CLI отклонил действия агента; требуется решение пользователя.`, changed);
    if (!step.after) return stop(attempt, 'Не удалось определить состояние файлов.', changed);
    const changedFiles = step.after.fingerprint !== state.fingerprint;
    state.fingerprint = step.after.fingerprint; state.snapshot = step.after.snapshot;
    if (state.entry === 'failure' && !changedFiles) return stop(attempt, `Шаг «${node.name}»: файлы не изменились, а проблемы остались.`, changed);
    return 'success';
  }

  async function runRead(attempt, node, running, changed) {
    const step = addStep(attempt, node, { ...roleOf(node), ...logs() });
    attempt.status = 'выполнение'; event(attempt, `Шаг «${node.name}»: ${adapters[node.agent].name}, только чтение.`); changed();
    const result = await agentProcess(attempt, step, roleOf(node), { prompt: readPrompt(node, attempt), readOnly: true }, running, changed);
    if (!result) { finishStep(step, 'прервано'); return 'stop'; }
    step.answer = result.answer.output;
    // A refused action is the read-only boundary working; the answer stands.
    const good = !result.spawnError && result.code === 0 && ['выполнение завершено', 'требуется решение'].includes(result.status) && !!step.answer.trim();
    finishStep(step, good ? 'выполнение завершено' : 'ошибка');
    if (running.stopReason || running.storageFailed) return 'stop';
    if (!good) return stop(attempt, `Шаг «${node.name}» не дал ответа. Проверьте диагностику CLI.`, changed);
    return 'success';
  }

  async function runMember(attempt, node, member, running, changed) {
    const step = addStep(attempt, node, { memberId: member.id, name: member.name, nodeName: node.name, blocking: member.blocking, blockAt: member.blockAt, ...roleOf(member), ...logs(),
      snapshot: attempt.graphRun.fingerprint, validity: 'не проверена', scope: 'Весь текущий checkout, включая существовавшие до запуска изменения', outcome: 'unclear' });
    event(attempt, `Роль «${member.name}»: ${adapters[member.agent].name}, отдельная сессия, только чтение.`); changed();
    try {
      const result = await agentProcess(attempt, step, roleOf(member), { prompt: memberPrompt(member, attempt), readOnly: true, schemaPath: reviewSchemaPath }, running, changed);
      if (!result || running.stopReason) { finishStep(step, 'прервано'); return step; }
      if (result.spawnError || result.code !== 0 || !['выполнение завершено', 'требуется решение'].includes(result.status)) throw new RequestError('Ревьюер не завершил корректный ответ. Проверьте диагностику CLI.', 400);
      if (result.answer.outputTruncated) throw new RequestError('Ответ ревьюера превысил лимит', 400);
      step.result = parseReview(result.answer.output);
      if (result.denials.length) step.result.limitations.push(`CLI отклонил действия ревьюера: ${result.denials.map(denial => `${denial.tool} ${denial.detail}`.trim()).join('; ')}`.slice(0, 2000));
      step.outcome = memberOutcome(member, step.result);
      finishStep(step, { pass: 'пройдено', changes_requested: step.outcome === 'failure' ? 'есть замечания' : 'замечания ниже порога', inconclusive: 'неполное' }[step.result.verdict]);
    } catch (error) {
      step.reason = stageError(`Роль «${member.name}» не завершила ревью`, error).message; step.outcome = member.blocking ? 'unclear' : 'advisory';
      finishStep(step, 'ошибка');
    }
    event(attempt, `Роль «${member.name}»: ${step.status}.`); changed();
    return step;
  }

  async function runReview(attempt, node, running, changed) {
    attempt.status = 'ревью'; attempt.review = 'выполняется'; changed();
    const steps = await Promise.all(node.members.map(member => runMember(attempt, node, member, running, changed)));
    if (running.stopReason || running.storageFailed) { attempt.review = 'прервано'; return 'stop'; }
    let current;
    try { current = await inspect(attempt.directory); }
    catch (error) { attempt.review = 'непроверено'; return stop(attempt, stageError('Не удалось проверить актуальность ревью', error).message, changed); }
    for (const step of steps) {
      step.validity = current.fingerprint === step.snapshot ? 'совпадает' : 'устарели'; step.validityCheckedAt = new Date().toISOString();
      if (step.validity === 'устарели') { step.status = 'устарело'; step.reason = 'Файлы изменились во время ревью'; if (step.blocking) step.outcome = 'unclear'; }
    }
    attempt.review = reviewSummary(attempt); changed();
    return reviewOutcome(steps);
  }

  async function runChecksNode(attempt, node, running, changed) {
    const step = addStep(attempt, node);
    attempt.automation.currentFix = attempt.graphRun.visits[node.id] - 1;
    await runChecks(attempt, attempt.checkDefinitions, attempt.graphRun.fingerprint, running, changed);
    const run = attempt.checkRuns.at(-1);
    step.checkRunId = run?.id; finishStep(step, run?.status || attempt.checks);
    if (running.stopReason || running.storageFailed) return 'stop';
    if (run?.validity !== 'совпадает') return 'unclear';
    if (run.status === 'пройдены') return 'success';
    return run.status === 'есть ошибки' && run.results.every(r => ['пройдена', 'ошибка'].includes(r.status) && Number.isInteger(r.exitCode)) ? 'failure' : 'unclear';
  }

  function waitForHuman(attempt, node, changed) {
    const step = addStep(attempt, node, { instructions: node.instructions });
    step.status = 'ждёт решения';
    attempt.graphRun.waiting = { nodeId: node.id, stepId: step.id, remainingMs: Math.max(1000, Date.parse(attempt.automation.deadlineAt) - Date.now()) };
    return stop(attempt, `Шаг «${node.name}» ждёт решения пользователя.`, changed, 'ждёт решения');
  }

  async function finish(attempt, changed) {
    let current;
    try { current = await inspect(attempt.directory); }
    catch (error) { return stop(attempt, stageError('Не удалось проверить актуальность результата', error).message, changed); }
    applyFreshness(attempt, current);
    attempt.review = reviewSummary(attempt);
    const ready = readiness(attempt);
    return stop(attempt, ready.reason, changed, ready.status);
  }

  async function guardRevisit(attempt, node, changed) {
    const state = attempt.graphRun;
    if (state.visits[node.id] > attempt.workflow.graph.limits.maxLoops) return stop(attempt, `Шаг «${node.name}»: достигнут лимит повторов.`, changed);
    if (attempt.automation.stopAfterPass) return stop(attempt, 'Автоматическое продолжение остановлено по запросу пользователя.', changed);
    if (configChanged(attempt)) return stop(attempt, 'Настройки задачи, профиля или проверок изменились; требуется новый запуск.', changed);
    const current = await inspect(attempt.directory);
    if (current.fingerprint !== state.fingerprint) return stop(attempt, 'Файлы изменились между шагами; требуется решение пользователя.', changed);
    return null;
  }

  async function run(attempt, running, changed) {
    const state = attempt.graphRun, nodes = new Map(attempt.workflow.graph.nodes.map(node => [node.id, node]));
    const runners = { executor: runWriter, write: runWriter, read: runRead, review: runReview, checks: runChecksNode };
    while (true) {
      if (isShuttingDown()) running.stopReason = 'остановка сервера';
      if (running.stopReason || running.storageFailed) return;
      if (state.cursor === 'end') { await finish(attempt, changed); return; }
      const node = nodes.get(state.cursor);
      if (state.visits[node.id] && await guardRevisit(attempt, node, changed)) return;
      if (running.stopReason || running.storageFailed) return;
      state.visits[node.id] = (state.visits[node.id] || 0) + 1;
      if (node.kind === 'human') { waitForHuman(attempt, node, changed); return; }
      const outcome = await runners[node.kind](attempt, node, running, changed);
      if (outcome === 'stop') return;
      const target = outcome === 'success' ? node.next.success ?? 'end' : outcome === 'failure' ? node.next.failure : undefined;
      if (!target) { stop(attempt, outcome === 'unclear' ? `Шаг «${node.name}» не дал надёжного результата; требуется решение пользователя.` : `Шаг «${node.name}» нашёл проблемы; переход для них не задан, требуется решение пользователя.`, changed); return; }
      // Every problem set seen on the way to a fix counts, so that alternating findings stop as well as repeated ones.
      if (outcome === 'failure' && isWriter(nodes.get(target))) {
        const signature = issueSignature(attempt);
        if (state.issues.includes(signature)) { stop(attempt, 'После исправления снова возникли те же замечания или ошибки проверок.', changed); return; }
        state.issues.push(signature);
      }
      state.cursor = target; state.entry = outcome;
      try { await save(attempt); }
      catch (error) { markUnhealthy(running); throw stageError('Не удалось сохранить состояние перед следующим шагом', error); }
    }
  }
  return { run };
}
