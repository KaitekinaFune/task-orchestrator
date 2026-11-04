import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createAttempts } from '../src/attempts.mjs';
import { validateAutomation } from '../src/automation.mjs';
import { validateWorkflow } from '../src/workflows.mjs';
const sid = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
const config = { maxFixes: 2, timeBudgetMinutes: 30, fixChecks: true, fixReview: true };
const reviewer = { agent: 'codex', model: '', instructions: '' };
const pass = { summary: 'Pass', verdict: 'pass', findings: [], criteria: [{ criterion: 'Works', status: 'met', evidence: 'Verified' }], limitations: [] };
const issue = (name = 'Bug') => ({ summary: name, verdict: 'changes_requested', findings: [{ severity: 'P1', title: name, file: 'file.mjs', line: 1, evidence: 'Counterexample' }], criteria: [{ criterion: 'Works', status: 'unmet', evidence: 'Counterexample' }], limitations: [] });
const wire = report => [{ type: 'thread.started', thread_id: sid }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }, { type: 'turn.completed' }].map(x => JSON.stringify(x)).join('\n');
function processFor(text, ms = 0, forever = false) {
  return spawn(process.execPath, ['-e', forever ? 'setInterval(()=>{},1000)' : `setTimeout(()=>process.stdout.write(${JSON.stringify(text)}),${ms})`], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
}
function harness(options = {}) {
  const check = { id: 'test', name: 'Test', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 10 };
  let state = { profiles: {}, projects: [{ id: 'p', path: process.cwd(), checks: options.checks ? [check] : [] }], tasks: [{ id: 't', projectId: 'p', title: 'Fix bug', description: 'Make it work', criteria: 'Works', profile: 'subscription', workflow: { mode: 'review', checkIds: options.checks ? ['test'] : [], reviewer, ...(options.fixer ? { fixer: options.fixer } : {}), ...(options.disabled ? {} : { automation: { ...config, ...options.config } }) } }], attempts: [] };
  const environments = [];
  let execCount = 0, reviewCount = 0, captures = 0, writes = Promise.resolve();
  const calls = [], checkCalls = [];
  const manager = createAttempts({ getState: () => state,
    mutate: change => { const operation = writes.then(async () => { const next = structuredClone(state); change(next); if (options.beforeSave) await options.beforeSave(next); state = next; }); writes = operation.catch(() => {}); return operation; },
    environmentFor: async (profile, agent) => { environments.push([profile, agent]); return { environment: process.env, secrets: [] }; },
    capture: async () => {
      captures++; const fingerprint = options.fingerprint ? options.fingerprint({ execCount, reviewCount, captures }) : `snapshot-${execCount}`;
      if (options.onCapture) await options.onCapture({ execCount, reviewCount, captures, state });
      return { path: process.cwd(), fingerprint, head: 'head', branch: 'main', clean: false, changes: [] };
    },
    launch: input => { execCount++; calls.push({ role: 'executor', ...input });
      return processFor(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: options.wrongResume && execCount > 1 ? 'f4a4d998-3c62-4c1f-bd0e-56661f1471ff' : options.fixerSession && execCount > 1 ? options.fixerSession : sid, result: `Answer ${execCount}` }) + '\n', options.stageDelay || 0, options.pauseExecutorAt === execCount); },
    reviewerLaunch: input => { reviewCount++; calls.push({ role: 'reviewer', ...input });
      if (options.onReview) options.onReview(state);
      const report = (options.reports || [issue(), pass])[Math.min(reviewCount - 1, (options.reports || [issue(), pass]).length - 1)];
      return processFor(wire(report), options.stageDelay || 0); },
    checkLaunch: ({ definition }) => { checkCalls.push(structuredClone(definition)); const code = options.checks && execCount === 1 ? 7 : 0;
      return spawn(process.execPath, ['-e', `process.exit(${code})`], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); },
    ...(options.budgetMs ? { automationBudgetMs: () => options.budgetMs } : {})
  });
  return { manager, calls, checkCalls, environments, get state() { return state; }, get execCount() { return execCount; }, get reviewCount() { return reviewCount; }, get captures() { return captures; } };
}
async function until(predicate) { for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(10); } throw new Error('Condition not reached'); }
async function start(h) { const p = await h.manager.prepare('t'); await h.manager.start('t', p.previewId, true); }
async function finish(h) { await until(() => { const a = h.manager.list('t').at(-1); return a?.endedAt && !a.active; }); return h.manager.list('t').at(-1); }

test('automation validates explicit finite limits and stays opt-in for review workflows', () => {
  assert.deepEqual(validateAutomation(config), config); assert.equal(validateAutomation(undefined), undefined);
  for (const value of [null, {}, { ...config, maxFixes: 4 }, { ...config, maxFixes: -1 }, { ...config, maxFixes: 1.5 }, { ...config, timeBudgetMinutes: 0 }, { ...config, timeBudgetMinutes: 121 }, { ...config, fixChecks: 'yes' }, { ...config, fixChecks: false, fixReview: false }, { ...config, approval: true }]) assert.throws(() => validateAutomation(value));
  assert.throws(() => validateWorkflow({ mode: 'quick', checkIds: [], automation: config }, { checks: [] }));
});
test('approved automatic fix resumes the same session, rechecks, reviews and preserves every pass', async () => {
  const h = harness({ checks: true });
  try {
    await start(h); const a = await finish(h);
    assert.equal(a.status, 'готова к рассмотрению'); assert.equal(h.execCount, 2); assert.equal(h.reviewCount, 2);
    assert.equal(a.cycles.length, 2); assert.equal(a.cycles[0].review, 'есть замечания'); assert.equal(a.cycles[1].review, 'пройдено');
    assert.match(a.cycles[0].output, /Answer 1/); assert.match(a.output, /Answer 2/); assert.equal(a.automation.completedFixes, 1);
    assert.equal(a.checkRuns[0].results[0].exitCode, 7); assert.equal(a.checkRuns[1].results[0].exitCode, 0);
    assert.deepEqual(h.checkCalls[0], h.checkCalls[1]);
    const fix = h.calls.filter(c => c.role === 'executor')[1]; assert.equal(fix.resumeSessionId, sid); assert.match(fix.prompt, /Bug/); assert.match(fix.prompt, /недоверенные данные/);
    assert.equal(a.baseline.fingerprint, 'snapshot-0'); assert.equal(a.cycles[1].baseline.fingerprint, 'snapshot-1');
  } finally { await h.manager.shutdown(); }
});
test('a separate fixer gets a new session, then continues it, and the executor session stays for the user', async () => {
  const fixer = { agent: 'claude', profile: 'litellm', model: 'fixer-model' };
  const h = harness({ fixer, reports: [issue('First'), issue('Second'), pass], fixerSession: 'a4a4d998-3c62-4c1f-bd0e-56661f1471ff' });
  try {
    await start(h); const a = await finish(h);
    assert.equal(a.status, 'готова к рассмотрению'); assert.equal(h.execCount, 3);
    const [first, second, third] = h.calls.filter(c => c.role === 'executor');
    assert.equal(first.profile, 'subscription'); assert.equal(first.resumeSessionId, undefined);
    assert.equal(second.profile, 'litellm'); assert.equal(second.model, 'fixer-model'); assert.equal(second.resumeSessionId, undefined); assert.match(second.prompt, /First/); assert.match(second.prompt, /Make it work/);
    assert.equal(third.resumeSessionId, 'a4a4d998-3c62-4c1f-bd0e-56661f1471ff'); assert.match(third.prompt, /Second/);
    assert.equal(a.sessionId, sid); assert.equal(a.fixerSessionId, 'a4a4d998-3c62-4c1f-bd0e-56661f1471ff');
    assert.deepEqual(a.cycles.map(c => c.profile), ['subscription', 'litellm', 'litellm']);
    assert.deepEqual(h.environments, [['subscription', 'claude'], ['litellm', 'claude'], ['default', 'codex'], ['default', 'codex'], ['default', 'codex'], ['default', 'codex']]);
  } finally { await h.manager.shutdown(); }
});
test('a fixer requires automatic fixes and a valid agent; a stored reviewer without a profile stays valid', () => {
  const project = { checks: [] }, review = { mode: 'review', checkIds: [], reviewer };
  assert.deepEqual(validateWorkflow(review, project).reviewer, { agent: 'codex', profile: 'default', model: '', instructions: '' });
  assert.throws(() => validateWorkflow({ ...review, fixer: { agent: 'codex', profile: 'default', model: '' } }, project));
  assert.throws(() => validateWorkflow({ ...review, automation: { ...config, maxFixes: 0 }, fixer: { agent: 'codex', profile: 'default', model: '' } }, project));
  for (const fixer of [{}, { agent: 'other', profile: 'default', model: '' }, { agent: 'claude', profile: 'default', model: '' }, { agent: 'claude', model: '' }, { agent: 'codex', profile: 'default', model: '', extra: 1 }]) assert.throws(() => validateWorkflow({ ...review, automation: config, fixer }, project));
  for (const bad of [null, { agent: 'other', model: '', instructions: '' }, { agent: 'claude', model: '', instructions: '' }, { agent: 'claude', profile: 'subscription', model: '' }]) assert.throws(() => validateWorkflow({ ...review, reviewer: bad }, project));
  assert.throws(() => validateWorkflow({ mode: 'checked', checkIds: [], fixer: {} }, project));
});
test('old workflows never start automatic fixes', async () => {
  const h = harness({ disabled: true });
  try { await start(h); const a = await finish(h); assert.equal(h.execCount, 1); assert.equal(a.automation, undefined); assert.equal(a.cycles, undefined); }
  finally { await h.manager.shutdown(); }
});
test('bounded loops stop on limits, repeated findings and no file progress', async () => {
  for (const [options, expected] of [
    [{ config: { maxFixes: 1 }, reports: [issue(), issue('Second')] }, /лимит автоматических/],
    [{ config: { maxFixes: 3 }, reports: [issue()] }, /повторились/],
    [{ reports: [issue()], fingerprint: ({ execCount }) => `snapshot-${Math.min(1, execCount)}` }, /файлы не изменились/]
  ]) {
    const h = harness(options);
    try { await start(h); const a = await finish(h); assert.equal(h.execCount, 2); assert.equal(a.status, 'требуется решение'); assert.match(a.automation.reason, expected); }
    finally { await h.manager.shutdown(); }
  }
});
test('incomplete review, disabled trigger and changed configuration require a human', async () => {
  for (const [options, reason] of [
    [{ reports: [{ ...pass, verdict: 'inconclusive', criteria: [{ ...pass.criteria[0], status: 'unknown' }] }] }, /Ревью неполное/],
    [{ checks: true, reports: [pass], config: { fixChecks: false } }, /не входят/],
    [{ onReview: state => { state.profiles.changed = true; } }, /Настройки/],
    [{ fingerprint: ({ execCount, captures }) => captures === 5 ? 'external-change' : `snapshot-${execCount}` }, /между проходами/]
  ]) {
    const h = harness(options);
    try { await start(h); const a = await finish(h); assert.equal(h.execCount, 1); assert.match(a.automation.reason, reason); assert.equal(a.status, 'требуется решение'); }
    finally { await h.manager.shutdown(); }
  }
});
test('checks and review share one final comparison, which marks both stale when files changed', async () => {
  const quiet = harness({ checks: true, disabled: true, reports: [pass] });
  try {
    await start(quiet); const a = await finish(quiet);
    assert.equal(quiet.captures, 4, 'preview, start, after the agent, after the review');
    assert.equal(a.checkRuns[0].validity, 'совпадает'); assert.equal(a.reviewRun.validity, 'совпадает');
  } finally { await quiet.manager.shutdown(); }
  const changed = harness({ checks: true, disabled: true, reports: [pass], fingerprint: ({ captures }) => captures >= 4 ? 'changed' : 'same' });
  try {
    await start(changed); const a = await finish(changed);
    assert.equal(a.checkRuns[0].validity, 'устарели'); assert.equal(a.checks, 'устарели');
    assert.equal(a.review, 'устарело'); assert.equal(a.status, 'требуется решение');
  } finally { await changed.manager.shutdown(); }
});
test('hold finishes the current pass without starting a new fix', async () => {
  const h = harness({ stageDelay: 60 });
  try { await start(h); await until(() => h.reviewCount === 1); await h.manager.hold('t'); const a = await finish(h);
    assert.equal(h.execCount, 1); assert.equal(a.review, 'есть замечания'); assert.equal(a.automation.stopAfterPass, true); assert.match(a.automation.reason, /по запросу пользователя/);
  } finally { await h.manager.shutdown(); }
});
test('hold while the next pass is being saved wins before any new process launches', async () => {
  let unblock, waiting = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const h = harness({ beforeSave: async next => { if (next.attempts[0]?.automation?.pendingFix && !next.attempts[0].automation.stopAfterPass) { waiting = true; await gate; } } });
  try {
    await start(h); await until(() => waiting); const hold = h.manager.hold('t'); unblock(); await hold;
    const a = await finish(h); assert.equal(h.execCount, 1); assert.equal(a.sessionId, sid); assert.match(a.output, /Answer 1/); assert.match(a.automation.reason, /по запросу пользователя/);
  } finally { unblock(); await h.manager.shutdown(); }
});
test('a failed boundary save blocks new processes and further launches', async () => {
  const h = harness({ beforeSave: next => { if (next.attempts[0]?.automation?.pendingFix) throw new Error('disk'); } });
  try { await start(h); const a = await finish(h); assert.equal(h.execCount, 1); assert.equal(a.status, 'ошибка'); await assert.rejects(h.manager.prepare('t'), /перезапуска/); }
  finally { await h.manager.shutdown(); }
});
test('global time budget interrupts a sequence of individually short stages', async () => {
  const h = harness({ stageDelay: 250, budgetMs: 450 });
  try { await start(h); const a = await finish(h); assert.equal(a.status, 'прервана'); assert.match(a.automation.reason, /общий лимит/); assert.equal(h.execCount, 1); assert.equal(h.reviewCount, 1); }
  finally { await h.manager.shutdown(); }
});
test('cancellation in an automatic fix retains the lock until the child exits', async () => {
  const h = harness({ pauseExecutorAt: 2 });
  try { await start(h); await until(() => h.execCount === 2); await assert.rejects(h.manager.prepare('t'), /активная попытка/); await h.manager.cancel('t');
    const a = await finish(h); assert.equal(a.status, 'отменена'); assert.equal(h.reviewCount, 1); assert.match(a.automation.reason, /отмена пользователем/);
  } finally { await h.manager.shutdown(); }
});
test('a resumed session mismatch never proceeds to checks or review and never adopts the other session', async () => {
  const h = harness({ wrongResume: true });
  try { await start(h); const a = await finish(h); assert.equal(h.execCount, 2); assert.equal(h.reviewCount, 1); assert.equal(a.status, 'ошибка'); assert.equal(a.sessionId, sid); }
  finally { await h.manager.shutdown(); }
});
test('a failed or stopped automatic fix leaves the executor session available to continue', async () => {
  const h = harness({ pauseExecutorAt: 2 });
  try {
    await start(h); await until(() => h.execCount === 2); await h.manager.cancel('t');
    const a = await finish(h); assert.equal(a.status, 'отменена'); assert.equal(a.sessionId, sid);
    assert.equal((await h.manager.prepare('t', 'продолжай')).resumeSessionId, sid);
  } finally { await h.manager.shutdown(); }
});
