import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeStream } from '../src/claude.mjs';
import { createUsageLedger, mergeModels, summarizeUsage } from '../src/usage.mjs';

const model = (name, extra = {}) => ({ model: name, input: 10, output: 5, cacheRead: 100, cacheWrite: 20, costUsd: null, ...extra });
const entry = (fields = {}) => ({ at: '2026-11-04T10:00:00Z', taskId: 't1', kind: 'worker', agentId: 'claude-subscription', label: 'Claude · подписка', profile: 'subscription', models: [model('opus', { costUsd: 1 })], ...fields });
const push = (parser, ...events) => { for (const event of events) parser.push(`${JSON.stringify(event)}\n`); };

test('Claude totals come from the final event, per model, as the CLI really sends them', () => {
  const parser = claudeStream(() => {});
  push(parser, { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' },
    { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.3, usage: { input_tokens: 1 }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 649, cacheCreationInputTokens: 3330, costUSD: 0.1 }, 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 0.2 } } });
  const { models, partial } = parser.usage();
  assert.equal(partial, false);
  assert.deepEqual(models[0], { model: 'claude-haiku-5-5', input: 2, output: 4, cacheRead: 649, cacheWrite: 3330, costUsd: 0.1 });
  assert.equal(models[1].cacheRead, 0, 'a missing counter is zero, not undefined');
});

test('a stopped Claude process still reports what its messages used, marked as partial', () => {
  const parser = claudeStream(() => {});
  const message = (id, output) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', content: [], usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } } });
  push(parser, message('m1', 1), message('m1', 8), message('m2', 2));
  assert.deepEqual(parser.usage(), { models: [{ model: 'claude-opus-5-5', input: 20, output: 10, cacheRead: 10, cacheWrite: 2, costUsd: null }], partial: true, limits: null });
});

test('subscription windows are read from the rate limit event, and odd values are dropped', () => {
  const parser = claudeStream(() => {});
  push(parser, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.41, resetsAt: 1793815200 }, seven_day: { utilization: 3 }, broken: { utilization: 'много' } } } });
  const { windows } = parser.usage().limits;
  assert.deepEqual(windows, [{ name: 'five_hour', utilization: 0.41, resetsAt: new Date(1793815200000).toISOString() }, { name: 'seven_day', utilization: 1, resetsAt: null }]);
  const none = claudeStream(() => {});
  push(none, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(none.usage().limits, null);
});

test('the ledger survives a torn line and keeps entries in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-orchestrator-usage-'));
  try {
    const ledger = createUsageLedger(join(dir, 'usage.jsonl'));
    assert.deepEqual(await ledger.read(), [], 'no file yet is an empty history');
    void ledger.append(entry({ taskId: 'a' })); await ledger.append(entry({ taskId: 'b' }));
    await appendFile(join(dir, 'usage.jsonl'), '{"at":"2026');
    assert.deepEqual((await ledger.read()).map(item => item.taskId), ['a', 'b']);
    assert.equal(ledger.failed(), false);
    const broken = createUsageLedger(join(dir, 'missing', 'usage.jsonl'));
    await broken.append(entry());
    assert.equal(broken.failed(), true, 'a failed write is known, and does not throw into the run');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the summary groups by agent, model, role and task, within the period', () => {
  const entries = [
    entry({ at: '2026-10-01T00:00:00Z', taskId: 'old' }),
    entry({ kind: 'supervisor', models: [model('haiku', { costUsd: 0.5 })] }),
    entry({ agentId: 'claude-deepseek', label: 'Claude · DeepSeek', profile: 'deepseek', taskId: 'gone', models: [model('deepseek-chat'), model('opus')], partial: true }),
    entry({ limits: { observedAt: '2026-11-04T10:00:00Z', windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: null }] } })
  ];
  const report = summarizeUsage(entries, { from: '2026-11-01T00:00:00Z', tasks: [{ id: 't1', title: 'Задача', projectId: 'p' }] });
  assert.equal(report.totals.runs, 3); assert.equal(report.totals.partial, 1); assert.equal(report.totals.costUsd, 1.5);
  assert.equal(report.firstAt, '2026-10-01T00:00:00Z');
  assert.equal(report.agents.find(item => item.id === 'claude-deepseek').costUsd, null, 'no price is made up');
  assert.deepEqual(report.models.map(item => item.model).sort(), ['deepseek-chat', 'haiku', 'opus']);
  assert.equal(report.roles.find(item => item.kind === 'supervisor').runs, 1);
  assert.equal(report.tasks.some(item => item.taskId === 'old'), false);
  assert.equal(report.tasks.find(item => item.taskId === 'gone').title, null, 'a deleted task keeps its numbers, not its name');
  assert.equal(report.tasks.find(item => item.taskId === 't1').title, 'Задача');
  assert.equal(report.limits.length, 1);
  assert.equal(summarizeUsage(entries, { from: '2030-01-01T00:00:00Z' }).limits.length, 1, 'limits do not depend on the period');
  assert.equal(summarizeUsage(entries).totals.runs, 4);
});

test('merging keeps one line per model and an unknown price stays unknown', () => {
  const merged = mergeModels([model('a')], [model('a'), model('b', { costUsd: 2 })]);
  assert.equal(merged.length, 2); assert.equal(merged[0].input, 20); assert.equal(merged[0].costUsd, null); assert.equal(merged[1].costUsd, 2);
});
