import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultProfiles, validateVariables, profileEnvironment, liteFields, deepFields, deepDefaults } from './profiles.mjs';
import { credential, deepseekCredentialTarget } from './credentials.mjs';
import { inspectWorkspace } from './workspace.mjs';
import { activeStatuses, createRuns, createRunStore } from './runs.mjs';
import { agentOptions, defaultSettings, validateSettings } from './supervisor.mjs';
import { createSnapshots } from './snapshots.mjs';
import { validateChecks } from './checks.mjs';
import { RequestError } from './errors.mjs';
import { environmentSecrets } from './output.mjs';
import { createUsageLedger, summarizeUsage } from './usage.mjs';
import { createImageStore, decodeImages, imageRequestBytes } from './images.mjs';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = resolve(process.env.TASK_ORCHESTRATOR_DATA || resolve(root, '.data/app'));
const dataFile = resolve(dataDir, 'state.json');
const token = randomBytes(32).toString('hex');
let state = { projects: [], tasks: [] };
try {
  state = JSON.parse(await readFile(dataFile, 'utf8'));
  if (!Array.isArray(state.projects) || !Array.isArray(state.tasks)) throw new Error('Invalid state');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
state.profiles ??= structuredClone(defaultProfiles);
if (!validateVariables(state.profiles.variables)) throw new Error('Invalid profile configuration');
let writes = Promise.resolve();
async function mutate(change) {
  const operation = writes.then(async () => {
    const next = structuredClone(state);
    const result = change(next);
    await mkdir(dataDir, { recursive: true });
    const temp = resolve(dataDir, `state-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temp, dataFile);
    state = next;
    return result;
  });
  writes = operation.catch(() => {});
  return operation;
}
// Data of the earlier mode-based version stays readable in a copy; its tasks remain and can be started anew.
if ('attempts' in state || 'presets' in state) {
  await copyFile(dataFile, resolve(dataDir, 'state.before-supervisor.json'), constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await mutate(next => {
    const previous = new Set((next.attempts || []).map(attempt => attempt.taskId));
    delete next.attempts; delete next.presets;
    for (const project of next.projects) { delete project.defaultPresetId; delete project.presetChecks; }
    next.tasks = next.tasks.map(({ id, projectId, title, description, createdAt }) => ({ id, projectId, title, description, createdAt, status: 'создана', ...(previous.has(id) ? { legacy: true } : {}) }));
  });
}
state.settings ??= defaultSettings();
const store = createRunStore(resolve(dataDir, 'runs'));
await mkdir(resolve(dataDir, 'runs'), { recursive: true });
const saved = await store.load();
// An abrupt server death may leave a CLI running. Acknowledge this explicitly
// before allowing another writer, rather than pretending the process was killed.
let recoveryRequired = false;
for (const run of saved) if (activeStatuses.includes(run.status)) {
  const started = run.status !== 'в очереди';
  if (started) { recoveryRequired = true; run.recoveryPending = true; }
  run.endedAt = new Date().toISOString(); run.status = 'прервана'; run.phase = '';
  run.statusReason = started ? 'Сервер перезапущен во время работы. Завершение старого процесса не подтверждено; напишите сообщение, чтобы продолжить с журнала.' : 'Сервер перезапущен, пока задача ждала в очереди.';
  for (const worker of run.workers) if (worker.status === 'выполняется') { worker.status = 'прервано'; worker.endedAt = run.endedAt; }
  for (const check of run.checkRuns) if (check.status === 'выполняются') { check.status = 'прерваны'; check.endedAt = run.endedAt; }
  await store.save(run);
}
recoveryRequired ||= saved.some(run => run.recoveryPending);
const snapshots = createSnapshots(resolve(dataDir, 'snapshots'));
const usage = createUsageLedger(resolve(dataDir, 'usage.jsonl'));
const images = createImageStore(resolve(dataDir, 'images'));
const runs = createRuns({ getState: () => state, store, snapshots, usage, images, initial: saved,
  checksEnvironment: () => profileEnvironment('subscription', state.profiles.variables).environment,
  environmentFor: async (profile, agent = 'claude') => {
  if (agent === 'codex') {
    const environment = profileEnvironment('subscription', state.profiles.variables).environment;
    return { environment, secrets: environmentSecrets(environment) };
  }
  let secret = null;
  if (!['subscription', 'litellm', 'deepseek'].includes(profile)) throw new RequestError('Не выбран поддерживаемый профиль Claude.', 400);
  if (profile !== 'subscription') {
    try { secret = await credential('read', '', profile === 'deepseek' ? deepseekCredentialTarget : undefined); }
    catch { throw new RequestError(`Не удалось прочитать ключ профиля ${profile} из Windows Credential Manager. Проверьте доступ хранилища для пользователя, запустившего сервер.`, 400); }
  }
  const settings = state.profiles[profile === 'deepseek' ? 'deepSettings' : 'liteSettings'] || {};
  const { environment, missing } = profileEnvironment(profile, state.profiles.variables, process.env, settings, secret);
  if (missing.length) throw new RequestError(`В профиле ${profile} отсутствуют параметры: ${missing.join(', ')}. Заполните настройки профиля или окружение сервера.`, 400);
  if (profile !== 'subscription' && (!environment.ANTHROPIC_BASE_URL || !environment.ANTHROPIC_AUTH_TOKEN)) throw new RequestError(`В профиле ${profile} отсутствует URL или API-ключ. Сохраните URL и ключ в настройках профиля.`, 400);
  const secrets = Object.entries(environment).filter(([key, value]) => /TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|CUSTOM_HEADERS/i.test(key) && typeof value === 'string' && value).map(([, value]) => value);
  return { environment, secrets };
} });
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function text(value, max = 10000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
async function body(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new RequestError('Запрос слишком большой', 413); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const html = await readFile(resolve(root, 'src/index.html'));
const routes = ['/api/projects', '/api/project-checks', '/api/project-delete', '/api/task-delete', '/api/tasks', '/api/task-workspace', '/api/run', '/api/run-start', '/api/run-message', '/api/run-stop', '/api/run-diff', '/api/run-worker', '/api/usage', '/api/settings', '/api/recovery-acknowledge', '/api/profiles', '/api/profile-check', '/api/litellm-settings', '/api/litellm-key', '/api/deepseek-settings', '/api/deepseek-key'];
const server = createServer(async (req, res) => {
  const host = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== host) return send(res, 403, { error: 'Invalid host' });
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    return res.end(html);
  }
  if (req.method === 'GET' && req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await readFile(resolve(root, 'src/app.js')));
  }
  if (req.method === 'GET' && req.url === '/theme.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await readFile(resolve(root, 'src/theme.js')));
  }
  if (req.method === 'GET' && req.url === '/style.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await readFile(resolve(root, 'src/style.css')));
  }
  if (req.method === 'GET' && req.url === '/api/state') {
    const statuses = runs.statuses(), questions = runs.questions(), latest = runs.latest();
    return send(res, 200, { ...state, tasks: state.tasks.map(task => ({ ...task, status: statuses[task.id] || task.status, ...(questions[task.id] ? { question: questions[task.id] } : {}), ...(latest[task.id] ? { latest: latest[task.id] } : {}) })), agentOptions, recoveryRequired, profileTemplate: defaultProfiles, deepTemplate: deepDefaults, token });
  }
  const imageRoute = req.method === 'GET' && req.url.match(/^\/images\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i);
  if (imageRoute) {
    // No CORS and a same-origin resource policy: another site can neither read nor embed a picture of the user's work.
    try {
      const image = runs.imagesOf(imageRoute[1]).find(item => item.id === imageRoute[2]);
      if (!image) return send(res, 404, { error: 'Not found' });
      const bytes = await images.read(imageRoute[1], image);
      res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'" });
      return res.end(bytes);
    } catch { return send(res, 404, { error: 'Not found' }); }
  }
  if (req.method !== 'POST' || !routes.includes(req.url)) return send(res, 404, { error: 'Not found' });
  const provided = Buffer.from(req.headers['x-task-token'] || '');
  const expected = Buffer.from(token);
  if (req.headers.origin !== `http://${host}` || provided.length !== expected.length || !timingSafeEqual(provided, expected) || !req.headers['content-type']?.startsWith('application/json')) return send(res, 403, { error: 'Forbidden' });
  try {
    const input = await body(req, ['/api/tasks', '/api/run-message'].includes(req.url) ? imageRequestBytes : 50000);
    // Deleting removes only the application's records: repository files are never touched.
    if (['/api/project-delete', '/api/task-delete'].includes(req.url)) {
      try {
        // An unacknowledged interruption is the only reminder that an old CLI may still be running.
        if (recoveryRequired) throw new RequestError('Сначала проверьте остановку старых процессов и подтвердите это в интерфейсе', 409);
        const removedTaskIds = [];
        await mutate(next => {
          if (req.url === '/api/project-delete' ? !next.projects.some(p => p.id === input.projectId) : !next.tasks.some(t => t.id === input.taskId)) throw new RequestError(req.url === '/api/project-delete' ? 'Проект не найден' : 'Задача не найдена', 404);
          const ids = next.tasks.filter(t => req.url === '/api/project-delete' ? t.projectId === input.projectId : t.id === input.taskId).map(t => t.id);
          if (runs.holds(ids)) throw new RequestError('Сначала дождитесь завершения запуска или остановите его', 409);
          next.tasks = next.tasks.filter(t => !ids.includes(t.id));
          if (req.url === '/api/project-delete') next.projects = next.projects.filter(p => p.id !== input.projectId);
          removedTaskIds.push(...ids);
        });
        runs.forget(removedTaskIds);
        // Journals and snapshots hold copies of file contents, so a leftover must be reported rather than hidden.
        try { await store.remove(removedTaskIds); await snapshots.remove(removedTaskIds); await images.remove(removedTaskIds); }
        catch { return send(res, 500, { error: `Записи удалены, но не удалось удалить журналы, снимки или изображения в ${dataDir}. Удалите их вручную.` }); }
        return send(res, 200, { removedTasks: removedTaskIds.length });
      } catch (error) { return send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось удалить' }); }
    }
    if (req.url === '/api/project-checks') {
      try {
        if (!state.projects.some(p => p.id === input.projectId)) return send(res, 404, { error: 'Проект не найден' });
        const checks = validateChecks(input.checks);
        await mutate(next => { next.projects.find(p => p.id === input.projectId).checks = checks; });
        return send(res, 200, { checks });
      } catch (error) { return send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить команды проверок' }); }
    }
    if (req.url === '/api/settings') {
      try {
        const settings = validateSettings(input);
        await mutate(next => { next.settings = settings; });
        return send(res, 200, settings);
      } catch (error) { return send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить настройки' }); }
    }
    if (req.url === '/api/recovery-acknowledge') {
      if (input.confirmed !== true) return send(res, 400, { error: 'Подтвердите, что старые процессы остановлены' });
      await runs.acknowledgeRecovery();
      recoveryRequired = false; return send(res, 200, { ok: true });
    }
    if (req.url === '/api/usage') {
      const from = input?.from ?? null;
      if (from !== null && (typeof from !== 'string' || Number.isNaN(Date.parse(from)))) return send(res, 400, { error: 'Неверное начало периода' });
      try { return send(res, 200, { ...summarizeUsage(await usage.read(), { from, tasks: state.tasks }), writeFailed: usage.failed() }); }
      catch { return send(res, 500, { error: 'Не удалось прочитать журнал расхода.' }); }
    }
    if (['/api/run', '/api/run-start', '/api/run-message', '/api/run-stop', '/api/run-diff', '/api/run-worker'].includes(req.url)) {
      try {
        if (recoveryRequired && ['/api/run-start', '/api/run-message'].includes(req.url)) return send(res, 409, { error: 'После перезапуска проверьте остановку старых процессов и подтвердите это в интерфейсе' });
        if (req.url === '/api/run') return send(res, 200, runs.get(input.taskId));
        if (req.url === '/api/run-start') return send(res, 201, await runs.start(input.taskId));
        if (req.url === '/api/run-message') return send(res, 201, await runs.message(input.taskId, input.message, input.allowDenied === true, input.images));
        if (req.url === '/api/run-diff') return send(res, 200, await runs.diff(input.taskId, input.scope, input.workerId));
        if (req.url === '/api/run-worker') return send(res, 200, runs.worker(input.taskId, input.workerId));
        return send(res, 202, await runs.stop(input.taskId));
      } catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Не удалось выполнить действие. Проверьте Git, настройки профиля и доступ к хранилищу ключей.' }); }
    }
    if (req.url === '/api/task-workspace') {
      const task = state.tasks.find(t => t.id === input.taskId);
      const project = task && state.projects.find(p => p.id === task.projectId);
      if (!project) return send(res, 404, { error: 'Задача или проект не найдены' });
      try { return send(res, 200, await inspectWorkspace(project.path)); }
      catch { return send(res, 400, { error: 'Не удалось прочитать Git-состояние. Проверьте доступность репозитория и его корневую директорию.' }); }
    }
    if (req.url === '/api/litellm-settings' || req.url === '/api/deepseek-settings') {
      const isDeep = req.url === '/api/deepseek-settings'; const fields = isDeep ? deepFields : liteFields;
      if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings) || Object.keys(input.settings).some(k => !fields.includes(k)) || fields.some(k => typeof input.settings[k] !== 'string' || input.settings[k].length > 2048 || /[\r\n\0]/.test(input.settings[k]))) return send(res, 400, { error: 'Проверьте настройки профиля' });
      if (input.settings.ANTHROPIC_BASE_URL) {
        try { const url = new URL(input.settings.ANTHROPIC_BASE_URL); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
        catch { return send(res, 400, { error: 'Укажите URL без учётных данных и параметров' }); }
      }
      await mutate(next => { next.profiles[isDeep ? 'deepSettings' : 'liteSettings'] = Object.fromEntries(fields.map(k => [k, input.settings[k].trim()])); });
      return send(res, 200, { ok: true });
    }
    if (req.url === '/api/litellm-key' || req.url === '/api/deepseek-key') {
      if (!text(input.key, 1200) || /[\r\n\0]/.test(input.key)) return send(res, 400, { error: 'Укажите API-ключ' });
      try { await credential('write', input.key, req.url === '/api/deepseek-key' ? deepseekCredentialTarget : undefined); return send(res, 200, { ok: true }); }
      catch { return send(res, 500, { error: 'Не удалось сохранить ключ в Windows Credential Manager' }); }
    }
    if (req.url === '/api/profiles') {
      if (!validateVariables(input.variables)) return send(res, 400, { error: 'Укажите корректные и неповторяющиеся имена переменных' });
      await mutate(next => { next.profiles.variables = input.variables; });
      return send(res, 200, { ok: true });
    }
    if (req.url === '/api/profile-check') {
      if (input.agent === 'codex') {
        try {
          await exec(process.platform === 'win32' ? 'codex.exe' : 'codex', ['login', 'status'], { env: profileEnvironment('subscription', state.profiles.variables).environment, timeout: 10000, windowsHide: true });
          return send(res, 200, { loggedIn: true });
        } catch { return send(res, 200, { loggedIn: false, error: 'Codex CLI не подтвердил вход. Выполните codex login в своей оболочке.' }); }
      }
      if (!['subscription', 'litellm', 'deepseek'].includes(input.profile)) return send(res, 400, { error: 'Неизвестный профиль' });
      if (input.profile === 'deepseek') {
        try {
          const keySaved = await credential('exists', '', deepseekCredentialTarget);
          const settings = state.profiles.deepSettings || {};
          const { missing } = profileEnvironment('deepseek', state.profiles.variables, process.env, settings, keySaved ? '[present]' : null);
          return send(res, 200, { configured: !!state.profiles.deepSettings, missing, keySaved });
        } catch { return send(res, 500, { error: 'Не удалось проверить Windows Credential Manager' }); }
      }
      if (input.profile === 'litellm') {
        try {
          const keySaved = await credential('exists');
          const settings = state.profiles.liteSettings || {};
          const { missing } = profileEnvironment('litellm', state.profiles.variables, process.env, settings, keySaved ? '[present]' : null);
          return send(res, 200, { configured: state.profiles.variables.some(v => v.source), missing, keySaved });
        } catch { return send(res, 500, { error: 'Не удалось проверить Windows Credential Manager' }); }
      }
      const { environment } = profileEnvironment(input.profile, state.profiles.variables);
      try {
        const result = await exec(process.platform === 'win32' ? 'claude.exe' : 'claude', ['auth', 'status', '--json'], { env: environment, timeout: 10000, windowsHide: true });
        const status = JSON.parse(result.stdout);
        return send(res, 200, { loggedIn: status.loggedIn === true });
      } catch { return send(res, 200, { loggedIn: false, error: 'Не удалось подтвердить вход через Claude CLI' }); }
    }
    if (req.url === '/api/projects') {
      if (!text(input.path, 4096)) return send(res, 400, { error: 'Укажите путь к репозиторию' });
      let path;
      try { path = (await exec('git', ['-C', input.path, 'rev-parse', '--show-toplevel'], { timeout: 5000, windowsHide: true })).stdout.trim(); }
      catch { return send(res, 400, { error: 'Не удалось открыть Git-репозиторий' }); }
      const project = await mutate(next => {
        const existing = next.projects.find(item => item.path.toLowerCase() === path.toLowerCase());
        if (existing) return existing;
        const item = { id: randomUUID(), path }; next.projects.push(item); return item;
      });
      return send(res, 201, project);
    }
    // A new task starts at once: there is nothing to configure and nothing to confirm.
    const project = state.projects.find(p => p.id === input.projectId);
    if (!text(input.description) || !project) return send(res, 400, { error: 'Выберите проект и опишите задачу' });
    const title = input.description.trim().split(/\r?\n/)[0].slice(0, 100);
    const taskId = randomUUID(), decoded = decodeImages(input.images), attached = await images.save(taskId, decoded);
    let task;
    try { task = await mutate(next => { const item = { id: taskId, projectId: input.projectId, title, description: input.description.trim(), status: 'создана', createdAt: new Date().toISOString(), ...(attached.length ? { images: attached } : {}) }; next.tasks.push(item); return item; }); }
    catch (error) { await images.remove([taskId]).catch(() => {}); throw error; }
    if (recoveryRequired) return send(res, 201, task);
    try { await runs.start(task.id); return send(res, 201, task); }
    catch (error) { return send(res, 201, { ...task, startError: error.status ? error.message : 'Не удалось запустить задачу' }); }
  } catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Не удалось обработать или сохранить запрос' }); }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Откройте http://127.0.0.1:${server.address().port}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return; closing = true;
  void runs.shutdown().then(() => { server.close(() => process.exit(0)); server.closeIdleConnections(); }).catch(() => {
    console.error('Остановка процессов не подтверждена. Проверьте активные процессы агентов вручную.');
    closing = false;
  });
});
