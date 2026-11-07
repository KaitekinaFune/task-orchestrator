import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createImageStore, decodeImages } from '../src/images.mjs';
import { createRuns } from '../src/runs.mjs';
import { defaultSettings } from '../src/supervisor.mjs';
import { stopTree } from '../src/claude.mjs';

const none = { workers: [], check_ids: [], question: null, summary: null, outcome: null };
const act = (action, fields = {}) => ({ action, reason: `because ${action}`, ...none, ...fields });
const finishDone = (summary = 'Сделано') => act('finish', { outcome: 'done', summary });
const write = (prompt = 'Исправь', extra = {}) => ({ name: 'Исполнитель', agent: 'claude-subscription', access: 'write', prompt, continue_worker: null, ...extra });
const read = (prompt = 'Посмотри', agent = 'claude-subscription') => ({ name: 'Ревью', agent, access: 'read', prompt, continue_worker: null });
const codexAnswer = text => ['thread.started', 'item', 'turn.completed'].map(kind => JSON.stringify(kind === 'thread.started' ? { type: kind, thread_id: '22222222-2222-4222-8222-222222222222' } : kind === 'item' ? { type: 'item.completed', item: { type: 'agent_message', text } } : { type: kind })).join('\n') + '\n';
const result = (extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'готово', session_id: '11111111-1111-4111-8111-111111111111', ...extra }) + '\n';
const check = (id, code = 0) => ({ id, name: id, executable: process.execPath, args: ['-e', `console.log("log ${id}"); process.exit(${code})`], timeoutSeconds: 10 });

// The supervisor is a script of decisions; workers are real child processes so that stopping and logs stay real.
function harness({ decisions = [], workerScript, checks = [], fingerprints, projects, tasks, environmentFor, ...options } = {}) {
  const state = { projects: projects || [{ id: 'project', path: process.cwd(), checks }], tasks: tasks || [{ id: 'task', projectId: 'project', title: 't', description: 'Описание задачи' }], settings: defaultSettings() };
  const saved = [], launches = [], prompts = [];
  let fingerprint = 'base', index = 0;
  const runs = createRuns({ getState: () => state,
    store: { save: async run => { saved.push(run.status); }, remove: async () => {} },
    environmentFor: environmentFor || (async () => ({ environment: { ...process.env }, secrets: ['very-secret'] })),
    capture: async path => ({ path, fingerprint: fingerprints ? fingerprints() : fingerprint, clean: true, changes: [], head: 'h', branch: 'main' }),
    launch: input => {
      launches.push(input);
      let script;
      if (input.supervisor) {
        prompts.push(input.prompt);
        const next = decisions[index++] ?? finishDone();
        script = `process.stdout.write(${JSON.stringify(result({ result: '', structured_output: next }))})`;
      } else script = workerScript?.(input) ?? `process.stdout.write(${JSON.stringify(result({ result: 'Ответ воркера' }))})`;
      const child = spawn(process.execPath, ['-e', script], { env: input.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      child.stdin.on('error', () => {}); child.stdin.end(input.prompt); return child;
    }, stop: stopTree, ...options });
  return { runs, state, launches, prompts, saved, setFingerprint: value => { fingerprint = value; }, workerLaunches: () => launches.filter(item => !item.supervisor) };
}
async function settled(runs, taskId = 'task', ...statuses) {
  for (let i = 0; i < 500; i++) {
    const run = runs.get(taskId);
    if (run && !run.active && !run.queued && (!statuses.length || statuses.includes(run.status))) return run;
    await delay(10);
  }
  throw new Error(`Run did not settle: ${JSON.stringify(runs.get(taskId)?.status)}`);
}

test('a simple task runs one writer, and the status comes from evidence', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [write('Исправь add')] }), finishDone('Исправлено')], workerScript: () => { h.setFingerprint('after'); return `process.stdout.write(${JSON.stringify(result({ result: 'Правка сделана' }))})`; } });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.status, 'готово');
  assert.equal(run.workers.length, 1);
  assert.equal(run.workers[0].filesChanged, true); assert.equal(run.workers[0].answer, 'Правка сделана');
  assert.deepEqual(run.report.evidence, { filesChanged: true, checks: 'не запускались', readAfterWrite: false });
  assert.equal(h.launches[0].noTools, true, 'supervisor has no tools');
  assert.equal(h.launches[0].readOnly, true);
  assert.notEqual(h.workerLaunches()[0].readOnly, true);
  // Rules and the original task are added by the engine, not left to the model.
  assert.match(h.workerLaunches()[0].prompt, /Исправь add/);
  assert.match(h.workerLaunches()[0].prompt, /Описание задачи/);
  assert.match(h.workerLaunches()[0].prompt, /Не выполняй push, merge, commit/);
  assert.match(h.prompts[1], /Правка сделана/, 'next decision sees the worker answer');
});

test('the latest message of a task follows its state, and a waiting question is not repeated', async () => {
  const h = harness({ decisions: [act('ask_user', { question: 'Какой API?' }), finishDone('Сделано: ' + 'я'.repeat(500))] });
  assert.deepEqual(h.runs.latest(), {});
  await h.runs.start('task');
  await settled(h.runs, 'task', 'ждёт ответа');
  assert.deepEqual(h.runs.latest(), {}, 'the question travels on its own');
  await h.runs.message('task', 'Новый');
  await settled(h.runs, 'task', 'готово');
  const { task } = h.runs.latest();
  assert.equal(task.kind, 'report'); assert.match(task.text, /^Сделано: я+…$/); assert.equal(task.text.length, 401);
});

test('every process leaves counters in the ledger, with no text, and prices only the subscription', async () => {
  const usageResult = model => result({ result: 'секретный ответ', total_cost_usd: 1, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, costUSD: 1 } } });
  const entries = [];
  const h = harness({ decisions: [act('run_workers', { workers: [{ ...write('секретный запрос'), agent: 'claude-deepseek' }] }), act('run_workers', { workers: [write('Ещё')] }), finishDone()], usage: { append: entry => { entries.push(entry); } },
    workerScript: input => `process.stdout.write(${JSON.stringify(usageResult(input.profile === 'deepseek' ? 'deepseek-chat' : 'claude-opus-5-5'))})` });
  h.state.settings.workers.push({ id: 'claude-deepseek', model: '', note: '' });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.workers[0].usage[0].model, 'deepseek-chat');
  assert.equal(run.workers[0].usage[0].costUsd, null, 'a list price says nothing about DeepSeek');
  assert.equal(run.workers[1].usage[0].costUsd, 1);
  assert.equal(run.costUsd, 1, 'the task total counts only what can be estimated');
  const written = entries.filter(entry => entry.kind === 'worker');
  assert.deepEqual(written.map(entry => [entry.agentId, entry.profile, entry.taskId]), [['claude-deepseek', 'deepseek', 'task'], ['claude-subscription', 'subscription', 'task']]);
  assert.doesNotMatch(JSON.stringify(entries), /секретный/);
});

test('workers run with the access the supervisor asked for, within the fixed roster', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read('A', 'codex'), read('B', 'codex')] }), finishDone()], workerScript: () => `process.stdout.write(${JSON.stringify(codexAnswer('Мнение'))})` });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.deepEqual(h.workerLaunches().map(item => [item.agent, item.readOnly]), [['codex', true], ['codex', true]]);
  assert.deepEqual(run.workers.map(worker => [worker.status, worker.answer]), [['готово', 'Мнение'], ['готово', 'Мнение']]);
  assert.equal(run.report.evidence.filesChanged, false);
});

test('an invalid decision is returned to the supervisor once, and a second one stops the run visibly', async () => {
  const bad = [act('run_workers', { workers: [write(), write()] }), act('run_workers', { workers: [{ ...write(), agent: 'unknown' }] })];
  const h = harness({ decisions: bad });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.status, 'ошибка'); assert.match(run.error, /некорректный ответ/);
  assert.equal(h.workerLaunches().length, 0, 'nothing started from an invalid decision');
  assert.match(h.prompts[1], /отклонён: Несколько воркеров/);
});

test('an unknown check id cannot run a command; checks run from project settings only', async () => {
  const h = harness({ checks: [check('tests'), check('other')], decisions: [act('run_checks', { check_ids: ['rm -rf'] }), act('run_checks', { check_ids: ['tests'] }), finishDone()] });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.deepEqual(run.checkRuns.map(item => item.results.map(r => r.definition.id)), [['tests']]);
  assert.equal(run.status, 'готово'); assert.equal(run.report.evidence.checks, 'пройдены');
  assert.match(h.prompts[1], /отклонён: check_ids/);
  assert.match(h.prompts[2], /log tests/, 'the check output reaches the next decision');
});

test('"done" with failed checks does not become ready', async () => {
  const h = harness({ checks: [check('tests', 7)], decisions: [act('run_checks', { check_ids: ['tests'] }), finishDone('Всё отлично')] });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.status, 'требуется решение'); assert.match(run.statusReason, /не пройдены/);
  assert.equal(run.checkRuns[0].results[0].exitCode, 7);
});

test('checks stop counting after the files change', async () => {
  const h = harness({ checks: [check('tests')], decisions: [act('run_checks', { check_ids: ['tests'] }), act('run_workers', { workers: [write()] }), finishDone()], workerScript: () => { h.setFingerprint('changed'); return `process.stdout.write(${JSON.stringify(result())})`; } });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.report.evidence.checks, 'устарели'); assert.equal(run.status, 'требуется решение');
});

test('an outside edit after the checks is caught at the end', async () => {
  const h = harness({ checks: [check('tests')], decisions: [act('run_checks', { check_ids: ['tests'] }), finishDone()], checkLaunch: undefined });
  const started = h.runs.start('task');
  await started;
  // Changes the fingerprint before the final capture.
  for (let i = 0; i < 300 && !h.runs.get('task').checkRuns.length; i++) await delay(5);
  h.setFingerprint('edited');
  const run = await settled(h.runs);
  assert.equal(run.report.evidence.checks, 'устарели');
});

test('a read worker after the last write counts as independent reading; before it does not', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), act('run_workers', { workers: [write()] }), finishDone()] });
  await h.runs.start('task');
  assert.equal((await settled(h.runs)).report.evidence.readAfterWrite, false);
  const after = harness({ decisions: [act('run_workers', { workers: [write()] }), act('run_workers', { workers: [read()] }), finishDone()] });
  await after.runs.start('task');
  assert.equal((await settled(after.runs)).report.evidence.readAfterWrite, true);
});

test('a question waits with nothing running, and the answer continues the same journal', async () => {
  const h = harness({ decisions: [act('ask_user', { question: 'Какой API оставить?' }), finishDone()] });
  await h.runs.start('task');
  const waiting = await settled(h.runs);
  assert.equal(waiting.status, 'ждёт ответа'); assert.equal(waiting.waiting.question, 'Какой API оставить?');
  assert.deepEqual(h.runs.questions(), { task: 'Какой API оставить?' });
  await h.runs.message('task', 'Старый');
  const run = await settled(h.runs, 'task', 'готово');
  assert.equal(run.waiting, null); assert.deepEqual(h.runs.questions(), {});
  assert.match(h.prompts[1], /Какой API оставить/); assert.match(h.prompts[1], /Старый/);
});

test('a message during work reaches the next decision without a restart', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), finishDone()], workerScript: () => `setTimeout(() => process.stdout.write(${JSON.stringify(result())}), 300)` });
  await h.runs.start('task');
  for (let i = 0; i < 300 && !h.workerLaunches().length; i++) await delay(5);
  await h.runs.message('task', 'Учти ещё совместимость');
  const run = await settled(h.runs);
  assert.equal(run.status, 'готово');
  assert.match(h.prompts[1], /Учти ещё совместимость/);
});

test('a finished task continues, and a writer can resume its session', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [write()] }), finishDone(), act('run_workers', { workers: [write('Ещё', { continue_worker: 'w1' })] }), finishDone()] });
  await h.runs.start('task');
  await settled(h.runs, 'task', 'готово');
  await h.runs.message('task', 'Поправь ещё');
  for (let i = 0; i < 300 && h.runs.get('task').workers.length < 2; i++) await delay(5);
  const run = await settled(h.runs, 'task', 'готово');
  assert.equal(h.workerLaunches()[1].resumeSessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(run.workers[1].continued, 'w1');
  assert.match(h.prompts[2], /Прошлое завершение/);
});

test('a read worker has no session to continue', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), act('run_workers', { workers: [{ ...read(), access: 'write', continue_worker: 'w1' }] }), act('finish', { outcome: 'blocked', summary: 'нет' })] });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.workers.length, 1); assert.equal(run.status, 'требуется решение');
  assert.match(h.prompts[2], /отклонён: continue_worker/);
});

test('a refused action is granted only by the user and only from the stored refusal', async () => {
  const denied = result({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'dotnet build' } }] });
  let calls = 0;
  const h = harness({ decisions: [act('run_workers', { workers: [write()] }), act('finish', { outcome: 'blocked', summary: 'Нужно разрешение' }), act('run_workers', { workers: [write('Повтори', { continue_worker: 'w1' })] }), finishDone()],
    workerScript: () => `process.stdout.write(${JSON.stringify(calls++ ? result() : denied)})` });
  await h.runs.start('task');
  const blocked = await settled(h.runs, 'task', 'требуется решение');
  assert.equal(blocked.workers[0].status, 'отказ в правах');
  assert.equal(h.workerLaunches()[0].allowedTools, undefined, 'the supervisor cannot grant anything');
  assert.match(h.prompts[1], /dotnet build/);
  await h.runs.message('task', 'Разрешаю', true);
  await settled(h.runs, 'task', 'готово');
  assert.deepEqual(h.workerLaunches()[1].allowedTools, ['Bash(dotnet build)']);
  await assert.rejects(h.runs.message('task', 'Ещё', true), /Нет отказов/);
});

test('a failing worker is reported to the supervisor, which can choose another way', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), finishDone()], workerScript: () => 'process.exit(1)' });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.workers[0].status, 'ошибка'); assert.match(h.prompts[1], /"status": "ошибка"/);
  assert.equal(run.status, 'готово', 'the run goes on: the decision is the supervisor\'s');
});

test('a worker profile that cannot be prepared does not stop the run', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read('x', 'codex')] }), finishDone()], environmentFor: async (profile, agent) => { if (agent === 'codex') throw new Error('no key'); return { environment: { ...process.env } }; } });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.workers[0].status, 'ошибка'); assert.equal(run.status, 'готово');
});

test('a failing supervisor CLI ends the run with the reason from the CLI, without inventing a result', async () => {
  const state = harness();
  state.launches.length = 0;
  const failing = createRuns({ getState: () => state.state, store: { save: async () => {} }, environmentFor: async () => ({ environment: { ...process.env }, secrets: ['very-secret'] }),
    capture: async path => ({ path, fingerprint: 'x', clean: true, changes: [] }),
    launch: input => { const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(result({ is_error: true, subtype: 'error', result: 'OAuth session expired very-secret' }))})`], { env: input.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); child.stdin.on('error', () => {}); child.stdin.end(); return child; }, stop: stopTree });
  await failing.start('task');
  const run = await settled(failing);
  assert.equal(run.status, 'ошибка'); assert.match(run.error, /OAuth session expired/);
  assert.doesNotMatch(run.error, /very-secret/); assert.equal(run.report, undefined);
});

test('limits stop a supervisor that does not finish', async () => {
  const decisions = Array.from({ length: 60 }, () => act('get_diff'));
  const h = harness({ decisions });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.status, 'требуется решение'); assert.match(run.statusReason, /лимит шагов/);
  assert.equal(h.prompts.length, 40);
});

test('the time budget stops the run', async () => {
  const h = harness({ decisions: Array.from({ length: 40 }, () => act('get_diff')), budgetMs: 1 });
  await h.runs.start('task');
  await delay(5);
  const run = await settled(h.runs);
  assert.equal(run.status, 'требуется решение'); assert.match(run.statusReason, /лимит времени/);
});

test('stopping kills the running worker tree and is not reported as success', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [write()] })], workerScript: () => 'setInterval(() => {}, 1000)' });
  await h.runs.start('task');
  for (let i = 0; i < 300 && !h.workerLaunches().length; i++) await delay(10);
  await delay(100);
  await h.runs.stop('task');
  const run = await settled(h.runs);
  assert.equal(run.status, 'отменена'); assert.equal(run.workers[0].status, 'прервано');
  await assert.rejects(h.runs.stop('task'), /не найден/);
});

test('a worker over its time limit stops alone; the supervisor decides what is next', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), finishDone()], workerScript: () => 'setInterval(() => {}, 1000)', timeoutMs: 400 });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.equal(run.workers[0].status, 'таймаут'); assert.equal(run.status, 'готово');
});

test('tasks in different directories run together; the same directory waits its turn', async () => {
  const projects = [{ id: 'a', path: 'C:/a', checks: [] }, { id: 'b', path: 'C:/b', checks: [] }];
  const tasks = [{ id: 'first', projectId: 'a', description: 'x' }, { id: 'second', projectId: 'b', description: 'y' }, { id: 'third', projectId: 'a', description: 'z' }];
  const h = harness({ projects, tasks, decisions: [], launch: undefined });
  let open = 0, most = 0;
  const original = createRuns({ getState: () => h.state, store: { save: async () => {} }, environmentFor: async () => ({ environment: { ...process.env } }),
    capture: async path => ({ path, fingerprint: 'f', clean: true, changes: [] }),
    launch: input => {
      open++; most = Math.max(most, open);
      const child = spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(result({ structured_output: finishDone() }))}), 150)`], { env: input.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.on('error', () => {}); child.stdin.end(); child.once('close', () => { open--; }); return child;
    }, stop: stopTree });
  await original.start('first'); await original.start('second'); await original.start('third');
  assert.equal(original.get('third').queued, true); assert.equal(original.get('third').status, 'в очереди');
  assert.equal(original.get('second').active, true);
  for (const id of ['first', 'second', 'third']) assert.equal((await settled(original, id, 'готово')).status, 'готово');
  assert.equal(most, 2);
});

test('a queued task can be stopped without ever starting', async () => {
  const projects = [{ id: 'a', path: 'C:/a', checks: [] }];
  const tasks = [{ id: 'first', projectId: 'a', description: 'x' }, { id: 'second', projectId: 'a', description: 'y' }];
  const h = harness({ projects, tasks, decisions: [act('run_workers', { workers: [read()] }), finishDone()], workerScript: () => `setTimeout(() => process.stdout.write(${JSON.stringify(result())}), 200)` });
  await h.runs.start('first'); await h.runs.start('second');
  assert.deepEqual(await h.runs.stop('second'), { status: 'отменена' });
  await settled(h.runs, 'first', 'готово');
  assert.equal(h.runs.get('second').status, 'отменена'); assert.equal(h.runs.get('second').workers.length, 0);
});

test('a restarted server continues from the saved journal', async () => {
  const h = harness({ decisions: [finishDone()] });
  const saved = { id: 'r', taskId: 'task', directory: process.cwd(), status: 'прервана', baseline: { fingerprint: 'base', clean: true, changes: [] }, current: { fingerprint: 'base' }, journal: [{ kind: 'user', text: 'Первый запрос' }], workers: [], checkRuns: [], grants: [], counters: { turns: 3, workerStarts: 1 }, recoveryPending: true };
  const restarted = createRuns({ getState: () => h.state, store: { save: async () => {} }, initial: [saved], environmentFor: async () => ({ environment: { ...process.env } }),
    capture: async path => ({ path, fingerprint: 'base', clean: true, changes: [] }),
    launch: input => { const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(result({ structured_output: finishDone() }))})`], { env: input.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); child.stdin.on('error', () => {}); child.stdin.end(); assert.match(input.prompt, /Первый запрос/); return child; }, stop: stopTree });
  await restarted.acknowledgeRecovery();
  assert.equal(restarted.get('task').recoveryPending, undefined);
  await restarted.message('task', 'Продолжай');
  assert.equal((await settled(restarted, 'task', 'готово')).status, 'готово');
});

test('the page gets log tails, and the whole log on request', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), finishDone()], workerScript: () => `process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(40000) }] } }) + '\\n' + ${JSON.stringify(result())})` });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.ok(run.workers[0].output.length <= 16000); assert.equal(run.workers[0].logTrimmed, true);
  assert.ok(h.runs.worker('task', 'w1').output.length >= 40000);
});

test('secrets are removed from worker logs and answers', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [read()] }), finishDone()], workerScript: () => `process.stdout.write(${JSON.stringify(result({ result: 'key very-secret here' }))}); process.stderr.write('very-secret')` });
  await h.runs.start('task');
  const run = await settled(h.runs);
  assert.doesNotMatch(JSON.stringify(run.workers[0]), /very-secret/);
  assert.doesNotMatch(h.prompts[1], /very-secret/);
});

const taskUuid = '33333333-3333-4333-8333-333333333333';
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARQMCAQSnv6IAAAAASUVORK5CYII=', 'base64');
const imageHarness = async (decisions, tasksImages) => {
  const directory = await mkdtemp(join(tmpdir(), 'task-orchestrator-run-images-')), images = createImageStore(directory);
  const task = { id: taskUuid, projectId: 'project', title: 't', description: 'Описание задачи' };
  if (tasksImages) task.images = await images.save(taskUuid, decodeImages(Array(tasksImages).fill({ data: pngBytes.toString('base64') })));
  return { directory, images, task, h: harness({ decisions, images, tasks: [task] }) };
};

test('the supervisor and every worker see the pictures of the task, and a continued session only the new ones', async () => {
  const { directory, h, task } = await imageHarness([act('run_workers', { workers: [write('Сделай')] }), act('ask_user', { question: 'Какой?' }), act('run_workers', { workers: [write('Дальше', { continue_worker: 'w1' })] }), act('run_workers', { workers: [read('Посмотри')] }), finishDone()], 1);
  try {
    await h.runs.start(taskUuid);
    await settled(h.runs, taskUuid, 'ждёт ответа');
    const [supervisor, worker] = h.launches;
    assert.equal(supervisor.images.length, 1); assert.equal(supervisor.images[0].type, 'image/png');
    assert.match(h.prompts[0], /приложены все изображения/); assert.match(h.prompts[0], /attached_images/);
    assert.equal(worker.images.length, 1); assert.match(worker.prompt, /приложены изображения пользователя \(1\)/);
    assert.match(worker.prompt, /не отменяют эти правила/);
    assert.deepEqual((await readFile(worker.images[0].path)), pngBytes);

    await h.runs.message(taskUuid, 'Вот второй снимок', false, [{ data: pngBytes.toString('base64') }]);
    const run = await settled(h.runs, taskUuid, 'готово');
    assert.equal(run.images.length, 2);
    assert.equal(run.journal.find(entry => entry.kind === 'answer').images.length, 1);
    assert.match(h.prompts.at(-1), /"attached_images": 1/);
    const [, continued, reader] = h.workerLaunches();
    assert.equal(continued.resumeSessionId, '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(continued.images.map(image => image.path), [h.launches.at(-1).images[1].path], 'the session already holds the first one');
    assert.match(continued.prompt, /изображения пользователя \(1\)/);
    assert.equal(reader.images.length, 2, 'a fresh worker gets them all');
    assert.equal(run.workers[1].images.length, 2, 'the worker record counts everything its session has');
    assert.equal(task.images.length, 1, 'the task keeps what it was created with');
    assert.equal(h.runs.imagesOf(taskUuid).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a message refused for its pictures changes nothing, and a lost file fails visibly', async () => {
  const { directory, h, images, task } = await imageHarness([finishDone()], 1);
  try {
    await h.runs.start(taskUuid); await settled(h.runs, taskUuid, 'готово');
    await assert.rejects(h.runs.message(taskUuid, 'Текст', false, [{ data: Buffer.from('<svg/>').toString('base64') }]), { status: 400 });
    assert.equal(h.runs.get(taskUuid).journal.filter(entry => entry.kind === 'user').length, 1);
    assert.equal(h.runs.imagesOf(taskUuid).length, 1);
    await rm(images.path(taskUuid, task.images[0]));
    const before = h.launches.length;
    await h.runs.message(taskUuid, 'Продолжай');
    const failed = await settled(h.runs, taskUuid, 'ошибка');
    assert.match(failed.error, /Файл приложенного изображения недоступен/);
    assert.equal(h.launches.length, before, 'no agent runs without the picture it was promised');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a run without pictures passes none', async () => {
  const h = harness({ decisions: [act('run_workers', { workers: [write()] }), finishDone()] });
  await h.runs.start('task'); await settled(h.runs);
  assert.ok(h.launches.every(launch => launch.images.length === 0));
  assert.doesNotMatch(h.prompts[0], /изображения/); assert.doesNotMatch(h.workerLaunches()[0].prompt, /изображения/);
  await assert.rejects(h.runs.message('task', 'Текст', false, [{ data: pngBytes.toString('base64') }]), /не настроено/);
});
