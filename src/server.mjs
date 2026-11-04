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
import { createAttempts, activeStatuses } from './attempts.mjs';
import { createSnapshots } from './snapshots.mjs';
import { RequestError } from './errors.mjs';
import { validateChecks } from './checks.mjs';
import { validateWorkflow } from './workflows.mjs';
import { validatePreset, validatePresetChecks, projectWorkflow, migratePresets } from './presets.mjs';
import { validateAgent } from './agents.mjs';
import { environmentSecrets } from './output.mjs';

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
const needsPresetMigration = state.projects.some(project => 'presets' in project);
if (needsPresetMigration) await copyFile(dataFile, resolve(dataDir, 'state.before-global-presets.json'), constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
migratePresets(state);
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
if (needsPresetMigration) await mutate(() => {});
if ((state.attempts || []).some(a => activeStatuses.includes(a.status))) {
  await mutate(next => {
    for (const attempt of next.attempts) if (activeStatuses.includes(attempt.status)) {
      if (attempt.status === 'проверка') attempt.checks = 'прерваны';
      if (attempt.status === 'ревью') { attempt.review = 'прервано'; if (attempt.reviewRun) { attempt.reviewRun.status = 'прервано'; attempt.reviewRun.validity = 'не проверена'; } }
      if (attempt.automation) { attempt.automation.stopAfterPass = true; attempt.automation.reason = 'Сервер перезапущен. Автоматический процесс прерван и сам не возобновляется.'; }
      attempt.status = 'прервана'; attempt.endedAt = new Date().toISOString();
      for (const step of attempt.graphRun?.steps || []) if (step.status === 'выполняется') { step.status = 'прервано'; step.endedAt = attempt.endedAt; if (step.kind === 'review') { step.validity = 'не проверена'; step.outcome = 'unclear'; } }
      for (const run of attempt.checkRuns || []) if (run.status === 'выполняются') {
        run.status = 'прерваны'; run.validity = 'не проверена'; run.endedAt = attempt.endedAt;
        for (const result of run.results) if (result.status === 'выполнение') result.status = 'прервана';
        attempt.checks = 'прерваны';
      }
      attempt.events.push({ at: attempt.endedAt, message: 'Сервер перезапущен. Завершение старого процесса не подтверждено; проверьте его вручную перед новым запуском.' });
      const task = next.tasks.find(t => t.id === attempt.taskId); if (task) task.status = attempt.status;
    }
  });
}
// An abrupt server death may leave a CLI running. Acknowledge this explicitly
// before allowing another writer, rather than pretending the process was killed.
let recoveryRequired = (state.attempts || []).some(a => a.status === 'прервана' && !a.recoveryAcknowledged && a.events?.some(e => e.message.startsWith('Сервер перезапущен.')));
const snapshots = createSnapshots(resolve(dataDir, 'snapshots'));
const attempts = createAttempts({ getState: () => state, mutate, snapshots,
  checksEnvironment: () => profileEnvironment('subscription', state.profiles.variables).environment,
  environmentFor: async (profile, agent = 'claude') => {
  if (agent === 'codex') {
    const environment = profileEnvironment('subscription', state.profiles.variables).environment;
    return { environment, secrets: environmentSecrets(environment) };
  }
  let secret = null;
  if (!['subscription', 'litellm', 'deepseek'].includes(profile)) throw new RequestError('У задачи не выбран поддерживаемый профиль Claude. Создайте задачу с выбранным профилем.', 400);
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
async function body(req) {
  let chunks = ''; for await (const chunk of req) { chunks += chunk; if (chunks.length > 50000) throw new Error('Request too large'); }
  return JSON.parse(chunks);
}
const html = await readFile(resolve(root, 'src/index.html'));
const server = createServer(async (req, res) => {
  const host = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== host) return send(res, 403, { error: 'Invalid host' });
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
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
    const { attempts: history, ...publicState } = state;
    const statuses = attempts.statuses();
    return send(res, 200, { ...publicState, tasks: state.tasks.map(t => ({ ...t, status: statuses[t.id] || t.status })), recoveryRequired, profileTemplate: defaultProfiles, deepTemplate: deepDefaults, token });
  }
  if (req.method !== 'POST' || !['/api/projects', '/api/project-checks', '/api/preset', '/api/project-preset-checks', '/api/project-default', '/api/preset-delete', '/api/project-delete', '/api/task-delete', '/api/tasks', '/api/task-workspace', '/api/attempt-prepare', '/api/attempt-start', '/api/attempt-stop', '/api/attempt-hold', '/api/attempt-decide', '/api/attempts', '/api/attempt-diff', '/api/checks-prepare', '/api/checks-start', '/api/checks-refresh', '/api/recovery-acknowledge', '/api/profiles', '/api/profile-check', '/api/litellm-settings', '/api/litellm-key', '/api/deepseek-settings', '/api/deepseek-key'].includes(req.url)) return send(res, 404, { error: 'Not found' });
  const provided = Buffer.from(req.headers['x-task-token'] || '');
  const expected = Buffer.from(token);
  if (req.headers.origin !== `http://${host}` || provided.length !== expected.length || !timingSafeEqual(provided, expected) || !req.headers['content-type']?.startsWith('application/json')) return send(res, 403, { error: 'Forbidden' });
  try {
    const input = await body(req);
    if (req.url === '/api/preset') {
      try {
        const result = await mutate(next => {
          const definition = validatePreset(input.preset);
          const index = next.presets.findIndex(p => p.id === input.presetId);
          if (input.presetId && index < 0) throw new RequestError('Процесс не найден', 404);
          const preset = { ...definition, id: input.presetId || randomUUID(), updatedAt: new Date().toISOString() };
          if (index < 0) next.presets.push(preset); else next.presets[index] = preset;
          return preset;
        });
        return send(res, 200, result);
      } catch (error) { return send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить процесс' }); }
    }
    if (req.url === '/api/project-default' || req.url === '/api/project-preset-checks') {
      try {
        const result = await mutate(next => {
          const project = next.projects.find(p => p.id === input.projectId);
          if (!project) throw new RequestError('Проект не найден', 404);
          const preset = next.presets.find(p => p.id === input.presetId);
          if (req.url === '/api/project-default') {
            if (input.presetId !== '' && !preset) throw new RequestError('Процесс не найден', 404);
            project.defaultPresetId = input.presetId;
            return project;
          }
          if (!preset) throw new RequestError('Процесс не найден', 404);
          const checkIds = validatePresetChecks(preset, project, input.checkIds);
          project.presetChecks ??= {};
          if (checkIds === null) delete project.presetChecks[preset.id]; else project.presetChecks[preset.id] = checkIds;
          return project;
        });
        return send(res, 200, result);
      } catch (error) { return send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить настройки проекта' }); }
    }
    // Deleting removes only the application's records: repository files are never touched.
    if (['/api/preset-delete', '/api/project-delete', '/api/task-delete'].includes(req.url)) {
      try {
        // An unacknowledged interruption is the only reminder that an old CLI may still be running.
        if (recoveryRequired && req.url !== '/api/preset-delete') throw new RequestError('Сначала проверьте остановку старых процессов и подтвердите это в интерфейсе', 409);
        const removedTaskIds = [];
        await mutate(next => {
          if (req.url === '/api/preset-delete') {
            if (!next.presets.some(p => p.id === input.presetId)) throw new RequestError('Процесс не найден', 404);
            next.presets = next.presets.filter(p => p.id !== input.presetId);
            for (const project of next.projects) {
              if (project.defaultPresetId === input.presetId) project.defaultPresetId = '';
              if (project.presetChecks) delete project.presetChecks[input.presetId];
            }
            return;
          }
          if (req.url === '/api/project-delete' ? !next.projects.some(p => p.id === input.projectId) : !next.tasks.some(t => t.id === input.taskId)) throw new RequestError(req.url === '/api/project-delete' ? 'Проект не найден' : 'Задача не найдена', 404);
          const ids = next.tasks.filter(t => req.url === '/api/project-delete' ? t.projectId === input.projectId : t.id === input.taskId).map(t => t.id);
          if (attempts.holds(ids)) throw new RequestError('Сначала дождитесь завершения запуска или остановите его', 409);
          next.tasks = next.tasks.filter(t => !ids.includes(t.id));
          next.attempts = (next.attempts || []).filter(a => !ids.includes(a.taskId));
          if (req.url === '/api/project-delete') next.projects = next.projects.filter(p => p.id !== input.projectId);
          removedTaskIds.push(...ids);
        });
        attempts.forget(removedTaskIds);
        // Snapshots hold copies of file contents, so a leftover must be reported rather than hidden.
        try { await snapshots.remove(removedTaskIds); }
        catch { return send(res, 500, { error: `Записи удалены, но не удалось удалить копии файлов снимков в ${resolve(dataDir, 'snapshots')}. Удалите их вручную.` }); }
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
    if (req.url === '/api/recovery-acknowledge') {
      if (input.confirmed !== true) return send(res, 400, { error: 'Подтвердите, что старые процессы остановлены' });
      await mutate(next => { for (const attempt of next.attempts || []) if (attempt.status === 'прервана') attempt.recoveryAcknowledged = true; });
      recoveryRequired = false; return send(res, 200, { ok: true });
    }
    if (['/api/attempt-prepare', '/api/attempt-start', '/api/attempt-stop', '/api/attempt-hold', '/api/attempt-decide', '/api/attempts', '/api/attempt-diff', '/api/checks-prepare', '/api/checks-start', '/api/checks-refresh'].includes(req.url)) {
      try {
        if (recoveryRequired && ['/api/attempt-prepare', '/api/attempt-start', '/api/attempt-decide', '/api/checks-prepare', '/api/checks-start'].includes(req.url)) return send(res, 409, { error: 'После перезапуска проверьте остановку старых процессов и подтвердите это в интерфейсе' });
        if (req.url === '/api/checks-prepare') return send(res, 200, await attempts.prepareChecks(input.taskId, input.attemptId));
        if (req.url === '/api/checks-start') return send(res, 201, await attempts.startChecks(input.taskId, input.previewId, input.confirmed));
        if (req.url === '/api/checks-refresh') return send(res, 200, await attempts.refreshChecks(input.taskId, input.attemptId));
        if (req.url === '/api/attempts') return send(res, 200, attempts.list(input.taskId));
        if (req.url === '/api/attempt-diff') return send(res, 200, await attempts.diff(input.taskId, input.attemptId, input.scope, input.stepId));
        if (req.url === '/api/attempt-decide') return send(res, 201, await attempts.decide(input.taskId, input.attemptId, input.approved, input.comment));
        if (req.url === '/api/attempt-prepare') return send(res, 200, await attempts.prepare(input.taskId, input.message, input.allowDenied));
        if (req.url === '/api/attempt-hold') return send(res, 200, await attempts.hold(input.taskId));
        if (req.url === '/api/attempt-stop') return send(res, 202, await attempts.cancel(input.taskId));
        return send(res, 201, await attempts.start(input.taskId, input.previewId, input.confirmed));
      } catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Не удалось подготовить или запустить агента. Проверьте Git, настройки профиля и доступ к хранилищу ключей.' }); }
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
    const project = state.projects.find(p => p.id === input.projectId);
    let preset;
    if (input.presetId) {
      preset = state.presets.find(p => p.id === input.presetId);
      if (!preset || !project) return send(res, 400, { error: 'Выбранный процесс недоступен' });
      try { input.workflow = projectWorkflow(preset, project); }
      catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Не удалось настроить процесс задачи' }); }
      input.profile = preset.profile; input.agent = preset.agent || 'claude'; input.model = preset.model || '';
    }
    if (typeof input.description === 'string' && !input.title) input.title = input.description.trim().split(/\r?\n/)[0].slice(0, 100);
    if (input.criteria === undefined || input.criteria === '') input.criteria = 'Соответствие описанию задачи. Неподтверждённые требования указать в ответе.';
    if (!text(input.title, 200) || !text(input.description) || !text(input.criteria) || !project) return send(res, 400, { error: 'Заполните проект и описание задачи' });
    let executor;
    try { executor = validateAgent(input.agent, input.profile, input.model); }
    catch (error) { return send(res, 400, { error: error.message }); }
    let workflow;
    try { workflow = validateWorkflow(input.workflow, state.projects.find(p => p.id === input.projectId)); }
    catch (error) { return send(res, error.status || 400, { error: error.status ? error.message : 'Не удалось настроить процесс задачи' }); }
    const task = await mutate(next => { const item = { id: randomUUID(), projectId: input.projectId, ...executor, ...(preset ? { preset: structuredClone(preset) } : {}), ...(workflow ? { workflow } : {}), title: input.title.trim(), description: input.description.trim(), criteria: input.criteria.trim(), status: 'создана', createdAt: new Date().toISOString() }; next.tasks.push(item); return item; });
    return send(res, 201, task);
  } catch { return send(res, 400, { error: 'Не удалось обработать или сохранить запрос' }); }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Откройте http://127.0.0.1:${server.address().port}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return; closing = true;
  void attempts.shutdown().then(() => { server.close(() => process.exit(0)); server.closeIdleConnections(); }).catch(() => {
    console.error('Остановка процессов не подтверждена. Проверьте активные процессы Claude вручную.');
    closing = false;
  });
});
