import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const agentOptions = [{ id: 'claude-subscription', label: 'Claude · подписка' }, { id: 'claude-litellm', label: 'Claude · LiteLLM' }, { id: 'claude-deepseek', label: 'Claude · DeepSeek' }, { id: 'codex', label: 'Codex' }];
const project = { id: 'project', path: 'C:/Projects/example', checks: [] };
const task = { id: 'task-1', projectId: 'project', title: 'Исправить add', description: 'Исправить add', status: 'выполнение', createdAt: new Date().toISOString() };
const baseRun = {
  taskId: 'task-1', status: 'выполнение', phase: 'Работает: Исполнитель', active: true, queued: false, supervisor: { label: 'Claude · подписка', model: '' }, counters: { turns: 2, workerStarts: 1 }, costUsd: 0.0123, grants: [], baseline: { clean: true, snapshot: { tree: 'a' } }, current: { snapshot: { tree: 'b' } }, checkRuns: [], report: null, waiting: null,
  journal: [{ kind: 'user', text: 'Исправить add' }, { kind: 'decision', action: 'run_workers', reason: 'Простая правка: хватит одного воркера' }],
  workers: [{ id: 'w1', name: 'Исполнитель', rosterId: 'claude-subscription', access: 'write', status: 'выполняется', prompt: 'Исправь add()', output: 'журнал <img src=x onerror=alert(1)>', answer: '', diagnostics: { output: '' }, model: '' }]
};
const opened = [];
afterEach(async () => { for (const window of opened.splice(0)) await window.happyDOM.close(); });
async function waitFor(predicate, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (predicate()) return; await delay(10); }
  assert.fail('UI did not reach expected state');
}
async function page(initial = {}, run = null) {
  const window = new Window({ url: 'http://127.0.0.1:3217', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  opened.push(window);
  const document = window.document;
  document.write(html.replace(/<script[^>]*>.*?<\/script>/gs, ''));
  const state = { token: 'test-token', projects: [structuredClone(project)], tasks: [], agentOptions, settings: { supervisor: { id: 'claude-subscription', model: '' }, workers: [{ id: 'claude-subscription', model: '', note: '' }, { id: 'codex', model: '', note: 'для ревью' }] }, profiles: { variables: [] }, profileTemplate: { variables: [] }, deepTemplate: {}, ...initial };
  const calls = [], context = { run };
  window.fetch = async (url, options = {}) => {
    const input = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, input });
    let body;
    if (url === '/api/state') body = structuredClone(state);
    else if (url === '/api/tasks') { body = { ...task, description: input.description, status: 'в очереди' }; state.tasks.push(body); }
    else if (url === '/api/run') body = context.run;
    else if (url === '/api/run-message') { context.run = context.run && { ...context.run, active: true, waiting: null, journal: [...context.run.journal, { kind: 'user', text: input.message }] }; body = context.run ?? {}; }
    else if (url === '/api/run-start') { context.run = structuredClone(baseRun); body = context.run; }
    else if (url === '/api/run-stop') body = { status: 'остановка' };
    else if (url === '/api/run-diff') body = { scope: input.scope, available: true, files: [{ status: 'M', path: 'add.mjs', additions: 1, deletions: 1, patch: 'diff --git a/add.mjs b/add.mjs\n@@ -1 +1 @@\n-a\n+b\n' }] };
    else if (url === '/api/usage') body = context.usage ?? { totals: { runs: 0 }, agents: [], models: [], roles: [], tasks: [], limits: [], firstAt: null };
    else if (url === '/api/run-worker') body = { output: 'полный журнал' };
    else if (url === '/api/settings') { state.settings = input; body = input; }
    else if (url === '/api/task-delete') { state.tasks = state.tasks.filter(item => item.id !== input.taskId); body = { removedTasks: 1 }; }
    else body = { ok: true };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  window.eval(code);
  await waitFor(() => document.querySelector('#task select[name=projectId]').options.length === state.projects.length && calls.some(call => call.url === '/api/state') && !!document.querySelector('#composer-note').textContent);
  return { window, document, calls, state, context };
}
const open = async (view, id = 'task-1') => { view.window.location.hash = `#task/${id}`; await waitFor(() => view.document.querySelector('.task-detail')); };

test('a task needs only a description: no mode, process or agent to choose', async () => {
  const view = await page();
  const { document, calls } = view;
  assert.equal(document.querySelector('[data-page=workflows]'), null);
  assert.equal(document.querySelector('[data-nav=workflows]'), null);
  assert.deepEqual([...document.querySelector('#task').elements].map(field => field.name).filter(Boolean).sort(), ['description', 'projectId']);
  const form = document.querySelector('#task');
  form.elements.description.value = 'Исправить add';
  form.dispatchEvent(new view.window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => calls.some(call => call.url === '/api/tasks'));
  assert.deepEqual(calls.find(call => call.url === '/api/tasks').input, { description: 'Исправить add', projectId: 'project' });
  await waitFor(() => view.window.location.hash === '#task/task-1');
  assert.equal(calls.filter(call => call.url.includes('prepare')).length, 0, 'nothing to confirm');
});

test('the task page shows who works, why and the current step, and agent text stays text', async () => {
  const view = await page({ tasks: [task] }, baseRun);
  await open(view);
  const { document } = view;
  await waitFor(() => document.querySelector('.decision'));
  assert.match(document.querySelector('.phase').textContent, /Работает: Исполнитель/);
  assert.match(document.querySelector('.workflow-route').textContent, /Супервизор: Claude · подписка/);
  assert.match(document.querySelector('.decision').textContent, /Простая правка/);
  assert.match(document.querySelector('.task-stats').textContent, /расчётная стоимость: \$0\.012/);
  assert.equal(document.querySelector('[data-node=w1]').classList.contains('selected'), true, 'the running step is the one shown');
  assert.match(document.querySelector('.inspector').textContent, /Исправь add\(\)/);
  assert.equal(document.querySelector('.task-work img'), null, 'output is never parsed as HTML');
  assert.match(document.querySelector('[data-worker=w1]').textContent, /<img src=x/);
  assert.equal(document.querySelector('.run-controls .danger:not(.secondary)').hidden, false, 'stop is available');
});

test('a message can be sent while work is running', async () => {
  const view = await page({ tasks: [task] }, baseRun);
  await open(view);
  const { document, calls } = view;
  await waitFor(() => !document.querySelector('.reply').hidden);
  assert.match(document.querySelector('.reply').textContent, /прочитает сообщение/);
  document.querySelector('.reply textarea').value = 'Учти совместимость';
  document.querySelector('.reply').dispatchEvent(new view.window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => calls.some(call => call.url === '/api/run-message'));
  assert.deepEqual(calls.find(call => call.url === '/api/run-message').input, { taskId: 'task-1', message: 'Учти совместимость' });
});

test('a question comes with its answer box at the top of the task, and the answer goes back', async () => {
  const run = { ...baseRun, active: false, status: 'ждёт ответа', phase: '', waiting: { question: 'Какой API оставить?' } };
  const view = await page({ tasks: [{ ...task, status: 'ждёт ответа' }] }, run);
  await open(view);
  const { document, calls } = view;
  await waitFor(() => document.querySelector('.task-head .question') && !document.querySelector('.task-head .question').hidden);
  const form = document.querySelector('.task-head .question');
  assert.equal(form.querySelector('.question-text').textContent, 'Какой API оставить?');
  assert.equal(document.querySelector('.reply').hidden, true, 'there is one place to answer');
  assert.equal(document.activeElement, form.querySelector('textarea'), 'the cursor is ready');
  form.querySelector('textarea').value = 'Старый';
  form.dispatchEvent(new view.window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => calls.some(call => call.url === '/api/run-message'));
  assert.deepEqual(calls.find(call => call.url === '/api/run-message').input, { taskId: 'task-1', message: 'Старый' });
});

test('a question sits in its task card, can be answered there and survives a refresh of other tasks', async () => {
  const view = await page({ tasks: [{ ...task, status: 'ждёт ответа', question: 'Закрыть Unity?' }, { ...task, id: 'task-2', status: 'выполнение', latest: { kind: 'decision', text: 'Было', now: '' } }] });
  const { document, calls, state, window } = view;
  await waitFor(() => document.querySelector('.task-row-wrap .question'));
  assert.equal(document.querySelector('#dashboard-questions'), null, 'no separate block above the tasks');
  const card = document.querySelector('.task-row-wrap.has-question'), form = card.querySelector('.question');
  assert.match(form.textContent, /Закрыть Unity\?/); assert.equal(card.querySelector('a').getAttribute('href'), '#task/task-1');
  assert.equal(form.closest('a'), null, 'typing an answer does not sit inside the link');
  assert.equal(document.querySelector('#nav-questions').textContent, '1'); assert.equal(document.querySelector('#nav-questions').hidden, false);
  assert.match(document.title, /^\(1\) Есть вопрос/);
  const input = form.querySelector('textarea'); input.value = 'Да, закрой'; input.focus();
  state.tasks[1].latest.text = 'Стало';
  await waitFor(() => /Стало/.test(document.querySelector('#dashboard-tasks').textContent), 500); // The dashboard refreshes every 2.5 s.
  assert.equal(form.isConnected, true); assert.equal(input.value, 'Да, закрой'); assert.equal(document.activeElement, input);
  form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => calls.some(call => call.url === '/api/run-message'));
  assert.deepEqual(calls.find(call => call.url === '/api/run-message').input, { taskId: 'task-1', message: 'Да, закрой' });
  delete state.tasks[0].question;
  await waitFor(() => !document.querySelector('.task-row-wrap .question'));
  assert.equal(document.querySelector('#nav-questions').hidden, true);
  assert.doesNotMatch(document.title, /вопрос/);
});

test('a card shows the latest message from the agents, as text', async () => {
  const view = await page({ tasks: [{ ...task, status: 'выполнение', latest: { kind: 'decision', text: 'Нужно ревью <img src=x>', now: 'Работает: Ревью' } }, { ...task, id: 'task-2', status: 'готово', latest: { kind: 'report', text: 'Нормали исправлены' } }] });
  const { document } = view;
  await waitFor(() => document.querySelectorAll('.task-latest').length === 2);
  const text = document.querySelector('#dashboard-tasks').textContent;
  assert.match(text, /Супервизор: Нужно ревью <img src=x>/); assert.match(text, /Сейчас: Работает: Ревью/); assert.match(text, /Отчёт: Нормали исправлены/);
  assert.equal(document.querySelector('#dashboard-tasks img'), null);
});

test('a new task is written in a window that opens from the toolbar and keeps the draft', async () => {
  const view = await page();
  const { document, window } = view, composer = document.querySelector('#composer');
  assert.equal(composer.open, false);
  document.querySelector('#new-task').click();
  assert.equal(composer.open, true);
  document.querySelector('#task-description').value = 'Черновик';
  document.querySelector('#composer-cancel').click();
  assert.equal(composer.open, false);
  assert.equal(document.querySelector('#task-description').value, 'Черновик');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyN', bubbles: true }));
  assert.equal(composer.open, true, 'N opens it');
  document.querySelector('#task').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => window.location.hash === '#task/task-1');
  assert.equal(composer.open, false, 'it closes once the task exists');
});

test('the graph puts the newest step on top, parallel workers side by side, and the next step is not invented', async () => {
  const done = (id, name) => ({ ...baseRun.workers[0], id, name, access: 'read', status: 'готово', answer: `Ответ ${name}`, startedAt: '2026-11-04T10:00:00Z', endedAt: '2026-11-04T10:00:54Z' });
  const run = { ...baseRun, phase: 'Работает: Третий', checkRuns: [{ id: 'c1', status: 'пройдены', results: [{ definition: { id: 't', name: 'Тесты' }, status: 'пройдена', exitCode: 0, output: '' }] }],
    journal: [{ kind: 'user', text: 'Задача' }, { kind: 'decision', action: 'run_workers', reason: 'Сначала два чтения' }, { kind: 'workers', ids: ['w1', 'w2'] }, { kind: 'decision', action: 'run_checks', reason: 'Прогнать тесты' }, { kind: 'checks', id: 'c1' }, { kind: 'decision', action: 'ask_user', reason: 'Нужен ответ' }, { kind: 'answer', question: 'Закрыть?', text: 'можно' }, { kind: 'decision', action: 'run_workers', reason: 'Теперь правка' }],
    workers: [done('w1', 'Первый'), done('w2', 'Второй'), { ...baseRun.workers[0], id: 'w3', name: 'Третий', startedAt: new Date().toISOString() }] };
  const view = await page({ tasks: [task] }, run);
  await open(view);
  const { document } = view;
  await waitFor(() => document.querySelector('[data-node=w3]'));
  const rows = [...document.querySelectorAll('.graph-row')].map(row => [...row.children].map(node => node.dataset.node));
  assert.deepEqual(rows, [['next'], ['w3'], ['j5'], ['c1'], ['w1', 'w2'], ['task']]);
  assert.equal(document.querySelector('[data-node=next]').classList.contains('tone-ghost'), true);
  assert.match(document.querySelector('[data-node=w1]').textContent, /54 с/);
  assert.match(document.querySelector('[data-node=j5]').textContent, /→ можно/);
  assert.notEqual(document.querySelector('.inspector [data-worker=w3]'), null, 'the running step is shown first');
  document.querySelector('[data-node=w2]').click();
  assert.match(document.querySelector('.inspector').textContent, /Сначала два чтения/);
  assert.match(document.querySelector('.inspector').textContent, /Ответ Второй/);
  assert.equal(document.querySelector('[data-node=w2]').getAttribute('aria-pressed'), 'true');
  view.context.run = { ...run, phase: 'Супервизор выбирает следующий шаг', workers: [...run.workers.slice(0, 2), { ...run.workers[2], output: 'новый вывод' }] };
  await waitFor(() => /супервизор выбирает/.test(document.querySelector('[data-node=next]').textContent));
  assert.match(document.querySelector('.inspector').textContent, /Ответ Второй/, 'a chosen step stays chosen while work goes on');
});

test('the report separates the model text from facts, and failed checks are visible', async () => {
  const run = { ...baseRun, active: false, status: 'требуется решение', statusReason: 'Супервизор завершил задачу, но последние проверки не пройдены.', phase: '',
    report: { outcome: 'done', summary: 'Всё отлично', evidence: { filesChanged: true, checks: 'есть ошибки', readAfterWrite: false } },
    checkRuns: [{ id: 'c1', status: 'есть ошибки', results: [{ definition: { id: 't', name: 'Тесты' }, status: 'ошибка', exitCode: 7, output: 'failed' }] }],
    journal: [...baseRun.journal, { kind: 'checks', id: 'c1' }], workers: [{ ...baseRun.workers[0], status: 'готово', answer: 'Правка готова' }] };
  const view = await page({ tasks: [{ ...task, status: 'требуется решение' }] }, run);
  await open(view);
  const { document } = view;
  await waitFor(() => document.querySelector('.report'));
  assert.match(document.querySelector('.phase').textContent, /не пройдены/);
  const report = document.querySelector('.report').textContent;
  assert.match(report, /Всё отлично/); assert.match(report, /Проверки: есть ошибки/); assert.match(report, /написан моделью/);
  document.querySelector('[data-node=c1]').click();
  await waitFor(() => document.querySelector('.inspector [data-check=c1]'));
  assert.match(document.querySelector('[data-check=c1]').textContent, /код выхода 7/);
  assert.equal(document.querySelector('[data-check=c1] details').open, true, 'a failed check is open');
  assert.ok(document.querySelector('[data-diff=run]'), 'the whole diff is offered');
});

test('the final report is the details of the last step, so the graph stays on the first screen', async () => {
  const run = { ...baseRun, active: false, status: 'готово', statusReason: 'Завершено', phase: '', report: { outcome: 'done', summary: 'Итог работы', evidence: { filesChanged: true, checks: 'не запускались', readAfterWrite: false } },
    journal: [...baseRun.journal, { kind: 'workers', ids: ['w1'] }, { kind: 'decision', action: 'finish', reason: 'Всё сделано' }], workers: [{ ...baseRun.workers[0], status: 'готово', answer: 'Правка готова' }] };
  const view = await page({ tasks: [{ ...task, status: 'готово' }] }, run);
  await open(view);
  const { document } = view;
  await waitFor(() => document.querySelector('.inspector .report'));
  assert.match(document.querySelector('.inspector').textContent, /Всё сделано/);
  assert.match(document.querySelector('.inspector .report').textContent, /Итог работы/);
  assert.equal(document.querySelectorAll('.report').length, 1, 'one report on the page');
  assert.notEqual(document.querySelector('.task-details [data-diff=run]'), null);
});

test('text from models renders as Markdown, and nothing in it can become HTML or a script link', async () => {
  const answer = '# Итог\n\n**Главный вывод:** `a|b` и *важно*, foo_bar_baz 2*3*4\n\n| Метрика | Значение |\n|---|---:|\n| Записей | 28 060 |\n| Код | `x\\|y` |\n\n- первый\n  - вложенный\n- второй\n\n1. раз\n2. два\n\n> цитата\n\n```\nconst a = "**не жирный**";\n```\n\n<img src=x onerror=alert(1)> [плохая](javascript:alert(1)) [хорошая](https://example.com/a) https://example.org/b.';
  const run = { ...baseRun, active: false, status: 'готово', phase: '', workers: [{ ...baseRun.workers[0], status: 'готово', answer }] };
  const view = await page({ tasks: [{ ...task, status: 'готово' }] }, run);
  await open(view);
  const { document } = view;
  await waitFor(() => document.querySelector('[data-worker=w1] .markdown table'));
  const block = [...document.querySelectorAll('[data-worker=w1] .markdown')].find(node => node.querySelector('table'));
  assert.equal(block.querySelector('h3').textContent, 'Итог');
  assert.equal(block.querySelector('strong').textContent, 'Главный вывод:');
  assert.equal(block.querySelector('em').textContent, 'важно');
  assert.match(block.querySelector('p').textContent, /foo_bar_baz 2\*3\*4/, 'identifiers and arithmetic stay as written');
  assert.deepEqual([...block.querySelectorAll('th')].map(cell => cell.textContent), ['Метрика', 'Значение']);
  assert.deepEqual([...block.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent)), [['Записей', '28 060'], ['Код', 'x|y']]);
  assert.equal(block.querySelector('th:last-child').dataset.align, 'right');
  assert.equal(block.querySelector('ul ul li').textContent, 'вложенный');
  assert.equal(block.querySelectorAll('ol li').length, 2);
  assert.equal(block.querySelector('blockquote').textContent, 'цитата');
  assert.equal(block.querySelector('pre code').textContent, 'const a = "**не жирный**";');
  assert.equal(block.querySelector('img'), null, 'HTML stays text');
  assert.match(block.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.deepEqual([...block.querySelectorAll('a')].map(link => link.getAttribute('href')), ['https://example.com/a', 'https://example.org/b']);
  assert.match(block.textContent, /\[плохая\]\(javascript:alert\(1\)\)/);
  assert.equal(block.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
});

test('a card shows Markdown as plain words', async () => {
  const view = await page({ tasks: [{ ...task, status: 'готово', latest: { kind: 'report', text: '**Вывод:** `ok`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [пункт](https://example.com)' } }] });
  const { document } = view;
  await waitFor(() => document.querySelector('.task-latest'));
  assert.equal(document.querySelector('.task-latest').textContent, 'Отчёт: Вывод: ok A · B 1 · 2 • пункт');
});

test('a node names the model that really worked and what it spent; the supervisor is in the header', async () => {
  const usage = [{ model: 'claude-opus-5-5', input: 1000, output: 500, cacheRead: 90000, cacheWrite: 2000, costUsd: 0.5 }];
  const run = { ...baseRun, active: false, status: 'готово', phase: '', supervisorUsage: [{ model: 'claude-haiku-5-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: null }], workers: [{ ...baseRun.workers[0], model: '', status: 'готово', answer: 'Да', usage }] };
  const view = await page({ tasks: [{ ...task, status: 'готово' }] }, run);
  await open(view);
  const { document } = view;
  await waitFor(() => document.querySelector('[data-node=w1]'));
  assert.match(document.querySelector('[data-node=w1]').textContent, /opus-5-5/);
  assert.match(document.querySelector('[data-node=w1]').textContent, /3,5k ток\./, 'cache reads are not counted as spent');
  assert.match(document.querySelector('.workflow-route').textContent, /haiku-5-5 · 15 ток\./);
  assert.match(document.querySelector('.inspector').textContent, /чтение 90.000, оценка \$0\.500/);
});

test('the usage page shows limits with their age, agents and tasks, and never a price it cannot know', async () => {
  const bucket = fields => ({ runs: 2, partial: 0, input: 1000, output: 500, cacheRead: 9000, cacheWrite: 200, costUsd: null, ...fields });
  const view = await page({ tasks: [task] });
  view.context.usage = { firstAt: '2026-11-01T10:00:00Z', totals: bucket({ costUsd: 1.5, partial: 1 }), agents: [bucket({ id: 'claude-subscription', label: 'Claude · подписка', costUsd: 1.5 }), bucket({ id: 'claude-deepseek', label: 'Claude · DeepSeek' })], models: [bucket({ model: 'claude-opus-5-5' }), bucket({ model: '' })], roles: [bucket({ kind: 'supervisor' })], tasks: [bucket({ taskId: 'task-1', title: 'Исправить add' }), bucket({ taskId: 'gone', title: null })],
    limits: [{ agentId: 'claude-subscription', label: 'Claude · подписка', observedAt: new Date().toISOString(), windows: [{ name: 'five_hour', utilization: 0.41, resetsAt: new Date(Date.now() + 3600000).toISOString() }, { name: 'seven_day', utilization: 0.9, resetsAt: new Date(Date.now() - 1000).toISOString() }] }] };
  view.window.location.hash = '#usage';
  const { document, calls } = view;
  await waitFor(() => document.querySelector('.usage-table'));
  const text = document.querySelector('#usage-report').textContent;
  assert.match(text, /5 часов41%/); assert.match(text, /по данным последнего запуска/);
  assert.match(text, /окно обновилось/, 'a window that has reset does not show a stale percent');
  assert.equal(document.querySelectorAll('[role=meter]').length, 1);
  assert.match(text, /Удалённая задача/); assert.match(text, /Модель из настроек CLI/); assert.match(text, /остановленных до итогов: 1/);
  const row = [...document.querySelectorAll('.usage-table tr')].find(item => /DeepSeek/.test(item.textContent));
  assert.equal(row.lastElementChild.textContent, '—');
  assert.equal(document.querySelector('.usage-table a').getAttribute('href'), '#task/task-1');
  document.querySelector('[data-usage-period=all]').click();
  await waitFor(() => calls.filter(call => call.url === '/api/usage').at(-1).input.from === null);
  await delay(30); // Lets the answer arrive before the window closes.
});

test('a refused action can be allowed only through the button, naming the exact rule', async () => {
  const run = { ...baseRun, active: false, status: 'требуется решение', phase: '', workers: [{ ...baseRun.workers[0], status: 'отказ в правах', denials: [{ tool: 'Bash', detail: 'dotnet build', rule: 'Bash(dotnet build)' }, { tool: 'Edit', detail: 'x', rule: null }] }] };
  const view = await page({ tasks: [{ ...task, status: 'требуется решение' }] }, run);
  await open(view);
  const { document, calls } = view;
  await waitFor(() => document.querySelector('.denials'));
  const panel = document.querySelector('.denials');
  assert.match(panel.textContent, /Bash\(dotnet build\)/); assert.match(panel.textContent, /точное разрешение выдать нельзя/);
  panel.querySelector('button').click();
  await waitFor(() => calls.some(call => call.url === '/api/run-message'));
  assert.equal(calls.find(call => call.url === '/api/run-message').input.allowDenied, true);
});

test('a task that never ran can be started; the full log is loaded on request', async () => {
  const view = await page({ tasks: [{ ...task, status: 'создана', legacy: true }] }, null);
  await open(view);
  const { document, calls } = view;
  await waitFor(() => /не запускалась/.test(document.querySelector('.phase').textContent));
  assert.match(document.querySelector('.task-head').textContent, /прежней версии/);
  const start = document.querySelector('.run-controls button');
  assert.equal(start.hidden, false); start.click();
  await waitFor(() => calls.some(call => call.url === '/api/run-start'));
  view.context.run = { ...baseRun, active: false, status: 'готово', workers: [{ ...baseRun.workers[0], logTrimmed: true }] };
  await waitFor(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Показать весь журнал'));
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Показать весь журнал').click();
  await waitFor(() => /полный журнал/.test(document.querySelector('[data-worker=w1]').textContent));
});

test('the team settings save the supervisor and the chosen workers', async () => {
  const view = await page();
  view.window.location.hash = '#settings';
  const { document, calls } = view;
  await waitFor(() => document.querySelectorAll('#team-workers [data-worker-option]').length === 4);
  assert.equal(document.querySelector('[data-worker-option=codex] [data-note]').value, 'для ревью');
  document.querySelector('[data-worker-option=claude-litellm] [data-enabled]').checked = true;
  document.querySelector('[data-worker-option=claude-subscription] [data-enabled]').checked = false;
  document.querySelector('#team').elements.supervisorModel.value = 'haiku';
  document.querySelector('#team').dispatchEvent(new view.window.Event('submit', { cancelable: true, bubbles: true }));
  await waitFor(() => calls.some(call => call.url === '/api/settings'));
  const saved = calls.find(call => call.url === '/api/settings').input;
  assert.equal(saved.supervisor.model, 'haiku');
  assert.deepEqual(saved.workers.map(worker => worker.id), ['claude-litellm', 'codex']);
  await waitFor(() => /Сохранено/.test(document.querySelector('#team-result').textContent));
});

test('the dashboard groups tasks by what they need from you', async () => {
  const tasks = [{ ...task, id: 'a', status: 'ждёт ответа' }, { ...task, id: 'b', status: 'выполнение' }, { ...task, id: 'c', status: 'в очереди' }, { ...task, id: 'd', status: 'готово' }, { ...task, id: 'e', status: 'ошибка' }, { ...task, id: 'f', status: 'создана' }];
  const view = await page({ tasks });
  const { document } = view;
  await waitFor(() => document.querySelector('#count-all').textContent === '6');
  assert.equal(document.querySelector('#count-attention').textContent, '2');
  assert.equal(document.querySelector('#count-active').textContent, '2');
  assert.equal(document.querySelector('#count-response').textContent, '1');
  assert.equal(document.querySelector('#count-created').textContent, '1');
});

const imageFile = (window, name = 'a.png', type = 'image/png', size = 8) => new window.File([new Uint8Array(size).fill(1)], name, { type });
async function attach(window, form, files) {
  const input = form.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new window.Event('change'));
  await delay(20);
}
test('a picture can be attached to a new task, removed, and is sent with it', async () => {
  const view = await page();
  const { document, window, calls } = view, form = document.querySelector('#task');
  document.querySelector('#new-task').click();
  document.querySelector('#task-description').value = 'Посмотри снимок';
  await attach(window, form, [imageFile(window), imageFile(window, 'b.png')]);
  await waitFor(() => form.querySelectorAll('.image-preview').length === 2);
  form.querySelector('.image-preview button').click();
  assert.equal(form.querySelectorAll('.image-preview').length, 1);
  await attach(window, form, [imageFile(window, 'c.svg', 'image/svg+xml')]);
  assert.match(form.querySelector('.image-error').textContent, /PNG, JPEG/);
  assert.equal(form.querySelectorAll('.image-preview').length, 1);
  await attach(window, form, [imageFile(window, 'big.png', 'image/png', 4 * 1024 * 1024)]);
  assert.match(form.querySelector('.image-error').textContent, /3,75 МБ/);
  form.requestSubmit();
  await waitFor(() => calls.some(call => call.url === '/api/tasks'));
  const { input } = calls.find(call => call.url === '/api/tasks');
  assert.equal(input.images.length, 1); assert.equal(Buffer.from(input.images[0].data, 'base64').length, 8);
  await waitFor(() => !form.querySelectorAll('.image-preview').length);
});
test('a task without pictures sends none', async () => {
  const view = await page();
  const { document, calls } = view;
  document.querySelector('#new-task').click();
  document.querySelector('#task-description').value = 'Только текст';
  document.querySelector('#task').requestSubmit();
  await waitFor(() => calls.some(call => call.url === '/api/tasks'));
  assert.ok(!('images' in calls.find(call => call.url === '/api/tasks').input));
});
test('attached pictures are shown on the task page and a reply can carry more', async () => {
  const withImages = { ...task, status: 'готово', images: [{ id: 'img-1', type: 'image/png', size: 8 }] };
  const run = { ...structuredClone(baseRun), active: false, status: 'готово', workers: [], journal: [{ kind: 'user', text: 'Исправить add', images: ['img-1'] }, { kind: 'user', text: 'Вот ещё', images: ['img-2'] }] };
  const view = await page({ tasks: [withImages] }, run);
  const { document, window, calls } = view;
  window.location.hash = `task/${task.id}`;
  await waitFor(() => document.querySelector('[data-node=j1]'));
  document.querySelector('[data-node=j1]').click();
  await waitFor(() => document.querySelector('.image-gallery img')?.getAttribute('src') === `/images/${task.id}/img-2`);
  assert.equal(document.querySelector('.image-gallery a').getAttribute('rel'), 'noopener');
  assert.match(document.querySelector('[data-node=j1]').textContent, /изображений: 1/);
  document.querySelector('[data-node=task]').click();
  await waitFor(() => document.querySelector('.image-gallery img')?.getAttribute('src') === `/images/${task.id}/img-1`);

  const reply = document.querySelector('form.reply');
  await waitFor(() => !reply.hidden);
  reply.querySelector('textarea').value = 'Смотри';
  await attach(window, reply, [imageFile(window)]);
  await waitFor(() => reply.querySelector('.image-preview'));
  reply.requestSubmit();
  await waitFor(() => calls.some(call => call.url === '/api/run-message'));
  assert.equal(calls.find(call => call.url === '/api/run-message').input.images.length, 1);
  await waitFor(() => !reply.querySelector('.image-preview'));
});
