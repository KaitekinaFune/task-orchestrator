import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createAttempts } from '../src/attempts.mjs';
import { validateGraph, memberOutcome } from '../src/graph.mjs';
import { parseReview } from '../src/review.mjs';
import { validateWorkflow, workflowPlan } from '../src/workflows.mjs';
import { validatePreset, presetCheckIds, projectWorkflow } from '../src/presets.mjs';

const sid = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff', fixerSid = 'a4a4d998-3c62-4c1f-bd0e-56661f1471ff';
const limits = { maxLoops: 2, timeBudgetMinutes: 30 };
const role = (id, name, extra = {}) => ({ id, name, agent: 'codex', profile: 'default', model: '', instructions: '', blocking: true, blockAt: 'P1', ...extra });
const pass = { summary: 'Хорошо', verdict: 'pass', findings: [], criteria: [{ criterion: 'Работает', status: 'met', evidence: 'Проверено' }], limitations: [] };
const finding = (severity = 'P1', title = 'Ошибка') => ({ summary: title, verdict: 'changes_requested', findings: [{ severity, title, file: 'a.mjs', line: 1, evidence: 'Контрпример' }], criteria: [{ criterion: 'Работает', status: 'met', evidence: 'Проверено' }], limitations: [] });
const wire = text => [{ type: 'thread.started', thread_id: sid }, { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }].map(x => JSON.stringify(x)).join('\n');
const processFor = (text, forever = false) => spawn(process.execPath, ['-e', forever ? 'setInterval(()=>{},1000)' : `process.stdout.write(${JSON.stringify(text)})`], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
const graphOf = (nodes, start = nodes[0].id, extra = {}) => ({ start, limits: { ...limits, ...extra }, nodes });
const executor = next => ({ id: 'exec', name: 'Исполнитель', kind: 'executor', next });
const reviewNode = (members, next) => ({ id: 'review', name: 'Ревью', kind: 'review', members, next });
const checksNode = next => ({ id: 'checks', name: 'Проверки', kind: 'checks', next });

function harness(graph, { reports = {}, checkCodes = [], answers = {}, fingerprint, forever = () => false, writerSession, onCapture, checkIds, state: shared } = {}) {
  const check = { id: 'build', name: 'Сборка', executable: process.execPath, args: ['-e', ''], timeoutSeconds: 10 };
  let state = shared || { profiles: {}, projects: [{ id: 'p', path: process.cwd(), checks: [check] }], tasks: [{ id: 't', projectId: 'p', title: 'Сделать', description: 'Сделать хорошо', criteria: 'Работает', profile: 'subscription', workflow: { mode: 'graph', checkIds: checkIds ?? (graph.nodes.some(n => n.kind === 'checks') ? ['build'] : []), graph } }], attempts: [] };
  let writes = Promise.resolve(), execCount = 0, checkCount = 0;
  const calls = [], running = [], reviewCounts = {};
  const manager = createAttempts({ getState: () => state,
    mutate: change => { const op = writes.then(() => { const next = structuredClone(state); change(next); state = next; }); writes = op.catch(() => {}); return op; },
    environmentFor: async (profile, agent) => { calls.push({ role: 'environment', profile, agent }); return { environment: process.env, secrets: [] }; },
    capture: async () => {
      if (onCapture) await onCapture({ execCount });
      return { path: process.cwd(), fingerprint: fingerprint ? fingerprint({ execCount }) : `files-${execCount}`, head: harnessHead.value, branch: 'main', clean: true, changes: [] };
    },
    launch: input => { execCount++; calls.push({ kind: 'write', ...input });
      const child = processFor(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: input.profile === 'litellm' ? fixerSid : writerSession ?? sid, result: `Ответ ${execCount}` }) + '\n', forever('write', execCount));
      running.push(child); return child; },
    reviewerLaunch: input => {
      const name = /в роли «([^»]+)»/.exec(input.prompt)?.[1];
      calls.push({ kind: input.schemaPath ? 'review' : 'read', name, ...input });
      reviewCounts[name] = (reviewCounts[name] || 0) + 1;
      const list = reports[name] || [pass], report = list[Math.min(reviewCounts[name] - 1, list.length - 1)];
      const child = processFor(wire(input.schemaPath ? (typeof report === 'string' ? report : JSON.stringify(report)) : answers[name] || `Ответ роли ${name}`), forever('read', name));
      running.push(child); return child; },
    checkLaunch: () => { const code = checkCodes[Math.min(checkCount++, Math.max(checkCodes.length - 1, 0))] ?? 0; return spawn(process.execPath, ['-e', `process.exit(${code})`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  });
  return { manager, calls, running, get state() { return state; }, get execCount() { return execCount; }, get checkCount() { return checkCount; }, writes: () => calls.filter(c => c.kind === 'write'), reviews: name => calls.filter(c => c.kind === 'review' && c.name === name) };
}
const harnessHead = { value: 'head' };
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); } throw new Error('Condition not reached'); }
async function start(h, message) { const p = await h.manager.prepare('t', message); await h.manager.start('t', p.previewId, true); }
async function finish(h) { await until(() => { const a = h.manager.list('t').at(-1); return a?.endedAt && !a.active; }); return h.manager.list('t').at(-1); }
const stepStatuses = a => a.graphRun.steps.map(s => `${s.name}:${s.status}`);

test('a graph is validated: reachable steps, one executor, productive cycles, finite limits', () => {
  const good = graphOf([executor({ success: 'checks' }), checksNode({ failure: 'exec' })]);
  assert.equal(validateGraph(good).nodes.length, 2);
  const cases = [
    { ...good, limits: { maxLoops: 6, timeBudgetMinutes: 30 } },
    { ...good, limits: { maxLoops: 1, timeBudgetMinutes: 1 } },
    { ...good, limits: undefined },
    { ...good, start: 'missing' },
    { ...good, nodes: [checksNode()] },
    { ...good, nodes: [executor(), { ...executor(), id: 'second' }] },
    { ...good, nodes: [executor(), checksNode()] },
    graphOf([executor({ success: 'missing' })]),
    graphOf([executor({ success: 'checks' }), checksNode({ failure: 'end' })]),
    graphOf([{ ...executor(), next: { failure: 'exec' } }]),
    graphOf([executor({ success: 'checks' }), checksNode({ failure: 'checks' })]),
    graphOf([executor({ success: 'review' }), reviewNode([role('a', 'А')], { failure: 'checks' }), checksNode({ failure: 'review' })]),
    graphOf([executor({ success: 'review' }), reviewNode([])]),
    graphOf([executor({ success: 'review' }), reviewNode([role('a', 'А'), role('a', 'Б')])]),
    graphOf([executor({ success: 'review' }), reviewNode(['a', 'b', 'c', 'd', 'e'].map(id => role(id, id)))]),
    graphOf([executor({ success: 'review' }), reviewNode([role('a', 'А', { blockAt: 'P9' })])]),
    graphOf([executor({ success: 'read' }), { id: 'read', name: 'Р', kind: 'read', agent: 'gpt', profile: 'default', model: '' }]),
    graphOf([{ ...executor(), command: 'rm -rf /' }])
  ];
  for (const value of cases) assert.throws(() => validateGraph(value), undefined, JSON.stringify(value).slice(0, 120));
  // A cycle through a person is productive: the rejection comment changes what the next step sees.
  assert.ok(validateGraph(graphOf([{ id: 'read', name: 'Дизайнер', kind: 'read', agent: 'codex', profile: 'default', model: '', next: { success: 'ok' } }, { id: 'ok', name: 'Подтвердить', kind: 'human', next: { success: 'exec', failure: 'read' } }, executor()])));
});

test('simple modes know nothing of the graph, and a process without a checks step asks for no checks', () => {
  assert.deepEqual(validateWorkflow({ mode: 'quick', checkIds: [] }), { mode: 'quick', checkIds: [] });
  assert.throws(() => validateWorkflow({ mode: 'quick', checkIds: [], graph: graphOf([executor()]) }));
  const noChecks = graphOf([executor()]), withChecks = graphOf([executor({ success: 'checks' }), checksNode()]);
  assert.throws(() => validateWorkflow({ mode: 'graph', checkIds: ['x'], graph: noChecks }));
  assert.throws(() => validateWorkflow({ mode: 'graph', checkIds: [], graph: noChecks, reviewer: {} }));
  const project = { checks: [{ id: 'build', name: 'Сборка', executable: 'x', args: [], timeoutSeconds: 5 }] };
  assert.throws(() => validateWorkflow({ mode: 'graph', checkIds: [], graph: withChecks }, project), /проверок/);
  const preset = id => ({ id, name: 'Граф', workflow: { mode: 'graph', graph: id === 'a' ? noChecks : withChecks } });
  assert.deepEqual(presetCheckIds(preset('a'), project), []); assert.deepEqual(presetCheckIds(preset('b'), project), ['build']);
  assert.throws(() => projectWorkflow(preset('b'), { checks: [] }), /проверки/);
  assert.equal(workflowPlan({ workflow: { mode: 'graph', checkIds: [], graph: noChecks } }, project).review, 'не запрошено');
  assert.equal(validatePreset({ name: 'Граф', profile: 'subscription', instructions: '', workflow: { mode: 'graph', graph: noChecks } }).workflow.graph.nodes.length, 1);
});

test('findings without a place are valid, and each role judges by its own threshold', () => {
  const general = { ...finding('P1', 'Объём велик'), findings: [{ severity: 'P1', title: 'Объём велик', file: null, line: null, evidence: 'Три системы за этап' }] };
  assert.deepEqual(parseReview(JSON.stringify(general)), general);
  assert.throws(() => parseReview(JSON.stringify({ ...general, findings: [{ ...general.findings[0], line: 3 }] })));
  const blocking = { blocking: true, blockAt: 'P1' };
  assert.equal(memberOutcome(blocking, pass), 'success');
  assert.equal(memberOutcome(blocking, finding('P3')), 'success');
  assert.equal(memberOutcome(blocking, finding('P1')), 'failure');
  assert.equal(memberOutcome({ blocking: true, blockAt: 'P3' }, finding('P3')), 'failure');
  assert.equal(memberOutcome({ blocking: false, blockAt: 'P0' }, finding('P0')), 'advisory');
  assert.equal(memberOutcome(blocking, { ...pass, verdict: 'inconclusive' }), 'unclear');
  assert.equal(memberOutcome(blocking, { ...pass, criteria: [{ criterion: 'Работает', status: 'unmet', evidence: 'Нет' }], verdict: 'changes_requested' }), 'failure');
});

test('the full route: role prepares, a person approves, checks fail and return, roles review in parallel', async () => {
  const graph = graphOf([
    { id: 'designer', name: 'Гейм-дизайнер', kind: 'read', agent: 'codex', profile: 'default', model: 'design-model', instructions: 'Уточни баланс', next: { success: 'approve' } },
    { id: 'approve', name: 'Подтвердить план', kind: 'human', next: { success: 'exec' } },
    executor({ success: 'checks' }),
    checksNode({ success: 'review', failure: 'exec' }),
    reviewNode([role('code', 'Ревью кода'), role('prod', 'Продюсер', { blocking: false })], { failure: 'exec' })
  ]);
  const h = harness(graph, { checkCodes: [7, 0], reports: { 'Продюсер': [finding('P0', 'Срок сорван')] }, answers: { 'Гейм-дизайнер': 'План: баланс 1.5' } });
  try {
    await start(h);
    let a = await finish(h);
    assert.equal(a.status, 'ждёт решения'); assert.equal(h.execCount, 0); assert.equal(a.graphRun.waiting.nodeId, 'approve');
    assert.equal(h.manager.holds(['t']), false, 'a waiting process holds no lock');
    assert.equal(h.calls.find(c => c.kind === 'read').model, 'design-model'); assert.equal(h.calls.find(c => c.kind === 'read').readOnly, true);
    await assert.rejects(h.manager.prepareChecks('t', a.id), /ждёт решения/);

    await h.manager.decide('t', a.id, true, 'Баланс утверждаю');
    a = await finish(h);
    assert.equal(a.status, 'готова к рассмотрению', a.automation.reason);
    assert.equal(h.execCount, 2, 'the failed check returned to the executor once');
    const [first, second] = h.writes();
    assert.equal(first.resumeSessionId, undefined); assert.match(first.prompt, /Сделать хорошо/); assert.match(first.prompt, /баланс 1\.5/); assert.match(first.prompt, /Баланс утверждаю/);
    assert.equal(second.resumeSessionId, sid); assert.match(second.prompt, /недоверенные данные/);
    assert.equal(a.checkRuns.length, 2); assert.equal(a.checkRuns[0].results[0].exitCode, 7);
    assert.equal(a.sessionId, sid); assert.match(a.output, /Ответ 2/);
    // An advisory opinion is on record but neither blocks nor reaches the code.
    assert.equal(a.review, 'пройдено');
    const producer = a.graphRun.steps.find(s => s.memberId === 'prod');
    assert.equal(producer.outcome, 'advisory'); assert.equal(producer.result.findings[0].title, 'Срок сорван');
    assert.ok(!h.writes().some(c => /Срок сорван/.test(c.prompt)));
    assert.deepEqual(a.graphRun.steps.map(s => s.name), ['Гейм-дизайнер', 'Подтвердить план', 'Исполнитель', 'Проверки', 'Исполнитель', 'Проверки', 'Ревью кода', 'Продюсер']);
    assert.equal(a.graphRun.steps[1].status, 'подтверждено');
  } finally { await h.manager.shutdown(); }
});

test('a separate writer keeps its own session, and the user continues only the executor', async () => {
  const graph = graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')], { failure: 'fixer' }), { id: 'fixer', name: 'Исправления', kind: 'write', agent: 'claude', profile: 'litellm', model: 'fix-model', instructions: 'Только минимальные правки', next: { success: 'review' } }]);
  const h = harness(graph, { reports: { 'Ревью кода': [finding('P1', 'Первая'), finding('P1', 'Вторая'), pass] } });
  try {
    await start(h); const a = await finish(h);
    assert.equal(a.status, 'готова к рассмотрению', a.automation.reason);
    const [first, second, third] = h.writes();
    assert.equal(first.profile, 'subscription'); assert.equal(second.profile, 'litellm'); assert.equal(second.model, 'fix-model');
    assert.equal(second.resumeSessionId, undefined); assert.match(second.prompt, /Первая/); assert.match(second.prompt, /Только минимальные правки/); assert.match(second.prompt, /Сделать хорошо/);
    assert.equal(third.resumeSessionId, fixerSid); assert.match(third.prompt, /Вторая/);
    assert.equal(a.sessionId, sid); assert.equal(a.graphRun.sessions.fixer, fixerSid);
    assert.equal((await h.manager.prepare('t', 'Ещё')).resumeSessionId, sid);
  } finally { await h.manager.shutdown(); }
});

test('a P3 nit does not spend fixes, while repeated and alternating problems stop the loop', async () => {
  const route = () => graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')], { failure: 'exec' })], 'exec', { maxLoops: 5 });
  const nit = harness(route(), { reports: { 'Ревью кода': [finding('P3', 'Пробел')] } });
  try {
    await start(nit); const a = await finish(nit);
    assert.equal(nit.execCount, 1); assert.equal(a.status, 'готова к рассмотрению', a.automation.reason);
    assert.equal(a.graphRun.steps.at(-1).status, 'замечания ниже порога');
  } finally { await nit.manager.shutdown(); }
  const alternating = harness(route(), { reports: { 'Ревью кода': [finding('P1', 'А'), finding('P1', 'Б'), finding('P1', 'А')] } });
  try {
    await start(alternating); const a = await finish(alternating);
    assert.equal(alternating.execCount, 3); assert.equal(a.status, 'требуется решение'); assert.match(a.automation.reason, /те же замечания/);
  } finally { await alternating.manager.shutdown(); }
});

test('limits and absence of progress stop a loop for the user', async () => {
  const route = extra => graphOf([executor({ success: 'checks' }), checksNode({ failure: 'exec' })], 'exec', extra);
  const unchanged = harness(route({ maxLoops: 5 }), { checkCodes: [7], fingerprint: () => 'same' });
  try {
    await start(unchanged); const a = await finish(unchanged);
    assert.equal(unchanged.execCount, 2); assert.equal(a.status, 'требуется решение'); assert.match(a.automation.reason, /файлы не изменились/);
  } finally { await unchanged.manager.shutdown(); }
  // Each failure must look different here, or the repeated-problem rule would stop first.
  const reviewRoute = graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')], { failure: 'exec' })], 'exec', { maxLoops: 1 });
  const limited = harness(reviewRoute, { reports: { 'Ревью кода': ['А', 'Б', 'В', 'Г'].map(title => finding('P1', title)) } });
  try {
    await start(limited); const a = await finish(limited);
    assert.equal(limited.execCount, 2); assert.equal(a.status, 'требуется решение'); assert.match(a.automation.reason, /лимит повторов/);
  } finally { await limited.manager.shutdown(); }
});

test('an unusable report or a missing route goes to the user, never onward', async () => {
  const unusable = harness(graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')], { success: 'after', failure: 'exec' }), { id: 'after', name: 'Дальше', kind: 'read', agent: 'codex', profile: 'default', model: '' }]), { reports: { 'Ревью кода': ['это не отчёт'] } });
  try {
    await start(unusable); const a = await finish(unusable);
    assert.equal(a.status, 'требуется решение'); assert.equal(unusable.execCount, 1); assert.match(a.automation.reason, /надёжного результата/);
    assert.equal(a.graphRun.steps.at(-1).status, 'ошибка'); assert.equal(a.review, 'неполное');
  } finally { await unusable.manager.shutdown(); }
  const noRoute = harness(graphOf([executor({ success: 'checks' }), checksNode()]), { checkCodes: [3] });
  try {
    await start(noRoute); const a = await finish(noRoute);
    assert.equal(a.status, 'требуется решение'); assert.match(a.automation.reason, /переход для них не задан/);
  } finally { await noRoute.manager.shutdown(); }
});

test('only results for the final files count: nothing checked is not called ready', async () => {
  const bare = harness(graphOf([executor()]));
  try { await start(bare); const a = await finish(bare); assert.equal(a.status, 'выполнение завершено'); assert.equal(a.checks, 'не запрошены'); assert.equal(a.review, 'не запрошено'); }
  finally { await bare.manager.shutdown(); }
  const reviewThenWrite = graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')], { success: 'polish' }), { id: 'polish', name: 'Полировка', kind: 'write', agent: 'claude', profile: 'litellm', model: '' }]);
  const stale = harness(reviewThenWrite);
  try {
    await start(stale); const a = await finish(stale);
    assert.equal(stale.execCount, 2); assert.equal(a.status, 'требуется решение'); assert.match(a.automation.reason, /устарело/); assert.equal(a.review, 'устарело');
  } finally { await stale.manager.shutdown(); }
  let edited = false;
  const external = harness(graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')])]), { fingerprint: () => edited ? 'edited' : 'same', onCapture: () => {} });
  try {
    await start(external); await until(() => external.reviews('Ревью кода').length); edited = true;
    const a = await finish(external);
    assert.equal(a.status, 'требуется решение'); assert.equal(a.graphRun.steps.at(-1).validity, 'устарели');
  } finally { await external.manager.shutdown(); }
});

test('a rejection carries its comment back, or ends with the user when no route is given', async () => {
  const designer = { id: 'designer', name: 'Гейм-дизайнер', kind: 'read', agent: 'codex', profile: 'default', model: '', next: { success: 'approve' } };
  const back = harness(graphOf([designer, { id: 'approve', name: 'Подтвердить', kind: 'human', next: { success: 'exec', failure: 'designer' } }, executor()]));
  try {
    await start(back); let a = await finish(back);
    await back.manager.decide('t', a.id, false, 'Баланс слишком резкий');
    await until(() => back.calls.filter(c => c.kind === 'read').length === 2 && back.manager.list('t').at(-1).status === 'ждёт решения');
    assert.match(back.calls.filter(c => c.kind === 'read')[1].prompt, /Баланс слишком резкий/);
    a = back.manager.list('t').at(-1);
    await back.manager.decide('t', a.id, true); a = await finish(back);
    assert.equal(a.status, 'выполнение завершено'); assert.equal(back.execCount, 1);
  } finally { await back.manager.shutdown(); }
  const dead = harness(graphOf([{ id: 'approve', name: 'Подтвердить', kind: 'human', next: { success: 'exec' } }, executor()]));
  try {
    await start(dead); const a = await finish(dead);
    await dead.manager.decide('t', a.id, false);
    const last = dead.manager.list('t').at(-1);
    assert.equal(last.status, 'требуется решение'); assert.equal(dead.execCount, 0); assert.ok(last.endedAt);
    await assert.rejects(dead.manager.decide('t', a.id, true), /не ждёт/);
  } finally { await dead.manager.shutdown(); }
});

test('a wait survives a restart and refuses a moved branch or changed settings', async () => {
  const graph = graphOf([{ id: 'approve', name: 'Подтвердить', kind: 'human', next: { success: 'exec' } }, executor()]);
  const before = harness(graph);
  try {
    await start(before); const waiting = await finish(before);
    await before.manager.shutdown();
    const after = harness(graph, { state: before.state });
    try {
      assert.equal(after.manager.list('t').at(-1).status, 'ждёт решения');
      harnessHead.value = 'moved';
      await assert.rejects(after.manager.decide('t', waiting.id, true), /HEAD изменились/);
      harnessHead.value = 'head';
      assert.equal(after.manager.list('t').at(-1).graphRun.waiting.nodeId, 'approve', 'a refused decision leaves the wait as it was');
      await assert.rejects(after.manager.decide('t', waiting.id, 'да'), /решение/);
      await after.manager.decide('t', waiting.id, true);
      const done = await finish(after); assert.equal(after.execCount, 1); assert.equal(done.status, 'выполнение завершено');
    } finally { await after.manager.shutdown(); }
  } finally { harnessHead.value = 'head'; }
  const changed = harness(graph);
  try {
    await start(changed); const waiting = await finish(changed);
    changed.state.profiles.liteSettings = { ANTHROPIC_MODEL: 'другая' };
    await assert.rejects(changed.manager.decide('t', waiting.id, true), /Настройки/);
  } finally { await changed.manager.shutdown(); }
});

test('stopping kills every parallel reviewer, and a follow-up enters at the executor', async () => {
  const graph = graphOf([executor({ success: 'review' }), reviewNode([role('a', 'Первая'), role('b', 'Вторая')])]);
  const h = harness(graph, { forever: kind => kind === 'read' });
  try {
    await start(h); await until(() => h.reviews('Первая').length && h.reviews('Вторая').length);
    await h.manager.cancel('t');
    const a = await finish(h);
    assert.equal(a.status, 'отменена'); assert.deepEqual(a.graphRun.steps.slice(1).map(s => s.status), ['прервано', 'прервано']);
    for (const child of h.running) assert.ok(child.exitCode !== null || child.signalCode !== null, 'no process is left running');
  } finally { await h.manager.shutdown(); }
  const designer = { id: 'designer', name: 'Гейм-дизайнер', kind: 'read', agent: 'codex', profile: 'default', model: '', next: { success: 'exec' } };
  const follow = harness(graphOf([designer, executor()]));
  try {
    await start(follow); const first = await finish(follow); assert.equal(follow.calls.filter(c => c.kind === 'read').length, 1);
    await start(follow, 'Поправь ещё'); const second = await finish(follow);
    assert.equal(follow.calls.filter(c => c.kind === 'read').length, 1, 'preparing steps do not run again');
    assert.equal(second.parentAttemptId, first.id); assert.equal(follow.writes()[1].resumeSessionId, sid); assert.match(follow.writes()[1].prompt, /Поправь ещё/);
  } finally { await follow.manager.shutdown(); }
});

test('hold finishes the current step and starts no repeat; a missing profile refuses the run before any work', async () => {
  const route = graphOf([executor({ success: 'checks' }), checksNode({ failure: 'exec' })]);
  const h = harness(route, { checkCodes: [7], forever: (kind, n) => kind === 'write' && n === 1 });
  try {
    await start(h); await until(() => h.execCount === 1);
    await h.manager.hold('t');
    assert.equal(h.manager.list('t').at(-1).automation.stopAfterPass, true);
    await h.manager.cancel('t'); await finish(h);
  } finally { await h.manager.shutdown(); }
  const held = harness(route, { checkCodes: [7] });
  try {
    await start(held); await held.manager.hold('t').catch(() => {});
    const a = await finish(held);
    assert.equal(held.execCount, 1); assert.match(a.automation.reason, /по запросу пользователя/);
  } finally { await held.manager.shutdown(); }
  let launched = 0;
  const state = { profiles: {}, projects: [{ id: 'p', path: process.cwd(), checks: [] }], tasks: [{ id: 't', projectId: 'p', title: 'T', description: 'D', criteria: 'C', profile: 'subscription', workflow: { mode: 'graph', checkIds: [], graph: graphOf([executor({ success: 'review' }), reviewNode([role('code', 'Ревью кода')])]) } }], attempts: [] };
  const refusing = createAttempts({ getState: () => state, mutate: async change => change(state),
    environmentFor: async (_, agent) => { if (agent === 'codex') throw new Error('no key'); return { environment: process.env, secrets: [] }; },
    capture: async () => ({ path: process.cwd(), fingerprint: 'x', head: 'h', branch: 'main', clean: true, changes: [] }), launch: () => { launched++; return processFor(''); } });
  try { const p = await refusing.prepare('t'); await assert.rejects(refusing.start('t', p.previewId, true), /Ревью кода/); assert.equal(launched, 0); }
  finally { await refusing.shutdown(); }
});
