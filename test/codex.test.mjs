import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs, codexStream } from '../src/codex.mjs';
import { validateAgent } from '../src/agents.mjs';
const id = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
const events = [{ type: 'thread.started', thread_id: id }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Result' } }, { type: 'turn.completed', usage: {} }];
function parse(items, code = 0) {
  let output = ''; const parser = codexStream(value => { output += value; });
  const text = items.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n');
  for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7));
  return { status: parser.finish(code), session: parser.sessionId(), final: parser.finalText(), output };
}
test('Codex parses fragmented JSONL and fails closed on malformed or incomplete turns', () => {
  assert.deepEqual(parse(events), { status: 'выполнение завершено', session: id, final: 'Result', output: 'Result\n' });
  for (const input of [[], events.slice(0, -1), [...events, events.at(-1)], [...events, 'garbage'], [...events, { type: 'turn.failed' }], events.slice(1), events.filter(e => e.type !== 'item.completed')]) {
    assert.equal(parse(input).status, 'ошибка');
  }
  assert.equal(parse(events, 1).status, 'ошибка');
});
test('Codex usage separates the cached part of the input and names no model or price', () => {
  const parser = codexStream(() => {});
  assert.deepEqual(parser.usage().models, [], 'nothing is invented before the turn ends');
  parser.push(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 7 } })}\n`);
  assert.deepEqual(parser.usage().models, [{ model: '', input: 70, output: 7, cacheRead: 30, cacheWrite: 0, costUsd: null }]);
});
test('Codex executor and reviewer preserve sandbox boundaries and exact session ID', () => {
  assert.deepEqual(codexArgs(), ['-a', 'never', 'exec', '--sandbox', 'workspace-write', '--json', '--color', 'never', '-']);
  const review = codexArgs({ readOnly: true, schemaPath: 'C:/schema.json', model: 'test-model' });
  assert.ok(review.includes('read-only')); assert.ok(review.includes('--ephemeral')); assert.ok(review.includes('--output-schema'));
  assert.ok(!review.some(a => a.includes('dangerously') || a === '--approve-for-me'));
  const resume = codexArgs({ resumeSessionId: id }); assert.ok(resume.includes(id)); assert.ok(resume.includes('workspace-write')); assert.ok(!resume.includes('--last'));
  assert.throws(() => codexArgs({ resumeSessionId: '--last' }));
  for (const args of [['codex', 'subscription'], ['claude', 'default'], ['unknown', 'default'], ['codex', 'default', '--dangerously-bypass-approvals-and-sandbox']]) assert.throws(() => validateAgent(...args));
});
