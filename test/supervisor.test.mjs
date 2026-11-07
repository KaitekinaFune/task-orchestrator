import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evidence, finalStatus, parseAction, renderJournal, resolveAgent, supervisorPrompt, supervisorSchemaPath, validateSettings, defaultSettings, workerPrompt } from '../src/supervisor.mjs';
import { claudeArgs, claudeStream } from '../src/claude.mjs';
import { codexStream } from '../src/codex.mjs';

const run = (extra = {}) => ({ taskId: 't', roster: [resolveAgent({ id: 'claude-subscription', model: '' }), resolveAgent({ id: 'codex', model: 'gpt', note: 'для ревью' })], workers: [], checkRuns: [], journal: [], baseline: { fingerprint: 'a', clean: false, branch: 'main', changes: [{}] }, ...extra });
const project = { checks: [{ id: 'tests', name: 'Тесты', timeoutSeconds: 10 }] };

test('every field the schema requires exists, so strict structured-output modes accept it', async () => {
  const schema = JSON.parse(await readFile(supervisorSchemaPath, 'utf8'));
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  const worker = schema.properties.workers.items;
  assert.deepEqual([...worker.required].sort(), Object.keys(worker.properties).sort());
  assert.equal(schema.additionalProperties, false); assert.equal(worker.additionalProperties, false);
});

test('actions are validated before anything can run', () => {
  const parse = value => parseAction(JSON.stringify({ reason: 'r', ...value }), run(), project);
  assert.throws(() => parseAction('not json', run(), project), /JSON/);
  assert.throws(() => parse({ action: 'shell', command: 'rm' }), /Неизвестное действие/);
  assert.throws(() => parse({ action: 'run_workers', workers: [] }), /хотя бы один/);
  assert.throws(() => parse({ action: 'run_workers', workers: [{ agent: 'claude-subscription', access: 'write', prompt: 'a' }, { agent: 'codex', access: 'read', prompt: 'b' }] }), /только на чтение/);
  assert.throws(() => parse({ action: 'run_workers', workers: Array.from({ length: 5 }, () => ({ agent: 'codex', access: 'read', prompt: 'x' })) }), /Не больше/);
  assert.throws(() => parse({ action: 'run_workers', workers: [{ agent: 'claude-deepseek', access: 'read', prompt: 'x' }] }), /недоступен/);
  assert.throws(() => parse({ action: 'run_workers', workers: [{ agent: 'codex', access: 'admin', prompt: 'x' }] }), /access/);
  assert.throws(() => parse({ action: 'run_checks', check_ids: ['powershell'] }), /check_ids/);
  assert.throws(() => parseAction(JSON.stringify({ reason: 'r', action: 'run_checks', check_ids: ['a'] }), run(), {}), /не настроены/);
  assert.throws(() => parse({ action: 'ask_user', question: ' ' }), /question/);
  assert.throws(() => parse({ action: 'finish', outcome: 'done', summary: '' }), /summary/);
  assert.throws(() => parse({ action: 'finish', outcome: 'maybe', summary: 'x' }), /outcome/);
  const good = parse({ action: 'run_workers', workers: [{ agent: 'codex', access: 'read', prompt: 'x', name: '' }] });
  assert.equal(good.workers[0].agent.model, 'gpt'); assert.equal(good.workers[0].name, 'Чтение');
});

test('the roster is fixed: a model names an entry, never a profile', () => {
  assert.deepEqual(resolveAgent({ id: 'codex' }).profile, 'default');
  assert.throws(() => validateSettings({ supervisor: { id: 'evil' }, workers: [{ id: 'codex' }] }), /Проверьте/);
  assert.throws(() => validateSettings({ supervisor: { id: 'codex' }, workers: [] }), /хотя бы одного/);
  assert.throws(() => validateSettings({ supervisor: { id: 'codex' }, workers: [{ id: 'codex' }, { id: 'codex' }] }), /дважды/);
  assert.throws(() => validateSettings({ supervisor: { id: 'codex', model: 'bad model!' }, workers: [{ id: 'codex' }] }), /модел/i);
  assert.deepEqual(validateSettings(defaultSettings()).workers.map(worker => worker.id), ['claude-subscription', 'codex']);
});

test('the prompt marks worker output as untrusted and states the facts of the repository', () => {
  const prompt = supervisorPrompt(run({ journal: [{ kind: 'user', text: 'Запрос' }] }), { description: 'Задача' }, project);
  assert.match(prompt, /недоверенные данные/); assert.match(prompt, /чужие незакоммиченные изменения \(1\)/);
  assert.match(prompt, /"id":"tests"/); assert.match(prompt, /для ревью/); assert.match(prompt, /user_message/);
  assert.match(supervisorPrompt(run(), { description: 'З' }, {}, 'плохой ответ'), /отклонён: плохой ответ/);
  assert.match(supervisorPrompt(run(), { description: 'З' }, {}), /Проверки проекта: не настроены/);
});

test('old worker answers shrink so that the prompt does not grow without end', () => {
  const workers = Array.from({ length: 5 }, (_, index) => ({ id: `w${index + 1}`, name: 'x', rosterId: 'codex', access: 'read', status: 'готово', answer: `${index}`.repeat(5000) }));
  const text = renderJournal(run({ workers, journal: [{ kind: 'workers', ids: workers.map(worker => worker.id) }] }));
  const lines = JSON.parse(text)[0].workers;
  assert.ok(lines[0].answer.length < 1100); assert.ok(lines[4].answer.length === 5000);
});

test('worker prompts always carry the rules and the original task', () => {
  const write = workerPrompt(run(), { description: 'Исходная' }, { prompt: 'Сделай', access: 'write' });
  assert.match(write, /Сделай/); assert.match(write, /Исходная/); assert.match(write, /Не выполняй push/);
  assert.doesNotMatch(write, /только на чтение/);
  assert.match(workerPrompt(run(), { description: 'И' }, { prompt: 'С', access: 'read' }), /только на чтение/);
});

test('evidence and final status are computed, never taken from the supervisor', () => {
  const final = { fingerprint: 'b' };
  const passed = { status: 'пройдены', fingerprint: 'b' }, failed = { status: 'есть ошибки', fingerprint: 'b' }, stale = { status: 'пройдены', fingerprint: 'a' };
  assert.equal(evidence(run(), final).checks, 'не запускались');
  assert.equal(evidence(run({ checkRuns: [passed] }), final).checks, 'пройдены');
  assert.equal(evidence(run({ checkRuns: [stale] }), final).checks, 'устарели');
  assert.equal(evidence(run({ checkRuns: [passed] }), null).checks, 'не сверены');
  assert.equal(evidence(run(), null).filesChanged, null);
  const status = (outcome, checkRuns, state = final) => finalStatus(outcome, evidence(run({ checkRuns }), state)).status;
  assert.equal(status('done', []), 'готово');
  assert.equal(status('done', [passed]), 'готово');
  assert.equal(status('done', [failed]), 'требуется решение');
  assert.equal(status('done', [stale]), 'требуется решение');
  assert.equal(status('done', [], null), 'требуется решение');
  assert.equal(status('blocked', [passed]), 'требуется решение');
});

test('the Claude supervisor has no tools, no MCP and no plan mode; workers keep their modes', () => {
  const args = claudeArgs({ profile: 'subscription', readOnly: true, noTools: true });
  assert.equal(args[args.indexOf('--tools') + 1], ''); assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(claudeArgs({ profile: 'subscription', readOnly: true }).at(claudeArgs({ profile: 'subscription', readOnly: true }).indexOf('--permission-mode') + 1), 'plan');
  assert.equal(claudeArgs({ profile: 'subscription' }).at(claudeArgs({ profile: 'subscription' }).indexOf('--permission-mode') + 1), 'auto');
  assert.equal(claudeArgs({ profile: 'deepseek' }).at(claudeArgs({ profile: 'deepseek' }).indexOf('--permission-mode') + 1), 'acceptEdits');
  for (const options of [{ profile: 'subscription' }, { profile: 'subscription', readOnly: true }, { profile: 'subscription', readOnly: true, noTools: true }]) assert.ok(!claudeArgs(options).some(arg => /bypass|dangerously/i.test(arg)));
});

test('CLI failure text reaches the error, in both protocols', () => {
  const claude = claudeStream(() => {});
  claude.push(`${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'OAuth session expired', total_cost_usd: 0.5 })}\n`);
  assert.equal(claude.finish(1), 'ошибка'); assert.equal(claude.errorText(), 'OAuth session expired'); assert.equal(claude.cost(), 0.5);
  const codex = codexStream(() => {});
  codex.push(`${JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } })}\n`);
  assert.equal(codex.finish(1), 'ошибка'); assert.equal(codex.errorText(), 'usage limit');
});
