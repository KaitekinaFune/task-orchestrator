import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Only Git stays on PATH, so these tests can never call a real model: a new task must fail to find the CLI, visibly.
const gitDirectory = dirname(execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]);
async function startServer(dir) {
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PATH: gitDirectory, Path: gitDirectory, TASK_ORCHESTRATOR_DATA: dir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('http://127.0.0.1:')) break; }
  const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const read = async () => (await fetch(`${base}/api/state`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Task-Token': (await read()).token, Origin: base };
  const post = (endpoint, value, extra = {}) => fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  const stop = async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); };
  return { base, read, post, stop };
}
const settled = async (post, taskId) => {
  for (let i = 0; i < 400; i++) { const run = await (await post('run', { taskId })).json(); if (run && !run.active && !run.queued) return run; await delay(25); }
  throw new Error('Run did not settle');
};

test('a new task starts at once; a missing CLI ends it with a visible reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-test-'));
  const { read, post, stop } = await startServer(dir);
  try {
    const project = await (await post('projects', { path: resolve('.') })).json();
    assert.equal((await post('tasks', { projectId: 'missing', description: 'x' })).status, 400);
    assert.equal((await post('tasks', { projectId: project.id, description: '  ' })).status, 400);
    const task = await (await post('tasks', { projectId: project.id, description: 'Первая строка\nподробности' })).json();
    assert.equal(task.title, 'Первая строка');
    const run = await settled(post, task.id);
    assert.equal(run.status, 'ошибка'); assert.match(run.error, /Не удалось запустить CLI супервизора/);
    assert.ok(run.baseline.fingerprint); assert.ok(run.baseline.snapshot.tree, 'the state before the run is kept');
    assert.equal((await read()).tasks[0].status, 'ошибка');
    // A failed start stays continuable, and a second start is refused.
    assert.equal((await post('run-start', { taskId: task.id })).status, 409);
    assert.equal((await post('run-message', { taskId: task.id, message: 'Ещё раз' })).status, 201);
    const again = await settled(post, task.id);
    assert.deepEqual(again.journal.filter(entry => entry.kind === 'user').map(entry => entry.text), ['Первая строка\nподробности', 'Ещё раз']);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test('every changing route rejects other origins and missing tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-test-'));
  const { base, post, stop } = await startServer(dir);
  try {
    for (const endpoint of ['tasks', 'run', 'run-start', 'run-message', 'run-stop', 'run-diff', 'run-worker', 'settings', 'projects', 'project-checks', 'task-delete', 'project-delete', 'recovery-acknowledge']) {
      assert.equal((await post(endpoint, {}, { Origin: 'https://example.com' })).status, 403, endpoint);
      assert.equal((await post(endpoint, {}, { 'X-Task-Token': 'wrong' })).status, 403, endpoint);
    }
    assert.equal((await post('attempt-start', {})).status, 404, 'old routes are gone');
    assert.equal((await post('preset', {})).status, 404);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Host: 'evil.example' } })).status, 200, 'fetch sets its own Host');
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test('the team is one setting, validated and persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-test-'));
  let server = await startServer(dir);
  try {
    let state = await server.read();
    assert.equal(state.settings.supervisor.id, 'claude-subscription');
    assert.deepEqual(state.agentOptions.map(option => option.id), ['claude-subscription', 'claude-litellm', 'claude-deepseek', 'codex']);
    assert.equal((await server.post('settings', { supervisor: { id: 'evil' }, workers: [{ id: 'codex' }] })).status, 400);
    assert.equal((await server.post('settings', { supervisor: { id: 'codex' }, workers: [{ id: 'codex', model: 'gpt-5', note: 'ревью' }] })).status, 200);
    await server.stop();
    server = await startServer(dir);
    state = await server.read();
    assert.equal(state.settings.supervisor.id, 'codex'); assert.equal(state.settings.workers[0].note, 'ревью');
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('deleting removes records, journals and snapshots but not repository files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-delete-'));
  const { read, post, stop } = await startServer(dir);
  try {
    const project = await (await post('projects', { path: resolve('.') })).json();
    const first = await (await post('tasks', { projectId: project.id, description: 'a' })).json(), second = await (await post('tasks', { projectId: project.id, description: 'b' })).json();
    await settled(post, first.id); await settled(post, second.id);
    await stat(join(dir, 'runs', `${first.id}.json`));
    assert.equal((await post('task-delete', { taskId: 'missing' })).status, 404);
    assert.equal((await post('task-delete', { taskId: first.id })).status, 200);
    await assert.rejects(stat(join(dir, 'runs', `${first.id}.json`)), { code: 'ENOENT' });
    await assert.rejects(stat(join(dir, 'snapshots', first.id)), { code: 'ENOENT' });
    assert.equal((await post('run', { taskId: first.id })).status, 404);
    await stat(join(dir, 'runs', `${second.id}.json`));
    const removed = await post('project-delete', { projectId: project.id });
    assert.equal((await removed.json()).removedTasks, 1);
    const state = await read(); assert.deepEqual(state.projects, []); assert.deepEqual(state.tasks, []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).tasks, []);
    await stat(resolve('package.json'));
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test('data of the mode-based version is copied aside, and its tasks can start anew', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-migrate-'));
  const old = { projects: [{ id: 'p', path: resolve('.'), checks: [], defaultPresetId: 'x', presetChecks: {} }], presets: [{ id: 'x', name: 'P' }], attempts: [{ id: 'a', taskId: 't', status: 'выполнение завершено' }],
    tasks: [{ id: 't', projectId: 'p', title: 'Старая', description: 'Старое описание', criteria: 'c', profile: 'subscription', workflow: { mode: 'quick' }, preset: {}, status: 'выполнение завершено', createdAt: '2026-11-01T00:00:00.000Z' }, { id: 'u', projectId: 'p', title: 'Без запусков', description: 'd', status: 'создана', createdAt: '2026-11-01T00:00:00.000Z' }] };
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'state.json'), JSON.stringify(old));
  const { read, post, stop } = await startServer(dir);
  try {
    const state = await read();
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.before-supervisor.json'), 'utf8')), old);
    assert.equal(state.attempts, undefined); assert.equal(state.presets, undefined); assert.equal(state.projects[0].defaultPresetId, undefined);
    assert.deepEqual(state.tasks[0], { id: 't', projectId: 'p', title: 'Старая', description: 'Старое описание', createdAt: '2026-11-01T00:00:00.000Z', status: 'создана', legacy: true });
    assert.equal(state.tasks[1].legacy, undefined);
    assert.equal(await (await post('run', { taskId: 't' })).json(), null);
    assert.equal((await post('run-start', { taskId: 't' })).status, 201);
    assert.equal((await settled(post, 't')).status, 'ошибка');
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test('a server killed during a run marks it interrupted and asks for confirmation before new work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-restart-'));
  const running = { id: 'r', taskId: 't', directory: resolve('.'), status: 'выполнение', baseline: { fingerprint: 'x', clean: true, changes: [] }, current: { fingerprint: 'x' }, journal: [{ kind: 'user', text: 'a' }], workers: [{ id: 'w1', status: 'выполняется', output: '', access: 'write' }], checkRuns: [{ id: 'c1', status: 'выполняются', results: [] }], grants: [], counters: { turns: 1, workerStarts: 1 } };
  await mkdir(join(dir, 'runs'), { recursive: true });
  await writeFile(join(dir, 'runs', 't.json'), JSON.stringify(running));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ projects: [{ id: 'p', path: resolve('.'), checks: [] }], tasks: [{ id: 't', projectId: 'p', title: 'T', description: 'd', status: 'создана', createdAt: 'x' }] }));
  const first = await startServer(dir);
  try {
    const run = await (await first.post('run', { taskId: 't' })).json();
    assert.equal(run.status, 'прервана'); assert.equal(run.workers[0].status, 'прервано'); assert.equal(run.checkRuns[0].status, 'прерваны');
    assert.equal((await first.read()).recoveryRequired, true);
    assert.equal((await first.post('run-message', { taskId: 't', message: 'x' })).status, 409);
    assert.equal((await first.post('task-delete', { taskId: 't' })).status, 409);
    assert.equal((await first.post('recovery-acknowledge', {})).status, 400);
    assert.equal((await first.post('recovery-acknowledge', { confirmed: true })).status, 200);
    assert.equal((await first.read()).recoveryRequired, false);
    assert.equal((await first.post('run-message', { taskId: 't', message: 'Продолжай' })).status, 201);
    await settled(first.post, 't');
  } finally { await first.stop(); }
  const second = await startServer(dir);
  try { assert.equal((await second.read()).recoveryRequired, false, 'an acknowledged interruption does not come back'); }
  finally { await second.stop(); await rm(dir, { recursive: true, force: true }); }
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARQMCAQSnv6IAAAAASUVORK5CYII=';
test('a picture travels with a task or a message, is served safely and leaves with the task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-test-'));
  const { base, read, post, stop } = await startServer(dir);
  try {
    const project = await (await post('projects', { path: resolve('.') })).json();
    const refused = await post('tasks', { projectId: project.id, description: 'x', images: [{ data: Buffer.from('<svg/>').toString('base64') }] });
    assert.equal(refused.status, 400); assert.match((await refused.json()).error, /PNG, JPEG, GIF и WebP/);
    assert.equal((await read()).tasks.length, 0, 'a refused picture creates no task');
    const task = await (await post('tasks', { projectId: project.id, description: 'Посмотри снимок', images: [{ data: png }] })).json();
    assert.equal(task.images.length, 1); assert.equal(task.images[0].type, 'image/png');
    assert.ok(!JSON.stringify(await read()).includes(png), 'the state does not carry image bytes');

    const served = await fetch(`${base}/images/${task.id}/${task.images[0].id}`);
    assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(served.headers.get('access-control-allow-origin'), null);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), png);
    assert.equal((await fetch(`${base}/images/${task.id}/00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await fetch(`${base}/images/00000000-0000-4000-8000-000000000000/${task.images[0].id}`)).status, 404);
    assert.equal((await fetch(`${base}/images/${task.id}/..%2F..%2Fstate.json`)).status, 404);

    const run = await settled(post, task.id);
    assert.equal(run.images.length, 1); assert.deepEqual(run.journal[0].images, [task.images[0].id]);
    const added = await post('run-message', { taskId: task.id, message: 'И ещё один', images: [{ data: png }] });
    assert.equal(added.status, 201);
    const next = await settled(post, task.id);
    assert.equal(next.images.length, 2);
    assert.equal((await fetch(`${base}/images/${task.id}/${next.images[1].id}`)).status, 200);
    assert.equal((await post('run-message', { taskId: task.id, message: 'Много', images: Array(6).fill({ data: png }) })).status, 400);

    const tooLarge = await post('settings', { padding: 'x'.repeat(60000) });
    assert.equal(tooLarge.status, 413, 'only routes that carry pictures accept a large body');

    assert.equal((await post('task-delete', { taskId: task.id })).status, 200);
    await assert.rejects(stat(join(dir, 'images', task.id)), { code: 'ENOENT' });
    assert.equal((await fetch(`${base}/images/${task.id}/${next.images[1].id}`)).status, 404);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
