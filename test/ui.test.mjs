import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const code = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const project = { id: 'project', path: 'C:/Projects/example', checks: [{ id: 'tests', name: 'Tests', executable: 'node', args: ['--test'], timeoutSeconds: 30 }],
  defaultPresetId: 'preset' };
const preset = { id: 'preset', name: 'With tests', profile: 'subscription', instructions: 'Keep compatibility', workflow: { mode: 'checked' } };
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail('UI did not reach expected state');
}
async function page(initial = {}) {
  const window = new Window({ url: 'http://127.0.0.1:3217', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const document = window.document;
  document.write(html.replace(/<script[^>]*>.*?<\/script>/gs, ''));
  const state = { token: 'test-token', projects: [structuredClone(project)], presets: [structuredClone(preset)], tasks: [], profiles: { variables: [] }, profileTemplate: { variables: [] }, deepTemplate: {}, ...initial };
  const calls = [];
  let attempts = [];
  window.fetch = async (url, options = {}) => {
    const input = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, input });
    let body;
    if (url === '/api/state') body = structuredClone(state);
    else if (url === '/api/tasks') {
      const chosen = state.presets.find(p => p.id === input.presetId);
      body = { id: 'task-1', ...input, title: input.title || input.description, criteria: input.criteria || 'Requirement', status: 'создана', createdAt: new Date().toISOString(), ...(chosen ? { profile: chosen.profile, workflow: { ...chosen.workflow, checkIds: ['tests'] }, preset: structuredClone(chosen) } : {}) };
      state.tasks.push(body);
    } else if (url === '/api/attempts') body = attempts;
    else if (url === '/api/attempt-hold') { attempts.at(-1).automation.stopAfterPass = true; body = { stopAfterPass: true }; }
    else if (url === '/api/attempt-prepare') body = { previewId: 'preview', workspace: { path: project.path, branch: 'main', head: 'abc', clean: true, changes: [] }, workflow: state.tasks[0].workflow, checks: [], review: 'не запрошено', profile: 'subscription', command: ['claude', '--print'], message: input.message, autoStart: !!state.autoStart };
    else if (url === '/api/attempt-start') body = { id: 'attempt-2' };
    else if (url === '/api/attempt-decide') body = { id: input.attemptId };
    else if (url === '/api/checks-refresh') body = { checks: 'пройдены', fingerprintMatches: true };
    else if (url === '/api/attempt-diff') body = state.diffs[input.scope];
    else if (url === '/api/task-delete') { state.tasks = state.tasks.filter(t => t.id !== input.taskId); body = { removedTasks: 1 }; }
    else if (url === '/api/preset-delete') { state.presets = []; body = { removedTasks: 0 }; }
    else if (url === '/api/project-default') { state.projects[0].defaultPresetId = input.presetId; body = structuredClone(state.projects[0]); }
    else if (url === '/api/project-preset-checks') {
      const target = state.projects[0];
      if (Array.isArray(input.checkIds) && !input.checkIds.length) return { ok: false, json: async () => ({ error: 'Выберите хотя бы одну проверку' }) };
      target.presetChecks ??= {};
      if (input.checkIds === null) delete target.presetChecks[input.presetId]; else target.presetChecks[input.presetId] = input.checkIds;
      body = structuredClone(target);
    }
    else if (url === '/api/project-delete') { state.projects = []; state.tasks = []; body = { removedTasks: 1 }; }
    else if (url === '/api/preset') { body = { ...input.preset, id: 'new-preset' }; state.presets.push(body); }
    else throw new Error(`Unexpected endpoint ${url}`);
    return { ok: true, json: async () => structuredClone(body) };
  };
  window.eval(code);
  await waitFor(() => document.querySelector('#task select[name=projectId]').options.length > 0 || !state.projects.length);
  await delay(20);
  return { window, document, calls, state, setAttempts(value) { attempts = value; }, async close() { await window.happyDOM.close(); } };
}

test('composer applies project preset, creates a task from one prompt and opens its launch preview', async () => {
  const p = await page();
  try {
    const form = p.document.querySelector('#task');
    assert.equal(form.elements.presetId.value, 'preset');
    assert.equal(form.elements.workflowMode.value, 'checked');
    assert.equal(form.elements.profile.disabled, true);
    form.elements.description.value = 'Fix reconnect';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.document.querySelector('.launch-preview button')).catch(error => { throw new Error(p.document.querySelector('#message').textContent + ' | ' + JSON.stringify(p.calls), { cause: error }); });
    assert.equal(p.calls.find(c => c.url === '/api/tasks').input.presetId, 'preset');
    assert.equal(p.document.querySelector('[data-page=task]').hidden, false);
    assert.match(p.document.querySelector('.task-detail h1').textContent, /Fix reconnect/);
    assert.equal(p.calls.filter(c => c.url === '/api/attempt-prepare').length, 1);
    assert.equal(p.calls.some(c => c.url === '/api/attempt-start'), false, 'Creating a task must not silently execute the agent');
    p.window.location.hash = 'dashboard';
    await waitFor(() => !p.document.querySelector('[data-page=dashboard]').hidden);
    assert.equal(p.document.querySelectorAll('.task-row').length, 1);
    const search = p.document.querySelector('#task-search'); search.value = 'missing'; search.dispatchEvent(new p.window.Event('input'));
    assert.equal(p.document.querySelectorAll('.task-row').length, 0);
  } finally { await p.close(); }
});

test('process editor is global: it saves instructions and stages without a project or checks', async () => {
  const p = await page();
  try {
    p.window.location.hash = 'workflows';
    await waitFor(() => !p.document.querySelector('[data-page=workflows]').hidden);
    assert.equal(p.document.querySelector('#preset-project'), null);
    assert.match(p.document.querySelector('#preset-list').textContent, /по умолчанию: example/);
    const form = p.document.querySelector('#preset-form');
    assert.equal(form.querySelector('input[name=checkIds]'), null);
    form.elements.name.value = 'Fast compilation'; form.elements.instructions.value = 'Preserve public API'; form.elements.mode.value = 'checked';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.calls.some(c => c.url === '/api/preset'));
    const payload = p.calls.find(c => c.url === '/api/preset').input;
    assert.deepEqual(payload.preset.workflow, { mode: 'checked' });
    assert.equal(payload.projectId, undefined);
    assert.equal(payload.preset.instructions, 'Preserve public API');
    assert.equal(p.state.tasks.length, 0);
  } finally { await p.close(); }
});

test('every project offers every process and chooses its default and checks in place', async () => {
  const other = { id: 'other', path: 'C:/Projects/other', checks: [{ id: 'gradle', name: 'Gradle', executable: 'gradle', args: ['test'], timeoutSeconds: 30 }, { id: 'lint', name: 'Lint', executable: 'gradle', args: ['lint'], timeoutSeconds: 30 }], presetChecks: { preset: ['gradle'] } };
  const p = await page({ projects: [structuredClone(project), other] });
  try {
    const composer = p.document.querySelector('#task');
    composer.elements.projectId.value = 'other'; composer.elements.projectId.dispatchEvent(new p.window.Event('change'));
    assert.deepEqual(Array.from(composer.elements.presetId.options).map(o => o.value), ['', 'preset']);
    assert.equal(composer.elements.presetId.value, '', 'the default of another project is not applied');
    composer.elements.presetId.value = 'preset'; composer.elements.presetId.dispatchEvent(new p.window.Event('change'));
    assert.deepEqual(Array.from(composer.querySelectorAll('#task-check-options input')).filter(i => i.checked).map(i => i.value), ['gradle']);

    composer.elements.projectId.value = 'project'; composer.elements.projectId.dispatchEvent(new p.window.Event('change'));
    const section = p.document.querySelectorAll('.project-processes')[0];
    section.open = true;
    const group = () => section.querySelector('[data-preset-checks=preset]');
    assert.equal(group().querySelector('[data-all]').checked, true);
    assert.equal(group().querySelector('input[value=tests]').disabled, true);

    const all = group().querySelector('[data-all]'); all.checked = false; all.dispatchEvent(new p.window.Event('change'));
    await waitFor(() => p.calls.some(c => c.url === '/api/project-preset-checks'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/project-preset-checks').input, { projectId: 'project', presetId: 'preset', checkIds: ['tests'] });
    await waitFor(() => group().querySelector('[data-all]').checked === false);
    assert.equal(section.open, true, 'saving does not collapse the section');

    const box = group().querySelector('input[value=tests]'); box.checked = false; box.dispatchEvent(new p.window.Event('change'));
    await waitFor(() => /хотя бы одну/.test(section.textContent));
    assert.equal(group().querySelector('input[value=tests]').checked, true, 'a refused change is not shown as saved');

    const defaultSelect = section.querySelector('select'); defaultSelect.value = ''; defaultSelect.dispatchEvent(new p.window.Event('change'));
    await waitFor(() => p.calls.some(c => c.url === '/api/project-default'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/project-default').input, { projectId: 'project', presetId: '' });
    await waitFor(() => composer.elements.presetId.value === '');
  } finally { await p.close(); }
});

test('diff is loaded on demand, shown as inert text and separated from changes that existed before the run', async () => {
  const task = { id: 'task-1', projectId: 'project', profile: 'subscription', title: 'Diff', description: 'Fix it', criteria: 'Fixed', workflow: { mode: 'quick', checkIds: [] }, createdAt: new Date().toISOString(), status: 'выполнение завершено' };
  const patch = 'diff --git a/a.html b/a.html\n--- a/a.html\n+++ b/a.html\n@@ -1 +1 @@\n-<b>old</b>\n+<img src=x onerror=alert(1)>\n';
  const p = await page({ tasks: [task], diffs: {
    attempt: { scope: 'attempt', available: true, truncated: false, patchLimit: 4194304, files: [{ status: 'M', path: 'a.html', additions: 1, deletions: 1, binary: false, patch }] },
    initial: { scope: 'initial', available: false, reason: 'Снимок повреждён.' } } });
  try {
    p.setAttempts([{ id: 'attempt-1', taskId: task.id, status: task.status, profile: 'subscription', directory: project.path, events: [], output: 'done', checks: 'не запрошены', review: 'не запрошено', workflow: task.workflow, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      baseline: { clean: false, snapshot: { tree: 'a'.repeat(40), head: null } }, after: { snapshot: { tree: 'b'.repeat(40), head: null } } }]);
    p.window.location.hash = 'task/task-1';
    await waitFor(() => p.document.querySelector('[data-diff=attempt]'));
    assert.equal(p.calls.some(c => c.url === '/api/attempt-diff'), false, 'closed panel requests nothing');

    const panel = p.document.querySelector('[data-diff=attempt]'); panel.open = true;
    panel.dispatchEvent(new p.window.Event('toggle'));
    await waitFor(() => panel.querySelector('.diff'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/attempt-diff').input, { taskId: 'task-1', attemptId: 'attempt-1', scope: 'attempt' });
    assert.match(panel.textContent, /Файлов: 1, \+1 −1/);
    assert.equal(panel.querySelector('.diff-add').textContent, '+<img src=x onerror=alert(1)>\n');
    assert.equal(panel.querySelector('.diff-del').textContent, '-<b>old</b>\n');
    assert.equal(panel.querySelector('img'), null, 'patch content is never parsed as HTML');

    const initial = p.document.querySelector('[data-diff=initial]'); initial.open = true;
    initial.dispatchEvent(new p.window.Event('toggle'));
    await waitFor(() => /Diff недоступен/.test(initial.textContent));
    assert.match(initial.textContent, /не результат агента/); assert.match(initial.textContent, /Снимок повреждён/);
  } finally { await p.close(); }
});

test('completed session exposes a follow-up composer and preserves its message in preview', async () => {
  const task = { id: 'task-1', projectId: 'project', profile: 'subscription', title: 'Clarification', description: 'Fix it', criteria: 'Fixed', workflow: { mode: 'quick', checkIds: [] }, createdAt: new Date().toISOString(), status: 'выполнение завершено' };
  const p = await page({ tasks: [task] });
  try {
    p.setAttempts([{ id: 'attempt-1', taskId: task.id, sessionId: 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff', status: task.status, profile: 'subscription', directory: project.path, events: [], output: 'Which handler?', checks: 'не запрошены', review: 'не запрошено', workflow: task.workflow, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }]);
    p.window.location.hash = 'task/task-1';
    await waitFor(() => p.document.querySelector('.reply') && !p.document.querySelector('.reply').hidden);
    const reply = p.document.querySelector('.reply'); reply.querySelector('textarea').value = 'The reconnect handler';
    reply.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.document.querySelector('.launch-preview button'));
    assert.equal(p.calls.find(c => c.url === '/api/attempt-prepare').input.message, 'The reconnect handler');
    assert.match(p.document.querySelector('.launch-preview').textContent, /The reconnect handler/);
    assert.equal(p.document.querySelector('[data-task-status]').textContent, 'Ответ получен');
  } finally { await p.close(); }
});

test('tasks, processes and projects are deleted only on a second click', async () => {
  const task = { id: 'task-1', projectId: 'project', profile: 'subscription', title: 'Old', description: 'Old', criteria: 'Old', workflow: { mode: 'quick', checkIds: [] }, createdAt: new Date().toISOString(), status: 'выполнение завершено' };
  const p = await page({ tasks: [task] });
  const count = url => p.calls.filter(c => c.url === url).length;
  try {
    const removeTask = p.document.querySelector('.task-row-wrap button');
    removeTask.click();
    assert.equal(count('/api/task-delete'), 0); assert.equal(removeTask.textContent, 'Точно?');
    removeTask.click();
    await waitFor(() => !p.document.querySelector('.task-row-wrap'));
    assert.equal(p.calls.find(c => c.url === '/api/task-delete').input.taskId, 'task-1');
    const removePreset = p.document.querySelector('#preset-list .danger');
    removePreset.click(); assert.equal(count('/api/preset-delete'), 0); removePreset.click();
    await waitFor(() => !p.document.querySelector('#preset-list .danger'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/preset-delete').input, { presetId: 'preset' });
    const removeProject = p.document.querySelector('.project-list .danger');
    removeProject.click(); assert.equal(count('/api/project-delete'), 0); removeProject.click();
    await waitFor(() => !p.document.querySelector('.project-list .danger'));
    assert.equal(p.calls.find(c => c.url === '/api/project-delete').input.projectId, 'project');
  } finally { await p.close(); }
});

test('a checkout without user changes starts at once, with no launch preview', async () => {
  const p = await page({ autoStart: true });
  try {
    const form = p.document.querySelector('#task');
    form.elements.description.value = 'Fix reconnect';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.calls.some(c => c.url === '/api/attempt-start'));
    assert.equal(p.document.querySelector('.launch-preview').children.length, 0);
  } finally { await p.close(); }
});

test('opening a task compares results with current files without a button', async () => {
  const task = { id: 'task-1', projectId: 'project', profile: 'subscription', title: 'Fresh', description: 'Fix it', criteria: 'Fixed', workflow: { mode: 'checked', checkIds: ['tests'] }, createdAt: new Date().toISOString(), status: 'проверки завершены' };
  const p = await page({ tasks: [task] });
  try {
    p.setAttempts([{ id: 'attempt-1', taskId: task.id, sessionId: 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff', status: task.status, profile: 'subscription', directory: project.path, events: [], output: '', checks: 'пройдены', review: 'не запрошено', workflow: task.workflow, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), after: { fingerprint: 's' },
      checkRuns: [{ cycle: 0, status: 'пройдены', validity: 'совпадает', snapshot: 's', results: [] }] }]);
    p.window.location.hash = 'task/task-1';
    await waitFor(() => p.calls.some(c => c.url === '/api/checks-refresh'));
    assert.equal(p.calls.find(c => c.url === '/api/checks-refresh').input.attemptId, 'attempt-1');
    await waitFor(() => p.document.querySelector('[data-attempt]'));
    assert.doesNotMatch(p.document.querySelector('.task-detail').textContent, /Проверить актуальность/);
  } finally { await p.close(); }
});

test('denied actions show their exact rules and one click resumes the session', async () => {
  const task = { id: 'task-1', projectId: 'project', profile: 'subscription', title: 'CI', description: 'Check CI', criteria: 'Known', workflow: { mode: 'quick', checkIds: [] }, createdAt: new Date().toISOString(), status: 'требуется решение' };
  const p = await page({ tasks: [task] });
  try {
    p.setAttempts([{ id: 'attempt-1', taskId: task.id, sessionId: 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff', status: task.status, profile: 'subscription', directory: project.path, events: [], output: '', checks: 'не запрошены', review: 'не запрошено', workflow: task.workflow, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      permissionDenials: [{ tool: 'PowerShell', detail: 'glab mr view', rule: 'PowerShell(glab mr view)' }, { tool: 'Edit', detail: '{}', rule: null }] }]);
    p.window.location.hash = 'task/task-1';
    await waitFor(() => p.document.querySelector('[data-denials] button'));
    const panel = p.document.querySelector('[data-denials]');
    assert.match(panel.textContent, /Будет разрешено: PowerShell\(glab mr view\)/); assert.match(panel.textContent, /кнопка его не разрешит/);
    panel.querySelector('button').click();
    await waitFor(() => p.calls.some(c => c.url === '/api/attempt-start'));
    assert.equal(p.calls.find(c => c.url === '/api/attempt-prepare' && c.input.allowDenied === true).input.taskId, 'task-1');
  } finally { await p.close(); }
});

test('custom checked workflow sends explicit selections and an empty workspace cannot submit', async () => {
  const p = await page();
  try {
    const form = p.document.querySelector('#task');
    form.elements.presetId.value = ''; form.elements.presetId.dispatchEvent(new p.window.Event('change'));
    form.elements.workflowMode.value = 'checked'; form.elements.workflowMode.dispatchEvent(new p.window.Event('change'));
    form.elements.description.value = 'Run selected checks';
    assert.equal(form.elements.profile.disabled, false);
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.calls.some(c => c.url === '/api/tasks'));
    const input = p.calls.find(c => c.url === '/api/tasks').input;
    assert.deepEqual(input.workflow, { mode: 'checked', checkIds: ['tests'] });
    assert.equal(input.presetId, undefined);
  } finally { await p.close(); }
  const empty = await page({ projects: [] });
  try {
    assert.equal(empty.document.querySelector('#create-task').disabled, true);
    assert.match(empty.document.querySelector('.empty-state').textContent, /Подключить первый проект/);
  } finally { await empty.close(); }
});

test('Codex roles and reviewer configuration can be edited and submitted in the UI', async () => {
  const p = await page();
  try {
    const form = p.document.querySelector('#preset-form');
    form.elements.name.value = 'Codex and review';
    form.elements.agent.value = 'codex'; form.elements.agent.dispatchEvent(new p.window.Event('change'));
    assert.equal(form.elements.profile.value, 'default'); assert.equal(form.elements.profile.options.length, 1);
    form.elements.model.value = 'executor-model'; form.elements.mode.value = 'review'; form.elements.mode.dispatchEvent(new p.window.Event('change'));
    assert.equal(form.querySelector('[data-review-options]').hidden, false);
    form.elements.reviewModel.value = 'review-model'; form.elements.reviewInstructions.value = 'Check compatibility';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.calls.some(c => c.url === '/api/preset'));
    const preset = p.calls.find(c => c.url === '/api/preset').input.preset;
    assert.equal(preset.agent, 'codex'); assert.equal(preset.profile, 'default'); assert.equal(preset.model, 'executor-model');
    assert.deepEqual(preset.workflow.reviewer, { agent: 'codex', profile: 'default', model: 'review-model', instructions: 'Check compatibility' });
    assert.equal(preset.workflow.checkIds, undefined);
    assert.equal(preset.workflow.fixer, undefined);
  } finally { await p.close(); }
});

test('reviewer and fixer can be any agent, profile and model in the UI', async () => {
  for (const maxFixes of ['0', '2']) {
    const p = await page();
    try {
      const form = p.document.querySelector('#preset-form');
      const change = name => form.elements[name].dispatchEvent(new p.window.Event('change'));
      form.elements.name.value = 'Mixed roles';
      form.elements.mode.value = 'review'; change('mode');
      form.elements.reviewAgent.value = 'claude'; change('reviewAgent');
      assert.equal(form.elements.reviewProfile.options.length, 3);
      form.elements.reviewProfile.value = 'litellm'; form.elements.reviewModel.value = 'review-model';
      form.elements.maxFixes.value = maxFixes; change('maxFixes');
      assert.equal(form.querySelector('[data-fixer-options]').hidden, true);
      form.elements.fixerAgent.value = 'codex'; change('fixerAgent');
      assert.equal(form.querySelector('[data-fixer-options]').hidden, false);
      assert.equal(form.elements.fixerProfile.value, 'default');
      form.elements.fixerModel.value = 'fixer-model';
      form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => p.calls.some(c => c.url === '/api/preset'));
      const preset = p.calls.find(c => c.url === '/api/preset').input.preset;
      assert.deepEqual(preset.workflow.reviewer, { agent: 'claude', profile: 'litellm', model: 'review-model', instructions: '' });
      // Without automatic fixes a chosen fixer has nothing to do, so it is not submitted.
      assert.deepEqual(preset.workflow.fixer, maxFixes === '0' ? undefined : { agent: 'codex', profile: 'default', model: 'fixer-model' });
    } finally { await p.close(); }
  }
});

test('review findings render as inert text with criterion status and snapshot validity', async () => {
  const task = { id: 'task-1', projectId: 'project', agent: 'codex', profile: 'default', title: 'Review task', description: 'Fix it', criteria: 'Fixed', workflow: { mode: 'review', checkIds: [], reviewer: { agent: 'codex', model: '', instructions: '' } }, createdAt: new Date().toISOString(), status: 'требуется решение' };
  const p = await page({ tasks: [task] });
  try {
    p.setAttempts([{ id: 'attempt-1', taskId: task.id, agent: 'codex', status: task.status, profile: 'default', directory: project.path, events: [], output: 'Done', checks: 'не настроены', review: 'есть замечания', workflow: task.workflow, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      reviewRun: { status: 'есть замечания', validity: 'совпадает', scope: 'Весь checkout', result: { summary: '<script>bad()</script>', criteria: [{ criterion: 'Works', status: 'unmet', evidence: 'Counterexample' }], findings: [{ severity: 'P1', title: 'Bug', file: 'file.mjs', line: 1, evidence: 'Wrong return' }], limitations: ['No tests'] } } }]);
    p.window.location.hash = 'task/task-1'; await waitFor(() => p.document.querySelector('.review-panel'));
    const panel = p.document.querySelector('.review-panel');
    assert.match(panel.textContent, /Не выполнен/); assert.match(panel.textContent, /file.mjs:1/); assert.match(panel.textContent, /совпадает/);
    assert.equal(panel.querySelector('script'), null); assert.match(panel.textContent, /<script>bad/);
  } finally { await p.close(); }
});

test('automation options are explicit, saved in a preset and disclosed before launch', async () => {
  const p = await page();
  try {
    const preset = p.document.querySelector('#preset-form');
    assert.equal(preset.elements.maxFixes.value, '0');
    preset.elements.name.value = 'Bounded fixes';
    preset.elements.mode.value = 'review'; preset.elements.mode.dispatchEvent(new p.window.Event('change'));
    preset.elements.maxFixes.value = '2'; preset.elements.maxFixes.dispatchEvent(new p.window.Event('change'));
    assert.equal(preset.querySelector('[data-automation-settings]').hidden, false);
    preset.elements.timeBudgetMinutes.value = '15'; preset.elements.fixChecks.checked = false;
    preset.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.calls.some(c => c.url === '/api/preset'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/preset').input.preset.workflow.automation,
      { maxFixes: 2, timeBudgetMinutes: 15, fixChecks: false, fixReview: true });
    const form = p.document.querySelector('#task');
    await waitFor(() => Array.from(form.elements.presetId.options).some(o => o.value === 'new-preset'));
    form.elements.presetId.value = 'new-preset'; form.elements.presetId.dispatchEvent(new p.window.Event('change'));
    assert.equal(form.elements.maxFixes.value, '2'); assert.equal(form.elements.maxFixes.disabled, true);
    form.elements.description.value = 'Fix with review';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.document.querySelector('.launch-preview button'));
    assert.match(p.document.querySelector('.launch-preview').textContent, /до 2 автоматических исправлений/);
    assert.match(p.document.querySelector('.launch-preview').textContent, /15 мин/);
    assert.equal(p.calls.some(c => c.url === '/api/attempt-start'), false);
  } finally { await p.close(); }
});

const graphPreset = { id: 'graph', name: 'С ролями', profile: 'subscription', instructions: '', workflow: { mode: 'graph', graph: { start: 'plan', limits: { maxLoops: 2, timeBudgetMinutes: 60 }, nodes: [
  { id: 'plan', name: 'Гейм-дизайнер', kind: 'read', agent: 'codex', profile: 'default', model: '', instructions: '', next: { success: 'ok' } },
  { id: 'ok', name: 'Подтвердить план', kind: 'human', instructions: 'Подходит ли план?', next: { success: 'exec', failure: 'plan' } },
  { id: 'exec', name: 'Исполнитель', kind: 'executor', next: {} }] } } };
test('the graph stays out of the way: a new task is one agent, and the editor appears only when chosen', async () => {
  const p = await page({ presets: [structuredClone(graphPreset)], projects: [{ ...structuredClone(project), defaultPresetId: '' }] });
  try {
    const task = p.document.querySelector('#task'), form = p.document.querySelector('#preset-form');
    assert.equal(task.elements.workflowMode.value, 'quick');
    assert.equal(p.document.querySelector('#graph-editor').hidden, true);
    assert.equal(Array.from(task.elements.workflowMode.options).find(o => o.value === 'graph').hidden, true);
    task.elements.presetId.value = 'graph'; task.elements.presetId.dispatchEvent(new p.window.Event('change'));
    assert.match(p.document.querySelector('#process-summary').textContent, /Гейм-дизайнер → Подтвердить план → Исполнитель/);
    assert.equal(p.document.querySelector('#task-checks').hidden, true);

    form.elements.mode.value = 'graph'; form.elements.mode.dispatchEvent(new p.window.Event('change'));
    assert.equal(p.document.querySelector('#graph-editor').hidden, false);
    assert.match(p.document.querySelector('#graph-editor').textContent, /Необязательно/);
    assert.equal(p.document.querySelectorAll('.graph-node').length, 1);
    const template = p.document.querySelector('#graph-editor select');
    template.value = 'roles'; template.dispatchEvent(new p.window.Event('change'));
    assert.equal(p.document.querySelectorAll('.graph-node').length, 2);
    assert.match(p.document.querySelector('.graph-map').textContent, /Продюсер \(совещательная\)/);
    const add = Array.from(p.document.querySelectorAll('#graph-editor button')).find(b => b.textContent === 'Добавить шаг'); add.click();
    assert.equal(p.document.querySelectorAll('.graph-node').length, 3);
    form.elements.name.value = 'С ролями 2';
    form.dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => p.calls.some(c => c.url === '/api/preset'));
    const saved = p.calls.find(c => c.url === '/api/preset').input.preset.workflow;
    assert.equal(saved.mode, 'graph'); assert.equal(saved.graph.nodes.length, 3); assert.equal(saved.graph.nodes[1].members[1].blocking, false); assert.equal(saved.checkIds, undefined);
  } finally { await p.close(); }
});
test('the schema draws the route, marks loops and unreachable steps, and picks a step for editing', async () => {
  const p = await page();
  try {
    const form = p.document.querySelector('#preset-form');
    form.elements.mode.value = 'graph'; form.elements.mode.dispatchEvent(new p.window.Event('change'));
    const template = p.document.querySelector('#graph-editor select');
    template.value = 'planned'; template.dispatchEvent(new p.window.Event('change'));
    const svg = p.document.querySelector('#graph-editor svg.graph-diagram');
    const boxes = () => Array.from(p.document.querySelectorAll('#graph-editor .graph-box'));
    assert.deepEqual(boxes().map(box => box.getAttribute('data-node')), ['plan', 'approve', 'exec', 'checks', 'review']);
    assert.equal(p.document.querySelectorAll('#graph-editor .graph-end').length, 1);
    // Rejecting the plan, failed checks and review findings are the three dashed returns.
    assert.equal(svg.querySelectorAll('path.graph-edge.failure').length, 3);
    assert.equal(svg.querySelectorAll('path.graph-edge:not(.failure)').length, 5);
    assert.match(svg.textContent, /Гейм-дизайнер/); assert.match(svg.textContent, /ревью: ролей 1/);
    const review = boxes().find(box => box.getAttribute('data-node') === 'review');
    review.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal(p.document.querySelector('.graph-node.selected').dataset.graphStep, 'review');
    assert.equal(p.document.activeElement, p.document.querySelector('.graph-node.selected input'));
    Array.from(p.document.querySelectorAll('#graph-editor button')).find(b => b.textContent === 'Добавить шаг').click();
    const added = boxes().at(-1);
    assert.match(added.getAttribute('class'), /unreachable/); assert.match(added.textContent, /недостижим/);
  } finally { await p.close(); }
});
test('a waiting step offers a decision, and every step and role shows its own result', async () => {
  const taskRecord = { id: 'task-1', projectId: 'project', title: 'Task', description: 'D', criteria: 'C', agent: 'claude', profile: 'subscription', status: 'ждёт решения', createdAt: new Date().toISOString(), workflow: { ...graphPreset.workflow, checkIds: [] } };
  const p = await page({ tasks: [taskRecord] });
  try {
    const reader = { id: 's1', nodeId: 'plan', name: 'Гейм-дизайнер', kind: 'read', agent: 'codex', profile: 'default', model: '', visit: 1, status: 'выполнение завершено', output: 'План <img src=x>', outputTruncated: false, diagnostics: { output: '' } };
    const report = { id: 's2', nodeId: 'review', memberId: 'prod', name: 'Продюсер', kind: 'review', blocking: false, agent: 'codex', profile: 'default', model: '', visit: 1, status: 'есть замечания', validity: 'совпадает', scope: 'Весь checkout', output: '', diagnostics: { output: '' },
      result: { summary: 'Итог', verdict: 'changes_requested', findings: [{ severity: 'P0', title: 'Срок', file: null, line: null, evidence: 'Три системы' }], criteria: [{ criterion: 'Срок', status: 'met', evidence: 'Да' }], limitations: [] } };
    const waiting = { id: 's3', nodeId: 'ok', name: 'Подтвердить план', kind: 'human', visit: 1, status: 'ждёт решения', instructions: 'Подходит ли план?' };
    p.setAttempts([{ id: 'attempt-1', taskId: 'task-1', status: 'ждёт решения', profile: 'subscription', directory: project.path, events: [], output: '', checks: 'не запрошены', review: 'не запрошено', workflow: taskRecord.workflow, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      automation: { reason: 'Шаг «Подтвердить план» ждёт решения пользователя.', deadlineAt: new Date().toISOString() }, graphRun: { cursor: 'ok', steps: [reader, report, waiting], waiting: { nodeId: 'ok', stepId: 's3' }, decisions: [] } }]);
    p.window.location.hash = 'task/task-1';
    await waitFor(() => p.document.querySelector('.graph-decision'));
    const text = p.document.querySelector('.graph-steps').textContent;
    assert.match(text, /План <img src=x>/); assert.equal(p.document.querySelector('.graph-steps img'), null);
    assert.match(text, /Совещательная роль/); assert.match(text, /Относится к задаче в целом/);
    assert.ok(!Array.from(p.document.querySelectorAll('.graph-steps button')).some(b => /Передать замечания/.test(b.textContent)), 'an advisory report cannot be sent for fixing');
    assert.match(p.document.querySelector('[data-phase]').textContent, /ждёт твоего решения/);
    const box = id => p.document.querySelector(`.automation-progress .graph-box[data-node="${id}"]`);
    assert.match(box('plan').getAttribute('class'), /tone-ok/);
    assert.match(box('ok').getAttribute('class'), /tone-waiting/); assert.match(box('ok').getAttribute('class'), /current/);
    assert.equal(box('exec').getAttribute('tabindex'), null, 'a step that has not run has nothing to show'); assert.match(box('exec').textContent, /не запускался/);
    const planStep = p.document.querySelector('.graph-steps [data-graph-node="plan"]'); planStep.open = false;
    box('plan').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true }));
    assert.equal(planStep.open, true);
    p.document.querySelector('.graph-decision textarea').value = 'Без баланса';
    Array.from(p.document.querySelectorAll('.graph-decision button')).find(b => b.textContent === 'Отклонить').click();
    await waitFor(() => p.calls.some(c => c.url === '/api/attempt-decide'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/attempt-decide').input, { taskId: 'task-1', attemptId: 'attempt-1', approved: false, comment: 'Без баланса' });
  } finally { await p.close(); }
});
test('active automation exposes hold and preserves prior pass output in history', async () => {
  const workflow = { mode: 'review', checkIds: [], reviewer: { agent: 'codex', model: '', instructions: '' }, automation: { maxFixes: 2, timeBudgetMinutes: 30, fixChecks: true, fixReview: true } };
  const task = { id: 'task-1', projectId: 'project', profile: 'subscription', title: 'Automatic fix', description: 'Fix', criteria: 'Works', workflow, status: 'выполнение', createdAt: new Date().toISOString() };
  const p = await page({ tasks: [task] });
  try {
    p.setAttempts([{ id: 'a', taskId: task.id, profile: 'subscription', directory: project.path, workflow, status: 'выполнение', active: true, events: [], output: 'Current answer', startedAt: new Date().toISOString(),
      automation: { currentFix: 1, deadlineAt: new Date(Date.now() + 60000).toISOString(), stopAfterPass: false },
      cycles: [{ index: 0, checks: 'есть ошибки', review: 'есть замечания', output: '<script>Previous answer</script>' }] }]);
    p.window.location.hash = 'task/task-1';
    await waitFor(() => p.document.querySelector('.automation-progress'));
    assert.match(p.document.querySelector('.automation-progress').textContent, /Исправление 1 из 2/);
    assert.match(p.document.querySelector('.cycle-history').textContent, /Previous answer/);
    assert.equal(p.document.querySelector('.cycle-history script'), null);
    const hold = Array.from(p.document.querySelectorAll('button')).find(b => b.textContent === 'Не продолжать автоматически');
    assert.equal(hold.hidden, false); hold.click();
    await waitFor(() => p.calls.some(c => c.url === '/api/attempt-hold'));
    assert.deepEqual(p.calls.find(c => c.url === '/api/attempt-hold').input, { taskId: task.id });
    await waitFor(() => hold.textContent === 'Следующий цикл отменён');
    assert.equal(hold.disabled, true);
  } finally { await p.close(); }
});

test('board groups tasks by status, keeps filters and remembers the view and theme', async () => {
  const base = { projectId: 'project', profile: 'subscription', description: 'Fix', criteria: 'Works', workflow: { mode: 'quick', checkIds: [] }, createdAt: new Date().toISOString() };
  const p = await page({ tasks: [{ ...base, id: 'a', title: 'Denied', status: 'требуется решение' }, { ...base, id: 'b', title: 'Running', status: 'выполнение' }, { ...base, id: 'c', title: 'Answered', status: 'выполнение завершено' }, { ...base, id: 'd', title: 'New', status: 'создана' }] });
  try {
    const { document } = p;
    assert.equal(document.querySelector('.board'), null, 'A narrow window starts with the list');
    assert.equal(document.querySelectorAll('.task-row').length, 4);
    document.querySelector('[data-view-choice=board]').click();
    const columns = () => Array.from(document.querySelectorAll('.board-column'), column => [column.querySelector('h2 span').textContent, Array.from(column.querySelectorAll('.task-row h3'), title => title.textContent)]);
    assert.deepEqual(columns(), [['Требуют внимания', ['Denied']], ['В работе', ['Running']], ['Ответ получен', ['Answered']], ['Не запущены', ['New']]]);
    assert.equal(document.querySelector('#count-created').textContent, '1');
    assert.equal(p.window.localStorage.getItem('taskroom.view'), 'board');
    document.querySelector('.stat[data-filter=attention]').click();
    assert.deepEqual(columns(), [['Требуют внимания', ['Denied']]]);
    assert.equal(document.querySelector('.stat[data-filter=attention]').getAttribute('aria-pressed'), 'true');
    const search = document.querySelector('#task-search'); search.value = 'missing'; search.dispatchEvent(new p.window.Event('input'));
    assert.equal(document.querySelector('.board'), null); assert.match(document.querySelector('.empty-state').textContent, /Ничего не найдено/);
    assert.equal(document.querySelector('[data-theme-choice=dark]').getAttribute('aria-pressed'), 'true');
    document.querySelector('[data-theme-choice=light]').click();
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(p.window.localStorage.getItem('taskroom.theme'), 'light');
    document.querySelector('[data-theme-choice=dark]').click();
    assert.equal(document.documentElement.dataset.theme, undefined);
  } finally { await p.close(); }
});
