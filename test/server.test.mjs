import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { deepDefaults } from '../src/profiles.mjs';

test('deleting removes records only, cascades from a project and rejects cross-origin requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-delete-'));
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, TASK_ORCHESTRATOR_DATA: dir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    for await (const chunk of child.stdout) { output += chunk; if (output.includes('http://127.0.0.1:')) break; }
    const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const read = async () => (await fetch(`${base}/api/state`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Task-Token': (await read()).token, Origin: base };
    const post = (endpoint, value, extra = {}) => fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    const project = await (await post('projects', { path: resolve('.') })).json();
    const taskInput = { projectId: project.id, profile: 'subscription', description: 'Описание', workflow: { mode: 'quick', checkIds: [] } };
    const first = await (await post('tasks', taskInput)).json(), second = await (await post('tasks', taskInput)).json();
    const preset = await (await post('preset', { preset: { name: 'P', profile: 'subscription', instructions: '', workflow: { mode: 'quick' } } })).json();
    assert.equal((await post('project-default', { projectId: project.id, presetId: preset.id })).status, 200);

    for (const endpoint of ['task-delete', 'preset-delete', 'project-delete', 'preset', 'project-preset-checks']) assert.equal((await post(endpoint, { taskId: first.id, projectId: project.id, presetId: preset.id }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post('task-delete', { taskId: 'missing' })).status, 404);
    assert.equal((await post('preset-delete', { presetId: 'missing' })).status, 404);

    // The diff route is reachable only through the same protection as other requests.
    assert.equal((await post('attempt-diff', { taskId: first.id, attemptId: 'missing', scope: 'attempt' }, { Origin: 'https://example.com' })).status, 403);
    const missing = await post('attempt-diff', { taskId: first.id, attemptId: 'missing', scope: 'attempt' });
    assert.equal(missing.status, 404); assert.match((await missing.json()).error, /Попытка не найдена/);

    await mkdir(join(dir, 'snapshots', first.id, 'objects'), { recursive: true });
    await mkdir(join(dir, 'snapshots', second.id, 'objects'), { recursive: true });
    assert.equal((await post('task-delete', { taskId: first.id })).status, 200);
    await assert.rejects(stat(join(dir, 'snapshots', first.id)), { code: 'ENOENT' });
    await stat(join(dir, 'snapshots', second.id));
    let state = await read(); assert.deepEqual(state.tasks.map(t => t.id), [second.id]);
    assert.equal((await post('attempts', { taskId: first.id })).status, 404);

    assert.equal((await post('preset-delete', { presetId: preset.id })).status, 200);
    state = await read(); assert.deepEqual(state.presets, []); assert.equal(state.projects[0].defaultPresetId, '');

    const removed = await post('project-delete', { projectId: project.id });
    assert.equal(removed.status, 200); assert.equal((await removed.json()).removedTasks, 1);
    state = await read(); assert.deepEqual(state.projects, []); assert.deepEqual(state.tasks, []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).tasks, []);
    await assert.rejects(stat(join(dir, 'snapshots', second.id)), { code: 'ENOENT' });
  } finally { child.kill(); await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); }
});

test('projects and tasks persist; cross-origin writes are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-test-'));
  let child;
  async function start() {
    child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, TASK_ORCHESTRATOR_DATA: dir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for await (const chunk of child.stdout) { output += chunk; if (output.includes('http://127.0.0.1:')) break; }
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); assert.ok(match, output); return match[0];
  }
  async function stop() { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  try {
    let base = await start();
    let state = await (await fetch(`${base}/api/state`)).json();
    const headers = { 'Content-Type': 'application/json', 'X-Task-Token': state.token, Origin: base };
    let response = await fetch(`${base}/api/projects`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ path: resolve('.') }) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ path: resolve('.') }) });
    assert.equal(response.status, 201); const project = await response.json();
    const checks = [{ id: 'node-tests', name: 'Тесты', executable: process.execPath, args: ['--test'], timeoutSeconds: 30 }];
    response = await fetch(`${base}/api/project-checks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, checks }) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).checks, checks);
    response = await fetch(`${base}/api/project-checks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, checks: [{ ...checks[0], args: 'unsafe shell text' }] }) });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/profiles`, { method: 'POST', headers, body: JSON.stringify({ variables: [{ target: 'ANTHROPIC_BASE_URL', source: 'TEST_LITELLM_URL' }] }) });
    assert.equal(response.status, 200);
    const settings = Object.fromEntries(['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].map(k => [k, k === 'ANTHROPIC_BASE_URL' ? 'https://example.test' : '']));
    response = await fetch(`${base}/api/litellm-settings`, { method: 'POST', headers, body: JSON.stringify({ settings: { ...settings, ANTHROPIC_AUTH_TOKEN: 'do-not-store' } }) });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/litellm-settings`, { method: 'POST', headers, body: JSON.stringify({ settings }) });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/deepseek-settings`, { method: 'POST', headers, body: JSON.stringify({ settings: deepDefaults }) });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, profile: 'deepseek', title: 'DeepSeek', description: 'Описание', criteria: 'Критерий' }) });
    assert.equal(response.status, 201);
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, profile: 'litellm', title: 'Тест', description: 'Описание', criteria: 'Критерий' }) });
    assert.equal(response.status, 201);
    const task = await response.json();
    response = await fetch(`${base}/api/task-workspace`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ taskId: task.id }) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/task-workspace`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ taskId: task.id }) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/task-workspace`, { method: 'POST', headers, body: JSON.stringify({ taskId: 'missing' }) });
    assert.equal(response.status, 404);
    response = await fetch(`${base}/api/task-workspace`, { method: 'POST', headers, body: JSON.stringify({ taskId: task.id }) });
    assert.equal(response.status, 200);
    const workspace = await response.json();
    assert.equal(resolve(workspace.path).toLowerCase(), resolve(project.path).toLowerCase());
    assert.equal(typeof workspace.clean, 'boolean'); assert.ok(Array.isArray(workspace.changes));
    for (const endpoint of ['attempt-prepare', 'attempt-start', 'attempt-stop', 'attempts', 'recovery-acknowledge', 'project-checks', 'checks-prepare', 'checks-start', 'checks-refresh']) {
      response = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ taskId: task.id, confirmed: true }) });
      assert.equal(response.status, 403);
    }
    response = await fetch(`${base}/api/attempt-prepare`, { method: 'POST', headers, body: JSON.stringify({ taskId: task.id }) });
    assert.equal(response.status, 200); const preview = await response.json();
    assert.equal(preview.profile, 'litellm'); assert.ok(preview.workspace.fingerprint); assert.ok(preview.previewId);
    assert.deepEqual(preview.checks, checks);
    response = await fetch(`${base}/api/attempt-start`, { method: 'POST', headers, body: JSON.stringify({ taskId: task.id, previewId: preview.previewId, confirmed: false }) });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/attempts`, { method: 'POST', headers, body: JSON.stringify({ taskId: task.id }) });
    assert.deepEqual(await response.json(), []);
    const taskInput = { projectId: project.id, profile: 'subscription', title: 'Quick fix', description: 'Исправить одну ошибку компиляции', criteria: 'Ошибка устранена' };
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...taskInput, workflow: { mode: 'review', checkIds: [] } }) });
    assert.equal(response.status, 400);
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...taskInput, workflow: { mode: 'quick', checkIds: [] } }) });
    assert.equal(response.status, 201); const quick = await response.json();
    response = await fetch(`${base}/api/attempt-prepare`, { method: 'POST', headers, body: JSON.stringify({ taskId: quick.id }) });
    assert.equal(response.status, 200); const quickPreview = await response.json();
    assert.equal(quickPreview.workflow.mode, 'quick'); assert.deepEqual(quickPreview.checks, []); assert.equal(quickPreview.review, 'не запрошено');
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...taskInput, workflow: { mode: 'checked', checkIds: ['node-tests'] } }) });
    assert.equal(response.status, 201); const checked = await response.json();
    response = await fetch(`${base}/api/attempt-prepare`, { method: 'POST', headers, body: JSON.stringify({ taskId: checked.id }) });
    assert.equal(response.status, 200); const checkedPreview = await response.json();
    assert.equal(checkedPreview.workflow.mode, 'checked'); assert.deepEqual(checkedPreview.checks, checks);
    const presetDefinition = { name: 'Small fix', profile: 'subscription', instructions: 'Keep the API compatible', workflow: { mode: 'checked' } };
    response = await fetch(`${base}/api/preset`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ preset: presetDefinition }) });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/api/preset`, { method: 'POST', headers, body: JSON.stringify({ preset: presetDefinition }) });
    assert.equal(response.status, 200); const preset = await response.json();
    response = await fetch(`${base}/api/project-default`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, presetId: preset.id }) }); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, presetId: preset.id, description: 'A task with no separate title or criteria' }) });
    assert.equal(response.status, 201); const presetTask = await response.json();
    assert.equal(presetTask.title, 'A task with no separate title or criteria'); assert.equal(presetTask.profile, 'subscription');
    assert.deepEqual(presetTask.workflow, { mode: 'checked', checkIds: ['node-tests'] }); assert.equal(presetTask.preset.instructions, presetDefinition.instructions);
    response = await fetch(`${base}/api/preset`, { method: 'POST', headers, body: JSON.stringify({ presetId: preset.id, preset: { ...presetDefinition, name: 'Updated preset', profile: 'deepseek' } }) }); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/preset`, { method: 'POST', headers, body: JSON.stringify({ preset: { ...presetDefinition, workflow: { mode: 'checked', checkIds: ['deleted'] } } }) }); assert.equal(response.status, 400);
    response = await fetch(`${base}/api/project-default`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, presetId: 'missing' }) }); assert.equal(response.status, 404);
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, presetId: 'missing', description: 'Do not silently fall back' }) }); assert.equal(response.status, 400);
    const reviewWorkflow = { mode: 'review', reviewer: { agent: 'codex', profile: 'default', model: 'review-model', instructions: 'Check errors' } };
    response = await fetch(`${base}/api/preset`, { method: 'POST', headers, body: JSON.stringify({ preset: { ...presetDefinition, agent: 'codex', profile: 'default', model: 'executor-model', workflow: reviewWorkflow } }) });
    assert.equal(response.status, 200); const codexPreset = await response.json();
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id, presetId: codexPreset.id, description: 'Codex task' }) });
    assert.equal(response.status, 201); const codexTask = await response.json();
    assert.equal(codexTask.agent, 'codex'); assert.equal(codexTask.model, 'executor-model'); assert.deepEqual(codexTask.workflow, { ...reviewWorkflow, checkIds: ['node-tests'] });
    response = await fetch(`${base}/api/attempt-prepare`, { method: 'POST', headers, body: JSON.stringify({ taskId: codexTask.id }) });
    assert.equal(response.status, 200); const codexPreview = await response.json();
    assert.ok(codexPreview.command.includes('workspace-write')); assert.ok(codexPreview.command.includes('executor-model'));
    assert.ok(codexPreview.reviewCommand.includes('read-only')); assert.ok(codexPreview.reviewCommand.includes('review-model'));
    response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...taskInput, agent: 'codex', profile: 'subscription' }) }); assert.equal(response.status, 400);
    // Simulate persisted state after abrupt termination, without leaving a real CLI running.
    await stop();
    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    persisted.attempts = [{ id: 'interrupted', taskId: task.id, status: 'выполнение', events: [] },
      { id: 'interrupted-checks', taskId: task.id, status: 'проверка', events: [], checkRuns: [{ status: 'выполняются', results: [{ status: 'выполнение' }, { status: 'не выполнена' }] }] }];
    await writeFile(join(dir, 'state.json'), JSON.stringify(persisted));
    base = await start();
    state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.projects[0].defaultPresetId, preset.id);
    assert.equal(state.presets[0].name, 'Updated preset');
    assert.equal(state.tasks.find(t => t.id === presetTask.id).preset.name, 'Small fix');
    assert.equal(state.tasks.find(t => t.id === presetTask.id).profile, 'subscription');
    assert.deepEqual(state.projects[0].checks, checks);
    assert.deepEqual(state.tasks.find(t => t.id === quick.id).workflow, { mode: 'quick', checkIds: [] });
    assert.deepEqual(state.tasks.find(t => t.id === checked.id).workflow, { mode: 'checked', checkIds: ['node-tests'] });
    assert.equal(state.recoveryRequired, true);
    const restartedHeaders = { ...headers, 'X-Task-Token': state.token, Origin: base };
    response = await fetch(`${base}/api/attempt-prepare`, { method: 'POST', headers: restartedHeaders, body: JSON.stringify({ taskId: task.id }) }); assert.equal(response.status, 409);
    response = await fetch(`${base}/api/attempts`, { method: 'POST', headers: restartedHeaders, body: JSON.stringify({ taskId: task.id }) });
    const recovered = await response.json();
    assert.equal(recovered[0].status, 'прервана'); assert.equal(recovered[1].checks, 'прерваны');
    assert.equal(recovered[1].checkRuns[0].results[0].status, 'прервана');
    assert.equal(recovered[1].checkRuns[0].results[1].status, 'не выполнена');
    response = await fetch(`${base}/api/recovery-acknowledge`, { method: 'POST', headers: restartedHeaders, body: JSON.stringify({ confirmed: true }) }); assert.equal(response.status, 200);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).recoveryRequired, false);
    assert.equal(state.projects.length, 1); assert.equal(state.tasks[0].profile, 'deepseek'); assert.equal(state.tasks[1].title, 'Тест'); assert.equal(state.tasks[1].profile, 'litellm'); assert.equal(state.profiles.variables[0].source, 'TEST_LITELLM_URL'); assert.equal(state.profiles.liteSettings.ANTHROPIC_BASE_URL, 'https://example.test'); assert.equal(state.profiles.deepSettings.ANTHROPIC_BASE_URL, deepDefaults.ANTHROPIC_BASE_URL); assert.equal(JSON.stringify(state).includes('do-not-store'), false);
  } finally { if (child) await stop(); await rm(dir, { recursive: true, force: true }); }
});
