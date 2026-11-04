import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeStream } from '../src/claude.mjs';

const assistant = (text, extra = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
const result = text => ({ type: 'result', subtype: 'success', is_error: false, result: text });
function parse(events) {
  let output = '';
  const parser = claudeStream(chunk => { output += chunk; });
  const stream = events.map(event => JSON.stringify(event)).join('\n');
  for (let offset = 0; offset < stream.length; offset += 7) parser.push(stream.slice(offset, offset + 7));
  return { status: parser.finish(0), output };
}

test('final result does not duplicate the assistant clarification response', () => {
  const answer = 'Уточните, пожалуйста, что нужно изменить.\n\nИзменений не вносил.';
  assert.deepEqual(parse([assistant(answer), result(answer)]), { status: 'выполнение завершено', output: answer + '\n' });
});

test('result-only and different final responses are retained', () => {
  assert.equal(parse([result('Final answer')]).output, 'Final answer\n');
  assert.equal(parse([assistant('Working'), result('Different final answer')]).output, 'Working\nDifferent final answer\n');
});

test('intentional repeated assistant messages survive while their final echo is removed', () => {
  assert.equal(parse([assistant('Repeat'), assistant('Repeat'), result('Repeat')]).output, 'Repeat\nRepeat\n');
});

test('multi-block final echoes and subagent messages are handled separately', () => {
  const multi = { type: 'assistant', message: { content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] } };
  assert.equal(parse([multi, result('First\nSecond')]).output, 'First\nSecond\n');
  assert.equal(parse([assistant('Main'), assistant('Subagent', { parent_tool_use_id: 'tool-1' }), result('Main')]).output, 'Main\nSubagent\n');
  assert.equal(parse([assistant('Subagent', { parent_tool_use_id: 'tool-1' }), result('Final')]).output, 'Subagent\nFinal\n');
});

test('a stopped turn knows its session from init, and the final result has the last word', () => {
  const id = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  const init = session_id => JSON.stringify({ type: 'system', subtype: 'init', session_id }) + '\n';
  const stopped = claudeStream(() => {});
  stopped.push(init(id) + '{"type":"assistant","mess');
  assert.equal(stopped.sessionId(), id);
  assert.equal(stopped.finish(null), 'ошибка'); assert.equal(stopped.sessionId(), undefined);
  const invalid = claudeStream(() => {});
  invalid.push(init('../another-session')); assert.equal(invalid.sessionId(), undefined);
  const contradicted = claudeStream(() => {});
  contradicted.push(init(id) + JSON.stringify({ ...result('done'), session_id: 'not-a-session' }));
  contradicted.finish(0); assert.equal(contradicted.sessionId(), undefined);
});

test('only a valid session from the final result can be resumed', () => {
  const id = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  for (const candidate of [id, '--dangerously-skip-permissions', '../another-session', '', null]) {
    const parser = claudeStream(() => {});
    parser.push(JSON.stringify({ ...result('done'), session_id: candidate }));
    parser.finish(0);
    assert.equal(parser.sessionId(), candidate === id ? id : undefined);
  }
  const parser = claudeStream(() => {});
  parser.push(JSON.stringify({ ...result('done'), session_id: id }) + '\nnot-json');
  assert.equal(parser.finish(0), 'ошибка'); assert.equal(parser.sessionId(), undefined);
});
