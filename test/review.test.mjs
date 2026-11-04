import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createAttempts } from '../src/attempts.mjs';
import { parseReview, reviewSchemaPath } from '../src/review.mjs';
import { claudeArgs } from '../src/claude.mjs';
const sessionId = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
const pass = { summary: 'Meets the requirement', verdict: 'pass', findings: [], criteria: [{ criterion: 'Works', status: 'met', evidence: 'file.mjs:1 implementation' }], limitations: [] };
const reviewer = { agent: 'codex', model: 'review-model', instructions: 'Check compatibility' };
const events = report => [{ type: 'thread.started', thread_id: sessionId }, { type: 'item.completed', item: { type: 'agent_message', text: typeof report === 'string' ? report : JSON.stringify(report) } }, { type: 'turn.completed' }].map(x => JSON.stringify(x)).join('\n');
function child(script, environment = process.env) { return spawn(process.execPath, ['-e', script], { env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
function harness({ report = pass, capture, reviewScript, checkFailure = false, agent = 'claude', executorError = false, workflow } = {}) {
  const environments = [];
  const check = { id: 'tests', name: 'Tests', executable: process.execPath, args: ['-e', 'process.exit(7)'], timeoutSeconds: 5 };
  let state = { projects: [{ id: 'p', path: process.cwd(), checks: checkFailure ? [check] : [] }], tasks: [{ id: 't', projectId: 'p', title: 'Task', description: 'Description', criteria: 'Works', agent, profile: agent === 'codex' ? 'default' : 'subscription', model: 'executor-model', workflow: workflow || { mode: 'review', checkIds: checkFailure ? ['tests'] : [], reviewer } }], attempts: [], profiles: {} };
  const launches = []; let snapshots = 0;
  const manager = createAttempts({ getState: () => state, mutate: async change => { const next = structuredClone(state); change(next); state = next; },
    environmentFor: async (profile, provider) => { environments.push([profile, provider]); return { environment: process.env, secrets: ['test-secret-value'] }; },
    capture: async () => capture ? capture(++snapshots) : { path: process.cwd(), fingerprint: 'same', clean: false, changes: [], head: 'abc' },
    launch: options => { launches.push({ role: 'executor', options }); return child(`process.stdout.write(${JSON.stringify(agent === 'codex' ? events('Executor answer') : JSON.stringify({ type: 'result', is_error: executorError, subtype: 'success', result: 'Executor answer', session_id: sessionId }) + '\n')})`); },
    reviewerLaunch: options => { launches.push({ role: 'reviewer', options }); return child(reviewScript || `process.stdout.write(${JSON.stringify(events(report))})`); }
  });
  return { manager, launches, environments, get state() { return state; } };
}
async function finished(h) {
  for (let i = 0; i < 200; i++) { const a = h.manager.list('t').at(-1); if (a?.endedAt && !a.active) return a; await delay(20); }
  throw new Error('Attempt did not finish');
}
async function start(h) { const p = await h.manager.prepare('t'); await h.manager.start('t', p.previewId, true); }

test('review rejects malformed data and contradictory success', () => {
  assert.deepEqual(parseReview(JSON.stringify(pass)), pass);
  const finding = { severity: 'P1', title: 'Bug', file: 'file.mjs', line: 1, evidence: 'wrong return' };
  for (const value of ['not json', JSON.stringify({}), JSON.stringify({ ...pass, criteria: [] }), JSON.stringify({ ...pass, criteria: [{ ...pass.criteria[0], status: 'unknown' }] }),
    JSON.stringify({ ...pass, findings: [finding] }), JSON.stringify({ ...pass, verdict: 'changes_requested', findings: [{ ...finding, file: '../outside' }] })]) assert.throws(() => parseReview(value));
});
test('a reviewer whose profile cannot be prepared refuses the run before the executor spends anything', async () => {
  let launched = 0;
  const state = { projects: [{ id: 'p', path: process.cwd(), checks: [] }], tasks: [{ id: 't', projectId: 'p', title: 'Task', description: 'Description', criteria: 'Works', agent: 'claude', profile: 'subscription', model: '', workflow: { mode: 'review', checkIds: [], reviewer } }], attempts: [], profiles: {} };
  const manager = createAttempts({ getState: () => state, mutate: async change => change(state),
    environmentFor: async (profile, agent) => { if (agent === 'codex') throw new Error('secret-free failure'); return { environment: process.env, secrets: [] }; },
    capture: async () => ({ path: process.cwd(), fingerprint: 'same', clean: true, changes: [], head: 'abc' }),
    launch: () => { launched++; return child('process.exit(0)'); } });
  try {
    const p = await manager.prepare('t');
    await assert.rejects(manager.start('t', p.previewId, true), /профиль ревьюера/);
    assert.equal(launched, 0); assert.equal(manager.list('t').length, 0);
  } finally { await manager.shutdown(); }
});
test('separate read-only reviewer records structured findings, model and snapshot without changing executor session', async () => {
  const h = harness({ agent: 'codex' });
  try {
    await start(h); const a = await finished(h);
    assert.equal(a.status, 'готова к рассмотрению'); assert.equal(a.review, 'пройдено'); assert.deepEqual(a.reviewRun.result, pass);
    assert.equal(a.reviewRun.snapshot, 'same'); assert.equal(a.reviewRun.validity, 'совпадает'); assert.equal(a.sessionId, sessionId);
    assert.equal(h.launches.length, 2); assert.equal(h.launches[1].options.readOnly, true);
    assert.equal(h.launches[1].options.model, 'review-model'); assert.equal(h.launches[1].options.resumeSessionId, undefined);
    assert.match(h.launches[1].options.prompt, /Check compatibility/); assert.match(a.reviewRun.scope, /существовавшие/);
  } finally { await h.manager.shutdown(); }
});
test('Claude can review: separate read-only run with its own profile, structured output and listed refusals', async () => {
  const claudeReviewer = { agent: 'claude', profile: 'litellm', model: 'review-model', instructions: '' };
  const denial = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
  const wire = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: '', structured_output: pass, permission_denials: [denial] }) + '\n';
  const h = harness({ agent: 'codex', reviewScript: `process.stdout.write(${JSON.stringify(wire)})`, workflow: { mode: 'review', checkIds: [], reviewer: claudeReviewer } });
  try {
    await start(h); const a = await finished(h);
    assert.equal(a.status, 'готова к рассмотрению'); assert.equal(a.reviewRun.agent, 'claude'); assert.equal(a.reviewRun.profile, 'litellm');
    assert.equal(a.reviewRun.result.verdict, 'pass'); assert.match(a.reviewRun.result.limitations[0], /npm test/);
    const review = h.launches[1].options; assert.equal(review.readOnly, true); assert.equal(review.profile, 'litellm'); assert.equal(review.resumeSessionId, undefined);
    assert.deepEqual(h.environments.at(-1), ['litellm', 'claude']);
    assert.equal(a.sessionId, sessionId);
  } finally { await h.manager.shutdown(); }
});
test('Claude reviewer without a structured report is a review error, not a success', async () => {
  const wire = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'Looks fine' }) + '\n';
  const h = harness({ reviewScript: `process.stdout.write(${JSON.stringify(wire)})`, workflow: { mode: 'review', checkIds: [], reviewer: { agent: 'claude', profile: 'subscription', model: '', instructions: '' } } });
  try { await start(h); const a = await finished(h); assert.equal(a.review, 'ошибка'); assert.equal(a.status, 'требуется решение'); }
  finally { await h.manager.shutdown(); }
});
test('Claude read-only arguments use plan mode, no edit tools and the fixed report schema', () => {
  const args = claudeArgs({ profile: 'subscription', model: 'm', readOnly: true, schemaPath: reviewSchemaPath });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'ExitPlanMode']) assert.ok(args.includes(tool));
  assert.ok(args.includes('--no-session-persistence')); assert.ok(!args.includes('bypassPermissions'));
  assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).type, 'object');
  assert.equal(claudeArgs({ profile: 'subscription' }).includes('plan'), false);
});
test('review failure or failing checks never produces ready-for-review success', async () => {
  for (const options of [{ report: '{}' }, { checkFailure: true }, { report: { ...pass, verdict: 'inconclusive', criteria: [{ ...pass.criteria[0], status: 'unknown' }] } }]) {
    const h = harness(options);
    try { await start(h); const a = await finished(h); assert.equal(a.status, 'требуется решение'); if (options.checkFailure) { assert.equal(a.checks, 'есть ошибки'); assert.equal(a.review, 'пройдено'); } }
    finally { await h.manager.shutdown(); }
  }
});
test('failed executor skips independent review', async () => {
  const h = harness({ executorError: true });
  try { await start(h); const a = await finished(h); assert.equal(a.agentStatus, 'ошибка'); assert.equal(h.launches.length, 1); assert.equal(a.review, 'не выполнено'); }
  finally { await h.manager.shutdown(); }
});
test('changed snapshot during review cannot retain a successful review', async () => {
  const h = harness({ capture: n => ({ path: process.cwd(), fingerprint: n >= 3 ? 'changed' : 'same', clean: true, changes: [] }) });
  try { await start(h); const a = await finished(h); assert.equal(a.review, 'устарело'); assert.equal(a.reviewRun.validity, 'устарели'); assert.equal(a.status, 'требуется решение'); assert.equal(h.launches.length, 2); }
  finally { await h.manager.shutdown(); }
});
test('review keeps writer lock until cancelled and records interruption', async () => {
  const h = harness({ reviewScript: 'setInterval(()=>{},1000)' });
  try {
    await start(h);
    for (let i = 0; i < 100 && h.launches.length < 2; i++) await delay(20);
    assert.equal(h.launches.length, 2); await assert.rejects(h.manager.prepare('t'), /активная попытка/);
    await h.manager.cancel('t'); const a = await finished(h); assert.equal(a.status, 'отменена'); assert.equal(a.review, 'прервано');
  } finally { await h.manager.shutdown(); }
});
test('structured review redacts secrets and later freshness checks invalidate it', async () => {
  let fingerprint = 'same';
  const h = harness({ report: { ...pass, summary: 'Found test-secret-value in log' }, capture: () => ({ path: process.cwd(), fingerprint, clean: true, changes: [] }) });
  try {
    await start(h); const a = await finished(h); assert.ok(!JSON.stringify(a).includes('test-secret-value'));
    fingerprint = 'changed'; await h.manager.refreshChecks('t', a.id);
    assert.equal(h.manager.list('t')[0].review, 'устарело'); assert.equal(h.manager.list('t')[0].status, 'требуется решение');
  } finally { await h.manager.shutdown(); }
});

test('manual continuation carries review findings and earlier user clarifications to the next review', async () => {
  const report = { ...pass, verdict: 'changes_requested', findings: [{ severity: 'P1', title: 'Wrong return', file: 'file.mjs', line: 1, evidence: 'Return ignores input' }], criteria: [{ criterion: 'Works', status: 'unmet', evidence: 'Counterexample' }] };
  const h = harness({ report });
  try {
    await start(h); await finished(h);
    for (const message of ['Keep the public API', 'Fix the review findings']) {
      const preview = await h.manager.prepare('t', message); await h.manager.start('t', preview.previewId, true); await finished(h);
    }
    const latest = h.manager.list('t').at(-1);
    assert.deepEqual(latest.requirements.clarifications, ['Keep the public API', 'Fix the review findings']);
    assert.deepEqual(latest.reviewContext.result.findings, report.findings);
    const execution = h.launches.filter(x => x.role === 'executor').at(-1);
    assert.match(execution.options.prompt, /Wrong return/); assert.match(execution.options.prompt, /недоверенные данные/);
    const review = h.launches.filter(x => x.role === 'reviewer').at(-1);
    assert.match(review.options.prompt, /Keep the public API/); assert.match(review.options.prompt, /Fix the review findings/);
    assert.equal(h.launches.length, 6, 'Only explicit user continuations trigger another cycle');
  } finally { await h.manager.shutdown(); }
});
