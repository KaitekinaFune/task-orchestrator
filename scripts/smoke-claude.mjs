// Explicit opt-in integration check: calls the real subscription CLI/model.
// Uses a disposable repository and separate application state, never the user's checkout.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const dir = await mkdtemp(join(tmpdir(), 'orchestrator-smoke-'));
let server, base, headers, task;
async function post(endpoint, body) {
  const response = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${endpoint}`);
  return response.json();
}
try {
  const repo = join(dir, 'repo'); await mkdir(repo);
  await promisify(execFile)('git', ['-C', repo, 'init', '--initial-branch=main'], { windowsHide: true });
  const marker = `ORCHESTRATOR_SMOKE_${randomUUID()}`;
  await writeFile(join(repo, 'hello.txt'), marker);
  server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', TASK_ORCHESTRATOR_DATA: join(dir, 'state') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', () => {});
  const startupTimeout = setTimeout(() => server.kill(), 15000);
  let output = '';
  for await (const chunk of server.stdout) { output += chunk; if (output.match(/http:\/\/127\.0\.0\.1:\d+/)) break; }
  clearTimeout(startupTimeout);
  base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; assert.ok(base, 'Server did not start');
  const state = await (await fetch(`${base}/api/state`)).json();
  headers = { 'Content-Type': 'application/json', 'X-Task-Token': state.token, Origin: base };
  const project = await post('projects', { path: repo });
  const checks = [{ id: 'file-read', name: 'Проверка тестового файла', executable: process.execPath,
    args: ['-e', 'const fs=require("node:fs");if(fs.readFileSync("hello.txt","utf8")!==process.argv[1])process.exit(2);console.log("CHECK_FILE_OK")', marker], timeoutSeconds: 10 }];
  await post('project-checks', { projectId: project.id, checks });
  task = await post('tasks', { projectId: project.id, profile: 'subscription', title: 'CLI smoke check',
    workflow: { mode: 'checked', checkIds: ['file-read'] },
    description: 'Read hello.txt with the Read tool. Reply only with its complete contents. Do not modify any file and do not run shell commands.',
    criteria: 'The reply contains the exact contents of hello.txt; no files are changed.' });
  const preview = await post('attempt-prepare', { taskId: task.id });
  await post('attempt-start', { taskId: task.id, previewId: preview.previewId, confirmed: true });
  let attempt;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    attempt = (await post('attempts', { taskId: task.id })).at(-1);
    if (!attempt.active && attempt.endedAt && (attempt.after || attempt.snapshotError)) break;
    await delay(250);
  }
  assert.equal(attempt?.agentStatus, 'выполнение завершено', 'Real CLI run did not complete successfully');
  assert.equal(attempt.status, 'проверки завершены');
  assert.ok(attempt.output.includes(marker), 'Real model did not return the file contents');
  assert.equal(attempt.output.split(marker).length - 1, 1, 'Final result duplicated the assistant response');
  assert.equal(attempt.after?.fingerprint, attempt.baseline.fingerprint, 'Workspace changed');
  assert.equal(attempt.exitCode, 0); assert.equal(attempt.checks, 'пройдены');
  assert.equal(attempt.checkRuns[0].results[0].exitCode, 0); assert.equal(attempt.review, 'не запрошено');
  assert.equal(attempt.workflow.mode, 'checked');
  assert.ok(attempt.checkRuns[0].results[0].output.includes('CHECK_FILE_OK'));
  const firstAttempt = attempt;
  assert.ok(firstAttempt.sessionId, 'CLI did not return a resumable session');
  const continuation = await post('attempt-prepare', { taskId: task.id,
    message: 'Using only our conversation, repeat the exact file contents you returned in your previous answer. Reply with that marker only. Do not use tools, read files, run commands or modify anything.' });
  assert.equal(continuation.resumeSessionId, firstAttempt.sessionId);
  await post('attempt-start', { taskId: task.id, previewId: continuation.previewId, confirmed: true });
  const resumeDeadline = Date.now() + 90000;
  while (Date.now() < resumeDeadline) {
    attempt = (await post('attempts', { taskId: task.id })).at(-1);
    if (!attempt.active && attempt.endedAt) break;
    await delay(250);
  }
  assert.equal(attempt.agentStatus, 'выполнение завершено', 'Resumed CLI did not complete');
  assert.equal(attempt.sessionId, firstAttempt.sessionId, 'Resumed the wrong session');
  assert.equal(attempt.parentAttemptId, firstAttempt.id);
  assert.ok(attempt.output.includes(marker), 'Resumed session did not recall the previous answer');
  assert.equal(attempt.after?.fingerprint, firstAttempt.baseline.fingerprint, 'Continuation modified files');
  assert.equal(attempt.checks, 'пройдены');
  await post('project-checks', { projectId: project.id, checks: [{ ...checks[0], args: ['-e', 'console.error("EXPECTED_FAILURE");process.exit(7)'] }] });
  const checkPreview = await post('checks-prepare', { taskId: task.id, attemptId: attempt.id });
  await post('checks-start', { taskId: task.id, previewId: checkPreview.previewId, confirmed: true });
  for (let i = 0; i < 100; i++) {
    attempt = (await post('attempts', { taskId: task.id })).at(-1);
    if (!attempt.active && attempt.endedAt) break;
    await delay(100);
  }
  assert.equal(attempt.checks, 'есть ошибки'); assert.equal(attempt.checkRuns.length, 2);
  assert.equal(attempt.checkRuns[1].results[0].exitCode, 7);
  await writeFile(join(repo, 'hello.txt'), 'changed after checks');
  const freshness = await post('checks-refresh', { taskId: task.id, attemptId: attempt.id });
  assert.equal(freshness.checks, 'устарели'); assert.equal(freshness.fingerprintMatches, false);
  console.log('PASS: real Claude → file read → check exit 0 → resume exact session and recall previous answer → checks → rerun exit 7 → snapshot invalidation; history saved.');
} finally {
  if (server && server.exitCode === null && base && headers && task) {
    await post('attempt-stop', { taskId: task.id }).catch(() => {});
    // Wait for process-tree termination before stopping the HTTP server.
    for (let i = 0; i < 100; i++) {
      const records = await post('attempts', { taskId: task.id }).catch(() => []);
      if (!records.some(a => a.active)) break;
      await delay(100);
    }
  }
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  await rm(dir, { recursive: true, force: true });
}
