// Explicit opt-in integration check. Only a disposable repository is sent to the models.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const dir = await mkdtemp(join(tmpdir(), 'taskroom-codex-smoke-'));
let server, base, headers, task;
async function post(endpoint, input) {
  const response = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(input) });
  const body = await response.json();
  assert.ok(response.ok, `${endpoint}: ${body.error || response.status}`); return body;
}
async function finished() {
  for (let i = 0; i < 720; i++) {
    const attempt = (await post('attempts', { taskId: task.id })).at(-1);
    if (attempt && !attempt.active && attempt.endedAt) return attempt;
    await delay(250);
  }
  throw new Error('Timed out waiting for Codex');
}
try {
  const repo = join(dir, 'repo'); await mkdir(repo);
  await promisify(execFile)('git', ['-C', repo, 'init', '--initial-branch=main'], { windowsHide: true });
  await writeFile(join(repo, 'add.mjs'), 'export function add(a, b) { return a - b; }\n');
  server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', TASK_ORCHESTRATOR_DATA: join(dir, 'state') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const startupTimeout = setTimeout(() => server.kill(), 15000);
  let output = '';
  for await (const chunk of server.stdout) { output += chunk; if (output.match(/http:\/\/127\.0\.0\.1:\d+/)) break; }
  clearTimeout(startupTimeout); base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; assert.ok(base);
  const state = await (await fetch(`${base}/api/state`)).json();
  headers = { 'Content-Type': 'application/json', Origin: base, 'X-Task-Token': state.token };
  const project = await post('projects', { path: repo });
  await post('project-checks', { projectId: project.id, checks: [{ id: 'sum', name: 'Addition', executable: process.execPath,
    args: ['--input-type=module', '-e', 'import {add} from "./add.mjs";if(add(2,3)!==5||add(-2,3)!==1)process.exit(7);console.log("SUM_OK")'], timeoutSeconds: 15 }] });
  task = await post('tasks', { projectId: project.id, agent: 'codex', profile: 'default',
    description: 'Fix add.mjs so add(a,b) returns the sum a+b for numeric inputs. Make the smallest change. Do not create other files. The orchestrator will run tests after you finish.',
    criteria: 'add(2,3) is 5 and add(-2,3) is 1. Only add.mjs is changed.',
    workflow: { mode: 'review', checkIds: ['sum'], reviewer: { agent: 'codex', model: '', instructions: 'Inspect add.mjs and the provided test results. Do not run tests yourself.' } } });
  let preview = await post('attempt-prepare', { taskId: task.id });
  assert.ok(preview.reviewCommand.includes('read-only')); assert.ok(preview.command.includes('workspace-write'));
  await post('attempt-start', { taskId: task.id, previewId: preview.previewId, confirmed: true });
  let attempt = await finished();
  assert.equal(attempt.agentStatus, 'выполнение завершено', `Executor: ${attempt.status}; ${attempt.error || ''}; ${attempt.diagnostics?.output || ''}`);
  assert.equal(attempt.checks, 'пройдены');
  assert.ok(['пройдено', 'есть замечания', 'неполное'].includes(attempt.reviewRun?.status), `Review: ${attempt.reviewRun?.reason || attempt.reviewRun?.status}; ${attempt.reviewRun?.output || ''}`);
  assert.equal(attempt.status, attempt.review === 'пройдено' ? 'готова к рассмотрению' : 'требуется решение'); assert.equal(attempt.reviewRun.validity, 'совпадает');
  assert.ok(attempt.sessionId); assert.match(await readFile(join(repo, 'add.mjs'), 'utf8'), /a\s*\+\s*b/);
  const first = attempt;
  console.log(`First independent review: ${attempt.review}`);
  preview = await post('attempt-prepare', { taskId: task.id, message: 'Without using tools or changing anything, briefly explain the exact change you made in your previous turn.' });
  assert.equal(preview.resumeSessionId, first.sessionId);
  await post('attempt-start', { taskId: task.id, previewId: preview.previewId, confirmed: true });
  attempt = await finished();
  assert.equal(attempt.agentStatus, 'выполнение завершено', attempt.diagnostics.output);
  assert.equal(attempt.sessionId, first.sessionId); assert.equal(attempt.parentAttemptId, first.id);
  assert.equal(attempt.baseline.fingerprint, attempt.after.fingerprint);
  assert.ok(['пройдено', 'есть замечания', 'неполное'].includes(attempt.reviewRun?.status), attempt.reviewRun?.reason);
  assert.equal(attempt.reviewRun.validity, 'совпадает');
  await writeFile(join(repo, 'add.mjs'), 'export function add(a,b) { return 0; }\n');
  await post('checks-refresh', { taskId: task.id, attemptId: attempt.id });
  attempt = (await post('attempts', { taskId: task.id })).at(-1);
  assert.equal(attempt.review, 'устарело'); assert.equal(attempt.reviewRun.validity, 'устарели');
  console.log('PASS: real Codex edit → configured tests → independent read-only review → exact session resume → checks/review → stale result detection.');
} finally {
  if (server?.exitCode === null && base && headers && task) {
    await post('attempt-stop', { taskId: task.id }).catch(() => {});
    for (let i = 0; i < 100; i++) { if (!(await post('attempts', { taskId: task.id })).some(a => a.active)) break; await delay(100); }
  }
  if (server?.exitCode === null) { server.kill(); await once(server, 'exit'); }
  await rm(dir, { recursive: true, force: true });
}
