let token;
let profileTemplate = [];
let deepTemplate = {};
let projectData = [];
let taskData = [];
let presetData = [];
let selectedTaskId = null;
let autoPrepareId = null;
const freshnessChecked = new Map();
let taskFilter = 'all';
let dashboardSignature = '';
const profileNames = { subscription: 'Подписка', litellm: 'LiteLLM', deepseek: 'DeepSeek', default: 'Стандартный' };
const agentName = value => value?.agent === 'codex' ? 'Codex' : 'Claude';
const projectName = project => project?.path.split(/[\\/]/).filter(Boolean).at(-1) || 'Проект недоступен';
function taskGroup(status) {
  if (['выполнение', 'фиксация результата', 'проверка', 'ревью', 'подготовка исправления', 'остановка'].includes(status)) return 'active';
  if (['требуется решение', 'ждёт решения', 'ошибка', 'прервана', 'таймаут', 'ошибка сохранения'].includes(status)) return 'attention';
  if (['выполнение завершено', 'проверки завершены', 'готова к рассмотрению'].includes(status)) return 'response';
  return 'created';
}
function shortStatus(status) { return { 'выполнение завершено': 'Ответ получен', 'проверки завершены': 'Проверки завершены', 'создана': 'Не запущена', 'фиксация результата': 'Чтение Git-состояния' }[status] || status; }

const projects = document.querySelector('#projects');
const tasks = document.querySelector('#tasks');
const select = document.querySelector('#task select[name="projectId"]');
const message = document.querySelector('#message');
function el(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
// Deleting cannot be undone, so the first click only arms the button.
function deleteButton(label, question, action) {
  const button = el('button', label); button.type = 'button'; button.className = 'secondary danger';
  let timer = null;
  const disarm = () => { clearTimeout(timer); timer = null; button.textContent = label; };
  button.addEventListener('click', async () => {
    if (timer === null) { button.textContent = question; timer = setTimeout(disarm, 5000); return; }
    disarm(); button.disabled = true;
    try { await action(); message.textContent = 'Удалено.'; }
    catch (error) { message.textContent = error.message; button.disabled = false; }
  });
  return button;
}
function statusLabel(status) {
  return { 'выполнение завершено': 'Ответ исполнителя получен; результат задачи не подтверждён',
    'фиксация результата': 'Чтение Git-состояния после исполнителя',
    'проверки завершены': 'Проверки завершены; результат задачи не подтверждён' }[status] || status;
}
const roleLabel = role => `${agentName(role)} · ${role.model || profileNames[role.profile] || role.profile}`;
function workflowLabel(workflow) {
  return { quick: 'Один агент', checked: 'Агент + выбранные проверки', review: 'Агент + проверки + ревью', graph: `Граф шагов: ${workflow?.graph?.nodes.length}` }[workflow?.mode] || 'Агент + все проверки проекта (прежний режим)';
}
const workflowRunsChecks = workflow => workflow.mode === 'graph' ? workflow.graph.nodes.some(node => node.kind === 'checks') : workflow.mode !== 'quick';
const diffStatusNames = { A: 'добавлен', M: 'изменён', D: 'удалён', R: 'переименован', C: 'скопирован', T: 'сменён тип' };
function diffLines(patch) {
  const block = document.createElement('pre'); block.className = 'diff';
  let inHunk = false;
  for (const line of patch.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('diff --git ')) inHunk = false;
    const node = el('span', line + '\n');
    node.className = line.startsWith('@@') ? 'diff-hunk' : !inHunk ? 'diff-meta' : line[0] === '+' ? 'diff-add' : line[0] === '-' ? 'diff-del' : '';
    block.append(node);
  }
  return block;
}
function diffFile(file, open) {
  const item = document.createElement('details'); item.className = 'diff-file';
  const summary = el('summary', `${diffStatusNames[file.status] || file.status} · ${file.originalPath ? `${file.originalPath} → ` : ''}${file.path} · ${file.binary ? 'двоичный' : `+${file.additions} −${file.deletions}`}`);
  item.append(summary);
  // A large patch is turned into DOM only when it is actually read.
  const fill = () => {
    if (item.dataset.filled) return; item.dataset.filled = '1';
    if (file.patch) item.append(diffLines(file.patch));
    if (file.patchTruncated) item.append(el('p', file.patch ? 'Текст изменений обрезан общим лимитом показа.' : 'Текст изменений не показан: достигнут общий лимит показа.'));
  };
  item.addEventListener('toggle', () => { if (item.open) fill(); });
  if (open) { item.open = true; fill(); }
  return item;
}
const diffCache = new Map();
function showDiff(panel, data) {
  for (const node of [...panel.children]) if (node.tagName !== 'SUMMARY') node.remove();
  if (!data.available) { panel.append(el('p', `Diff недоступен. ${data.reason}`)); return; }
  if (data.headChanged) panel.append(el('p', 'HEAD изменился за этот ход: в diff входит и закоммиченное содержимое.'));
  if (!data.files.length) { panel.append(el('p', data.scope === 'initial' ? 'Отличий от HEAD нет.' : 'Снимки совпадают: учтённые файлы не изменились.')); return; }
  const additions = data.files.reduce((sum, file) => sum + file.additions, 0), deletions = data.files.reduce((sum, file) => sum + file.deletions, 0);
  panel.append(el('p', `Файлов: ${data.files.length}, +${additions} −${deletions}. Игнорируемые Git файлы и submodules не входят.`));
  if (data.truncated) panel.append(el('p', `Общий объём текста изменений ограничен ${Math.round(data.patchLimit / 1048576)} МиБ; список файлов полный.`));
  for (const file of data.files) panel.append(diffFile(file, data.files.length <= 10));
}
// Rendered at the end of a turn so that lazily added file sections do not shift restored open states.
function diffPanel(taskId, attempt, scope, title, step) {
  const panel = document.createElement('details'); panel.className = 'diff-panel'; panel.dataset.diff = scope;
  panel.append(el('summary', title));
  // Snapshots never change, so one answer serves every re-render. A pending turn is not cached.
  const key = `${attempt.id}:${scope}:${step ? `${step.id}:${step.after?.snapshot?.tree || ''}` : attempt.after?.snapshot?.tree || ''}`;
  if (diffCache.has(key)) showDiff(panel, diffCache.get(key));
  panel.addEventListener('toggle', async () => {
    if (!panel.open || panel.dataset.loading || diffCache.has(key)) return;
    panel.dataset.loading = '1'; panel.append(el('p', 'Сравниваем снимки…'));
    try {
      const data = await api('attempt-diff', { taskId, attemptId: attempt.id, scope, ...(step ? { stepId: step.id } : {}) });
      if (data.available) diffCache.set(key, data);
      showDiff(panel, data);
    } catch (error) { showDiff(panel, { available: false, reason: error.message }); }
    finally { delete panel.dataset.loading; }
  });
  return panel;
}
function renderWorkflowChecks() {
  const mode = document.querySelector('#task select[name="workflowMode"]').value;
  const chosen = presetData.find(preset => preset.id === document.querySelector('#task').elements.presetId.value);
  const checked = mode === 'graph' ? !!chosen && workflowRunsChecks(chosen.workflow) : mode !== 'quick';
  document.querySelector('#task [data-review-options]').hidden = mode !== 'review';
  document.querySelector('#task-checks').hidden = !checked;
  document.querySelector('#workflow-help').textContent = mode === 'graph' ? 'Шаги, их агенты и условия переходов заданы в процессе.' : mode === 'review' ? 'После исполнителя и выбранных проверок запустится выбранный ревьюер в отдельной сессии.' : checked ? 'Один агент и только отмеченные проверки. Независимое ревью не запускается.' : 'Один агент выполнит задачу. Автоматические проверки и независимое ревью не запускаются.';
  const container = document.querySelector('#task-check-options'); container.replaceChildren();
  if (!checked) return;
  const definitions = projectData.find(project => project.id === select.value)?.checks || [];
  if (!definitions.length) { container.append(el('p', mode === 'review' ? 'Проверки не настроены. Ревью пройдёт без результатов проверок.' : 'Сначала настройте команды проверок проекта или выберите режим «Один агент».')); return; }
  for (const definition of definitions) {
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.name = 'checkIds'; checkbox.value = definition.id; checkbox.checked = true; checkbox.className = 'inline-checkbox';
    label.append(checkbox, document.createTextNode(` ${definition.name}`)); container.append(label);
  }
}
select.addEventListener('change', applyProjectPreset);
document.querySelector('#task select[name="workflowMode"]').addEventListener('change', () => { renderWorkflowChecks(); renderProcessSummary(); });
async function api(endpoint, input) {
  const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token }, body: JSON.stringify(input) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  return result;
}
function showCheckCommands(container, checks, directory, workflow) {
  container.append(el('h4', 'Настроенные проверки'));
  if (workflow && workflow.checkIds !== null && !workflowRunsChecks(workflow)) { container.append(el('p', 'Для этой задачи автоматические проверки не запрошены. Проверки можно будет запустить отдельно после агента.')); return; }
  if (!checks?.length) { container.append(el('p', 'Проверки не настроены. Их отсутствие не считается успешной проверкой.')); return; }
  container.append(el('p', `Рабочая директория всех проверок: ${directory}`));
  for (const check of checks) container.append(el('p', `${check.name} · таймаут ${check.timeoutSeconds} с`), el('pre', JSON.stringify({ executable: check.executable, args: check.args }, null, 2)));
}
const presetCheckIds = (preset, project) => !workflowRunsChecks(preset.workflow) ? [] : project.presetChecks?.[preset.id] ?? (project.checks || []).map(check => check.id);
// Saved in place: rebuilding the project list would collapse the section being edited.
function renderProjectProcesses(container, project) {
  container.replaceChildren();
  const status = el('p', ''); status.setAttribute('role', 'status');
  const saved = (updated, text) => { Object.assign(project, updated); if (select.value === project.id) applyProjectPreset(); renderProjectProcesses(container, project); container.querySelector('[role=status]').textContent = text; };
  const defaultLabel = el('label', 'Процесс по умолчанию'), defaultSelect = document.createElement('select');
  const none = el('option', 'Один агент / свои параметры'); none.value = '';
  defaultSelect.append(none, ...presetData.map(preset => { const option = el('option', preset.name); option.value = preset.id; return option; }));
  defaultSelect.value = project.defaultPresetId || '';
  defaultSelect.addEventListener('change', async () => {
    try { saved(await api('project-default', { projectId: project.id, presetId: defaultSelect.value }), 'Процесс по умолчанию сохранён.'); }
    catch (error) { status.textContent = error.message; defaultSelect.value = project.defaultPresetId || ''; }
  });
  defaultLabel.append(defaultSelect); container.append(defaultLabel);
  const withChecks = presetData.filter(preset => workflowRunsChecks(preset.workflow));
  if (withChecks.length && !project.checks?.length) container.append(el('p', 'Команды проверок ещё не настроены, поэтому выбирать пока нечего.'));
  else for (const preset of withChecks) {
    const group = document.createElement('fieldset'); group.dataset.presetChecks = preset.id;
    group.append(el('legend', preset.name));
    const selected = project.presetChecks?.[preset.id] ?? null, all = selected === null;
    const allLabel = document.createElement('label'), allBox = document.createElement('input');
    allBox.type = 'checkbox'; allBox.className = 'inline-checkbox'; allBox.checked = all; allBox.dataset.all = '';
    allLabel.append(allBox, document.createTextNode(' Все проверки проекта, включая будущие')); group.append(allLabel);
    const boxes = (project.checks || []).map(check => {
      const label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox'; box.className = 'inline-checkbox'; box.value = check.id; box.checked = all || selected.includes(check.id); box.disabled = all;
      label.append(box, document.createTextNode(` ${check.name}`)); group.append(label); return box;
    });
    if (!all && selected.some(id => !project.checks.some(check => check.id === id))) group.append(el('p', 'Часть выбранных проверок удалена из проекта. Новые задачи с этим процессом не запустятся, пока выбор не будет сохранён заново.'));
    if (!all && ['checked', 'graph'].includes(preset.workflow.mode) && !selected.length) group.append(el('p', 'Проверки не выбраны: задачу с этим процессом создать нельзя.'));
    const store = async checkIds => {
      try { saved(await api('project-preset-checks', { projectId: project.id, presetId: preset.id, checkIds }), `Проверки для процесса «${preset.name}» сохранены. Созданные задачи используют свою копию.`); }
      catch (error) { renderProjectProcesses(container, project); container.querySelector('[role=status]').textContent = error.message; }
    };
    allBox.addEventListener('change', () => store(allBox.checked ? null : (project.checks || []).map(check => check.id)));
    for (const box of boxes) box.addEventListener('change', () => store(boxes.filter(item => item.checked).map(item => item.value)));
    container.append(group);
  }
  container.append(status);
}
function projectItem(project) {
  const item = el('li', project.path), details = document.createElement('details');
  details.append(el('summary', 'Настроить команды проверок'));
  details.append(el('p', 'Команды задаются вручную. В режиме «Агент + выбранные проверки» отмеченные команды выполняются после исполнителя в корне проекта с правами текущего пользователя. executable и args передаются напрямую, без автоматического shell. Для PowerShell или .bat задайте powershell.exe с явными аргументами. Не вводите ключи и другие секреты. Пустой список [] означает отсутствие доступных проверок.'));
  const form = document.createElement('form'), label = el('label', 'Профили проверок (JSON)'), input = document.createElement('textarea');
  input.value = JSON.stringify(project.checks || [], null, 2); input.rows = 14;
  input.placeholder = '[{"id":"tests","name":"Тесты","executable":"bun","args":["run","test"],"timeoutSeconds":600}]';
  label.append(input); const save = el('button', 'Сохранить команды проверок'), result = el('p', ''); result.setAttribute('role', 'status');
  form.append(label, save); details.append(form, result); item.append(details);
  const processes = document.createElement('details'); processes.className = 'project-processes';
  processes.append(el('summary', 'Процессы в этом проекте'));
  const processOptions = document.createElement('div'); processes.append(processOptions); item.append(processes);
  renderProjectProcesses(processOptions, project);
  const taskCount = taskData.filter(t => t.projectId === project.id).length;
  item.append(deleteButton('Удалить проект', taskCount ? `Удалить вместе с задачами (${taskCount})?` : 'Точно удалить?', async () => { await api('project-delete', { projectId: project.id }); await refresh(); }));
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    try { const response = await api('project-checks', { projectId: project.id, checks: JSON.parse(input.value) }); project.checks = response.checks; input.value = JSON.stringify(response.checks, null, 2); renderProjectProcesses(processOptions, project); if (select.value === project.id) applyProjectPreset(); result.textContent = 'Команды сохранены. Их можно выбрать при создании задачи; выбранные команды будут показаны перед запуском.'; }
    catch (error) { result.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return item;
}
function attachAttempts(card, main, side, task) {
  const controls = document.createElement('div');
  const prepare = el('button', 'Новый запуск'); prepare.dataset.prepare = ''; prepare.type = 'button';
  const hold = el('button', 'Не продолжать автоматически'); hold.type = 'button'; hold.className = 'secondary'; hold.hidden = true;
  const stop = el('button', 'Остановить'); stop.type = 'button'; stop.className = 'danger'; stop.hidden = true;
  const preview = document.createElement('div'), history = document.createElement('div');
  const feedback = el('p', ''); feedback.setAttribute('role', 'status');
  controls.className = 'run-controls'; preview.className = 'launch-preview';
  const reply = document.createElement('form'); reply.className = 'reply panel'; reply.hidden = true;
  const replyLabel = el('label', 'Продолжить разговор'), replyInput = document.createElement('textarea');
  replyInput.required = true; replyInput.maxLength = 10000; replyInput.placeholder = 'Ответь на вопрос или уточни, что нужно изменить…'; replyLabel.append(replyInput);
  const replyButton = el('button', 'Продолжить →');
  const replyNote = el('p', 'Сообщение продолжит сохранённую сессию исполнителя. Перед запуском проверим директорию.'); replyNote.className = 'subtle';
  reply.append(replyLabel, replyButton, replyNote);
  reply.addEventListener('submit', event => { event.preventDefault(); void prepareRun(replyInput.value); });
  const remove = deleteButton('Удалить задачу', 'Точно удалить?', async () => { await api('task-delete', { taskId: task.id }); location.hash = 'dashboard'; await refresh(); });
  controls.append(prepare, hold, stop, remove); side.prepend(controls, feedback); main.append(preview, history, reply);
  let polling = false, previousRecords = '';
  async function load() {
    const records = await api('attempts', { taskId: task.id });
    if (!card.isConnected) return false;
    const active = records.some(a => a.active);
    if (records.length) {
      const badge = card.querySelector('[data-task-status]');
      badge.textContent = shortStatus(records.at(-1).status); badge.className = `badge ${taskGroup(records.at(-1).status)}`;
    }
    stop.hidden = !active; prepare.disabled = active; remove.hidden = active;
    const latest = records.at(-1);
    hold.hidden = !active || !latest?.automation; hold.disabled = !!latest?.automation?.stopAfterPass;
    hold.textContent = latest?.automation?.stopAfterPass ? 'Следующий цикл отменён' : 'Не продолжать автоматически';
    reply.hidden = !latest?.sessionId;
    replyInput.disabled = replyButton.disabled = active;
    replyNote.textContent = active ? 'Агент работает. Отправить сообщение можно после завершения текущего этапа.' : 'Продолжение сохранённой сессии исполнителя; файлы проверим перед запуском.';
    const phase = card.querySelector('[data-phase]');
    if (phase) phase.textContent = active ? `Сейчас: ${shortStatus(latest.status)} · ${latest.events.at(-1)?.message || 'Ожидаем первое событие'}` : latest ? `Следующий шаг: ${latest.graphRun?.waiting ? 'процесс ждёт твоего решения' : latest.permissionDenials?.length ? 'реши, разрешить ли отклонённые действия' : latest.sessionId ? 'прочитай ответ и при необходимости продолжи разговор' : 'проверь результат; доступен новый запуск'}` : 'Следующий шаг: проверь параметры и запусти исполнителя';
    if (records.length) { prepare.textContent = 'Начать заново'; prepare.className = 'secondary'; }
    const serialized = JSON.stringify(records);
    if (serialized === previousRecords) return active;
    previousRecords = serialized;
    const nodes = records.map((a, index) => {
      const details = document.createElement('details'); details.open = index === records.length - 1;
      details.dataset.attempt = a.id;
      details.append(el('summary', `Ход ${index + 1}: ${statusLabel(a.status)} · ${agentName(a)} / ${a.model || a.profile} · ${new Date(a.startedAt).toLocaleString()}`));
      if (a.message) { const userMessage = el('p', a.message); userMessage.className = 'user-message'; details.append(el('h4', 'Твоё сообщение'), userMessage); }
      details.append(el('p', `Директория: ${a.directory}`), el('p', `Код выхода: ${a.exitCode ?? 'нет'}${a.signal ? `; сигнал: ${a.signal}` : ''}. Проверки: ${a.checks}. Ревью: ${a.review}.`));
      details.append(el('p', `Режим: ${workflowLabel(a.workflow)}`));
      if (a.graphRun) details.append(graphProgress(a));
      else if (a.automation) details.append(automationProgress(a));
      for (const cycle of a.cycles || []) if (cycle.index < a.automation.currentFix) details.append(cycleHistory(cycle));
      if (a.agentStatus) details.append(el('p', a.agentStatus === 'выполнение завершено' ? 'Процесс исполнителя завершился без ошибки. Это не подтверждение выполнения задачи: агент мог вернуть вопрос или частичный ответ.' : `Состояние процесса исполнителя: ${a.agentStatus}`));
      if (a.status === 'фиксация результата') details.append(el('p', 'Исполнитель уже завершился. Читаем файлы и состояние Git для сравнения результата; на большом проекте это может занять десятки секунд.'));
      if (a.error) details.append(el('p', a.error));
      if (a.currentStateError) details.append(el('p', a.currentStateError));
      if (a.permissionDenials?.length) details.append(denialPanel(a.permissionDenials, !active && index === records.length - 1 && a.sessionId ? allowDenied : null));
      const timeline = document.createElement('details'); timeline.append(el('summary', 'События и этапы'));
      for (const event of a.events) timeline.append(el('p', `${new Date(event.at).toLocaleTimeString()} · ${event.message}`));
      details.append(timeline);
      if (a.eventsTruncated) details.append(el('p', 'Показаны первые 200 событий попытки.'));
      if (a.attribution) details.append(el('p', a.attribution));
      if (a.snapshotError) details.append(el('p', a.snapshotError));
      if (a.graphRun) details.append(graphSteps(task.id, a, !active && index === records.length - 1, {
        decide: async (approved, comment) => {
          feedback.textContent = 'Проверяем файлы и продолжаем процесс…';
          try { await api('attempt-decide', { taskId: task.id, attemptId: a.id, approved, comment }); feedback.textContent = 'Решение принято. Статус и вывод обновляются автоматически.'; void poll(); }
          catch (error) { feedback.textContent = error.message; previousRecords = ''; void poll(); }
        },
        fix: a.sessionId ? () => { replyInput.value = 'Проверь замечания последнего ревью и исправь подтверждённые проблемы. Если с замечанием не согласен, объясни почему. Сохрани исходные требования и мои изменения.'; void prepareRun(replyInput.value); } : null
      }));
      else details.append(el('h4', 'Ответ и действия агента'));
      const output = el('pre', a.output || 'Ответа агента пока нет.'); output.className = 'agent-output'; if (!a.graphRun) details.append(output);
      if (a.diagnostics?.output && !a.graphRun) {
        const diagnostics = document.createElement('details'); diagnostics.open = a.agentStatus === 'ошибка';
        diagnostics.append(el('summary', 'Диагностика CLI (stderr)'));
        const log = el('pre', a.diagnostics.output); log.className = 'agent-output'; diagnostics.append(log);
        if (a.diagnostics.outputTruncated) diagnostics.append(el('p', 'Диагностика ограничена 256 Ки символов: сохранены начало и конец, середина пропущена.'));
        details.append(diagnostics);
      }
      if (a.outputTruncated && !a.graphRun) details.append(el('p', 'Журнал ограничен 256 Ки символов: сохранены начало и конец, середина пропущена.'));
      if (a.status === 'выполнение завершено') details.append(el('p', a.sessionId ? 'Ответ получен. Если агент задал вопрос, продолжите разговор ниже.' : 'CLI не вернул идентификатор сессии. Для продолжения доступен новый запуск.'));
      for (const run of a.checkRuns || []) {
        const checkDetails = document.createElement('details'); checkDetails.open = true;
        checkDetails.append(el('summary', `Проверки${a.automation ? ` прохода ${run.cycle + 1}` : ""}: ${run.status}. Состояние файлов: ${run.validity}`));
        checkDetails.append(el('p', `Отпечаток: ${run.snapshot}. Состояние сравнивалось: ${run.validityCheckedAt ? new Date(run.validityCheckedAt).toLocaleString() : 'ещё не проверено'}. После этого файлы могли измениться.`));
        if (run.reason) checkDetails.append(el('p', run.reason));
        for (const check of run.results) {
          const detail = document.createElement('details');
          detail.append(el('summary', `${check.definition.name}: ${check.status}, код выхода ${check.exitCode ?? 'отсутствует'}`));
          detail.append(el('pre', JSON.stringify(check.definition, null, 2)), el('p', `Директория: ${a.directory}`));
          if (check.error) detail.append(el('p', check.error));
          const output = el('pre', check.output || 'Вывода нет.'); output.className = 'agent-output'; detail.append(output);
          if (check.outputTruncated) detail.append(el('p', 'Вывод проверки ограничен 256 Ки символов: сохранены начало и конец, середина пропущена.'));
          checkDetails.append(detail);
        }
        details.append(checkDetails);
      }
      if (a.reviewRun) details.append(reviewPanel(a.reviewRun, !active && index === records.length - 1 && a.sessionId ? () => {
        replyInput.value = 'Проверь замечания последнего независимого ревью и исправь подтверждённые проблемы. Если с замечанием не согласен, объясни почему. Сохрани исходные требования и мои изменения.';
        void prepareRun(replyInput.value);
      } : null));
      details.append(diffPanel(task.id, a, 'attempt', 'Изменения файлов за этот ход'));
      if (a.baseline?.snapshot && !a.baseline.clean) details.append(diffPanel(task.id, a, 'initial', 'Незакоммиченные изменения до запуска (не результат агента)'));
      if (a.endedAt && a.after && !a.graphRun?.waiting) {
        const rerun = el('button', 'Подготовить проверки'); rerun.type = 'button';
        rerun.hidden = index !== records.length - 1;
        rerun.disabled = active;
        rerun.addEventListener('click', async () => {
          rerun.disabled = true; feedback.textContent = 'Проверяем файлы перед запуском проверок…'; preview.replaceChildren();
          try {
            const data = await api('checks-prepare', { taskId: task.id, attemptId: a.id });
            preview.append(el('h4', 'Запуск проверок без повторного вызова исполнителя')); showCheckCommands(preview, data.checks, data.workspace.path);
            const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'inline-checkbox';
            label.append(checkbox, document.createTextNode(' Подтверждаю выполнение показанных команд в этой директории.'));
            const start = el('button', 'Запустить проверки'); start.type = 'button'; start.disabled = true;
            checkbox.addEventListener('change', () => { start.disabled = !checkbox.checked; });
            start.addEventListener('click', async () => {
              start.disabled = true; checkbox.disabled = true; feedback.textContent = 'Повторно проверяем файлы и запускаем проверки…';
              try { await api('checks-start', { taskId: task.id, previewId: data.previewId, confirmed: checkbox.checked }); preview.replaceChildren(); feedback.textContent = 'Проверки запущены.'; void poll(); }
              catch (error) { preview.replaceChildren(); feedback.textContent = error.message; }
            });
            preview.append(label, start); feedback.textContent = '';
          } catch (error) { feedback.textContent = error.message; }
          finally { rerun.disabled = false; }
        });
        details.append(rerun);
      }
      return details;
    });
    const openStates = new Map();
    for (const node of history.children) openStates.set(node.dataset.attempt, [node.open, ...Array.from(node.querySelectorAll('details'), detail => detail.open)]);
    history.replaceChildren(...nodes);
    for (const node of nodes) {
      const previous = openStates.get(node.dataset.attempt);
      if (previous) { node.open = previous[0]; Array.from(node.querySelectorAll('details')).forEach((detail, index) => { if (previous[index + 1] !== undefined) detail.open = previous[index + 1]; }); }
    }
    return active;
  }
  async function poll() {
    if (polling || !card.isConnected) return;
    polling = true;
    try { if (await load()) setTimeout(poll, 750); }
    catch (error) { feedback.textContent = `${error.message}. Повторяем загрузку истории…`; if (card.isConnected) setTimeout(poll, 2000); }
    finally { polling = false; }
  }
  // The panel next to the button has already shown the exact rules, so this click is the confirmation.
  async function allowDenied() {
    feedback.textContent = 'Проверяем файлы и продолжаем сессию с выданными разрешениями…'; preview.replaceChildren();
    try {
      const data = await api('attempt-prepare', { taskId: task.id, message: 'Разрешения выданы. Повтори действия, в которых было отказано, и продолжи задачу.', allowDenied: true });
      await api('attempt-start', { taskId: task.id, previewId: data.previewId, confirmed: true });
      feedback.textContent = 'Продолжение запущено. Статус и вывод обновляются автоматически.'; void poll();
    } catch (error) { feedback.textContent = error.message; }
  }
  async function prepareRun(followup) {
    prepare.disabled = replyButton.disabled = true; feedback.textContent = 'Проверяем содержимое рабочей директории…'; preview.replaceChildren();
    try {
      const data = await api('attempt-prepare', { taskId: task.id, ...(followup === undefined ? {} : { message: followup }) });
      if (data.autoStart) {
        await api('attempt-start', { taskId: task.id, previewId: data.previewId, confirmed: true });
        replyInput.value = ''; feedback.textContent = 'Запущено. Статус и вывод обновляются автоматически.'; void poll();
        return;
      }
      feedback.textContent = '';
      if (data.message) preview.append(el('h4', 'Продолжение разговора'), el('p', data.message));
      preview.append(el('h4', 'Запуск в текущем checkout'), el('p', `Директория: ${data.workspace.path}\nВетка: ${data.workspace.branch || 'detached HEAD'}\nHEAD: ${data.workspace.head || 'нет коммитов'}\nИсполнитель: ${agentName(data)}\nМодель: ${data.model || "из CLI"}\nПрофиль: ${data.profile}`));
      preview.append(el('p', `Режим: ${workflowLabel(data.workflow)}. Ревью: ${data.review}.`));
      if (data.workflow.automation?.maxFixes) { const notice = el('p', automationDescription(data.workflow)); notice.className = 'notice'; preview.append(notice); }
      preview.append(el('p', data.workspace.clean ? 'Рабочая директория чистая.' : `Есть существующие изменения (${data.workspace.changes.length} файлов). Они сохраняются; отделение результата агента от них не гарантируется.`));
      if (data.workspace.changes.length) {
        const list = document.createElement('ul'); list.append(...data.workspace.changes.map(c => el('li', `${c.index}${c.workingTree} · ${c.path}`))); preview.append(list);
      }
      showCheckCommands(preview, data.checks, data.workspace.path, data.workflow);
      if (data.reviewCommand) preview.append(el('h4', `Ревьюер: ${agentName(data.workflow.reviewer)} · только чтение`), el('p', `Модель: ${data.workflow.reviewer.model || 'из настроек CLI'}. Ревью всего текущего checkout, включая существующие изменения.`), el('pre', data.reviewCommand.join(' ')));
      if (data.fixCommand) preview.append(el('h4', `Исправления: ${roleLabel(data.workflow.fixer)}`), el('p', 'Новая сессия при первом исправлении, затем её продолжение.'), el('pre', data.fixCommand.join(' ')));
      if (data.workflow.graph) {
        preview.append(el('h4', 'Шаги процесса'), graphSchema(data.workflow.graph), el('p', `Повторов шага: до ${data.workflow.graph.limits.maxLoops}. Общий лимит: ${data.workflow.graph.limits.timeBudgetMinutes} мин.`));
        for (const role of data.graphCommands) preview.append(el('h4', `${role.name}: ${roleLabel(role)} · ${role.readOnly ? 'только чтение' : 'запись'}`), el('pre', role.command.join(' ')));
      }
      preview.append(el('pre', data.command.join(' ')), el('p', 'Запускайте только в доверенном репозитории: CLI может загрузить его настройки, hooks и MCP. Права определяются показанным режимом CLI; отклонённые действия появятся в задаче, и их можно будет разрешить. Вывод сохраняется локально и может содержать конфиденциальные данные. Не редактируйте файлы параллельно. Лимит попытки — 30 минут.'));
      const label = el('p', 'Нажимая «Запустить», подтверждаешь работу в этом доверенном репозитории с показанными параметрами и существующими изменениями.');
      const start = el('button', followup === undefined ? `Запустить ${agentName(task)} →` : 'Запустить продолжение →'); start.type = 'button';
      start.addEventListener('click', async () => {
        start.disabled = true;
        feedback.textContent = 'Повторно проверяем файлы и запускаем исполнителя…';
        try {
          await api('attempt-start', { taskId: task.id, previewId: data.previewId, confirmed: true });
          replyInput.value = ''; preview.replaceChildren(); feedback.textContent = 'Попытка запущена. Статус и вывод обновляются автоматически.'; void poll();
        } catch (error) { feedback.textContent = error.message; preview.replaceChildren(); }
      });
      preview.append(label, start);
      preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { feedback.textContent = error.message; }
    finally { prepare.disabled = replyButton.disabled = false; }
  }
  prepare.addEventListener('click', () => { void prepareRun(); });
  if (autoPrepareId === task.id) { autoPrepareId = null; setTimeout(() => { if (card.isConnected) void prepareRun(); }, 0); }
  hold.addEventListener('click', async () => {
    hold.disabled = true;
    try { await api('attempt-hold', { taskId: task.id }); feedback.textContent = 'Текущий проход завершится; новые автоматические исправления не начнутся.'; void poll(); }
    catch (error) { feedback.textContent = error.message; hold.disabled = false; }
  });
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try { await api('attempt-stop', { taskId: task.id }); feedback.textContent = 'Остановка запрошена; ждём завершения процесса.'; void poll(); }
    catch (error) { feedback.textContent = error.message; }
    finally { stop.disabled = false; }
  });
  // Results are compared with current files on opening a task and on returning to the page.
  async function refreshFreshness() {
    if (!card.isConnected) { window.removeEventListener('focus', refreshFreshness); return; }
    if (Date.now() - (freshnessChecked.get(task.id) || 0) < 30000) return;
    try {
      const latest = (await api('attempts', { taskId: task.id })).at(-1);
      if (!latest?.endedAt || latest.active || !latest.after || !(latest.reviewRun || latest.checkRuns?.length || latest.graphRun?.steps.some(step => step.kind === 'review'))) return;
      freshnessChecked.set(task.id, Date.now());
      await api('checks-refresh', { taskId: task.id, attemptId: latest.id });
      if (card.isConnected) await load();
    } catch { /* A busy server is not a result; the next opening compares again. */ }
  }
  window.addEventListener('focus', refreshFreshness);
  // The card is attached by refresh immediately after this function returns.
  setTimeout(poll, 0); setTimeout(refreshFreshness, 0);
}
function renderTask(t) {
  const card = document.createElement('article'); card.className = 'task-detail'; card.dataset.taskId = t.id;
  const taskStatus = el('span', shortStatus(t.status)); taskStatus.dataset.taskStatus = ''; taskStatus.className = `badge ${taskGroup(t.status)}`;
  const head = document.createElement('header'); head.className = 'task-head';
  const headMeta = document.createElement('div'); headMeta.className = 'task-head-meta';
  const main = document.createElement('div'); main.className = 'task-main';
  const side = document.createElement('aside'); side.className = 'task-side';
  const route = el('p', `${agentName(t)} · ${t.model || profileNames[t.profile] || t.profile} → ${t.workflow?.mode === 'graph' ? t.workflow.graph.nodes.map(node => node.name).join(' → ') : t.workflow?.mode === 'quick' ? 'Ответ' : t.workflow?.mode === 'review' ? `Проверки → Ревью: ${roleLabel({ profile: 'default', ...t.workflow.reviewer })}${t.workflow.fixer ? ` → Исправления: ${roleLabel(t.workflow.fixer)}` : ''} → Твой просмотр` : 'Проверки → Ответ'}`); route.className = 'workflow-route';
  const phase = el('p', 'Загружаем состояние…'); phase.dataset.phase = ''; phase.className = 'phase';
  headMeta.append(taskStatus, route);
  head.append(el('p', projectName(projectData.find(p => p.id === t.projectId))), el('h1', t.title), headMeta, phase);
  const brief = document.createElement('details'); brief.className = 'task-brief';
  brief.append(el('summary', 'Задание и параметры'), el('h4', 'Описание'), el('p', t.description), el('h4', 'Критерии результата'), el('p', t.criteria), el('p', `Процесс: ${t.preset?.name || workflowLabel(t.workflow)}`));
  if (t.preset?.instructions) brief.append(el('h4', 'Инструкции процесса'), el('p', t.preset.instructions));
  side.append(brief); card.append(head, side, main);
    const inspect = el('button', 'Показать Git-состояние'); inspect.type = 'button';
    const workspace = document.createElement('div'); workspace.setAttribute('aria-live', 'polite');
    inspect.addEventListener('click', async () => {
      inspect.disabled = true; workspace.replaceChildren(el('p', 'Читаем состояние репозитория…'));
      try {
        const response = await fetch('/api/task-workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token }, body: JSON.stringify({ taskId: t.id }) });
        const state = await response.json(); if (!response.ok) throw new Error(state.error);
        workspace.replaceChildren(el('p', `Текущий checkout: ${state.path}`), el('p', `Ветка: ${state.detached ? 'detached HEAD' : state.branch}. HEAD: ${state.head || 'первого коммита ещё нет'}`), el('p', state.clean ? 'Рабочая директория чистая.' : 'Есть существующие изменения. Они принадлежат пользователю и не считаются результатом агента.'));
        if (state.changes.length) {
          const list = document.createElement('ul');
          list.append(...state.changes.map(c => el('li', `${c.untracked ? 'untracked' : `index: ${c.index === ' ' ? '—' : c.index}, working tree: ${c.workingTree === ' ' ? '—' : c.workingTree}`} · ${c.originalPath ? `${c.originalPath} → ` : ''}${c.path}`)));
          workspace.append(list);
        }
        workspace.append(el('p', `Прочитано: ${new Date(state.inspectedAt).toLocaleString()}. Это просмотр состояния; перед запуском потребуется повторная проверка.`));
      } catch (error) { workspace.replaceChildren(el('p', error.message)); }
      finally { inspect.disabled = false; }
    });

  brief.append(inspect, workspace); attachAttempts(card, main, side, t); return card;
}
function storedChoice(key) { try { return localStorage.getItem(key); } catch { return null; } }
function saveChoice(key, value) { try { localStorage.setItem(key, value); } catch { /* The choice just lasts until reload. */ } }
const boardQuery = window.matchMedia?.('(min-width: 1600px)');
let viewChoice = storedChoice('taskroom.view');
const taskView = () => viewChoice || (boardQuery?.matches ? 'board' : 'list');
const boardColumns = { attention: 'Требуют внимания', active: 'В работе', response: 'Ответ получен', created: 'Не запущены' };
function taskRow(t) {
  const row = document.createElement('a'); row.href = `#task/${t.id}`; row.className = 'task-row';
  const icon = document.createElement('span'); icon.className = `task-icon ${taskGroup(t.status)}`; icon.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.className = 'task-row-body'; body.append(el('h3', t.title), el('p', `${projectName(projectData.find(p => p.id === t.projectId))} · ${agentName(t)} / ${profileNames[t.profile] || t.profile} · ${t.preset?.name || workflowLabel(t.workflow)}`));
  const status = el('span', shortStatus(t.status)); status.className = `badge ${taskGroup(t.status)}`;
  row.append(icon, body, status, el('time', new Date(t.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })));
  const wrap = document.createElement('div'); wrap.className = 'task-row-wrap'; wrap.append(row);
  if (taskGroup(t.status) !== 'active') wrap.append(deleteButton('Удалить', 'Точно?', async () => { await api('task-delete', { taskId: t.id }); await refresh(); }));
  return wrap;
}
function renderBoard(list, visible) {
  const groups = taskFilter === 'all' ? Object.keys(boardColumns) : [taskFilter];
  const board = document.createElement('div'); board.className = 'board'; board.dataset.columns = String(groups.length);
  for (const group of groups) {
    const rows = visible.filter(t => taskGroup(t.status) === group);
    const column = document.createElement('section'); column.className = 'board-column';
    const title = document.createElement('h2'); const dot = document.createElement('i'); dot.className = `dot ${group}`;
    title.append(dot, el('span', boardColumns[group]), el('span', rows.length));
    const items = document.createElement('div'); items.className = 'board-list'; items.append(...rows.map(taskRow));
    if (!rows.length) { const empty = el('p', 'Пусто'); empty.className = 'board-empty'; items.append(empty); }
    column.append(title, items); board.append(column);
  }
  list.append(board);
}
function renderDashboard() {
  const query = document.querySelector('#task-search').value.toLocaleLowerCase();
  const view = taskView();
  const signature = JSON.stringify([taskData, projectData.map(p => [p.id, p.path]), taskFilter, query, view]);
  if (signature === dashboardSignature) return;
  dashboardSignature = signature;
  document.querySelector('#count-all').textContent = taskData.length;
  for (const group of Object.keys(boardColumns)) document.querySelector(`#count-${group}`).textContent = taskData.filter(t => taskGroup(t.status) === group).length;
  const visible = [...taskData].reverse().filter(t => (taskFilter === 'all' || taskGroup(t.status) === taskFilter) && `${t.title} ${projectName(projectData.find(p => p.id === t.projectId))}`.toLocaleLowerCase().includes(query));
  const list = document.querySelector('#dashboard-tasks'); list.replaceChildren();
  if (visible.length && view === 'board') renderBoard(list, visible);
  else list.append(...visible.map(taskRow));
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.append(el('span', '↗'), el('h3', taskData.length ? 'Ничего не найдено' : 'Здесь начнётся работа'), el('p', taskData.length ? 'Попробуй другой запрос или статус.' : 'Выбери репозиторий, опиши задачу и передай её агенту.'));
    if (!projectData.length) { const link = el('a', 'Подключить первый проект →'); link.href = '#projects'; empty.append(link); }
    list.append(empty);
  }
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === taskFilter)));
  document.querySelectorAll('[data-view-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.viewChoice === view)));
}
function applyTheme(theme) {
  if (theme === 'dark') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
}
applyTheme(document.documentElement.dataset.theme || 'dark');
document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => { saveChoice('taskroom.theme', button.dataset.themeChoice); applyTheme(button.dataset.themeChoice); }));
document.querySelectorAll('[data-view-choice]').forEach(button => button.addEventListener('click', () => { viewChoice = button.dataset.viewChoice; saveChoice('taskroom.view', viewChoice); renderDashboard(); }));
boardQuery?.addEventListener?.('change', renderDashboard);
function route() {
  const [requested, id] = location.hash.slice(1).split('/');
  const page = ['dashboard', 'task', 'projects', 'workflows', 'settings'].includes(requested) ? requested : 'dashboard';
  document.querySelectorAll('[data-page]').forEach(node => { node.hidden = node.dataset.page !== page; });
  document.querySelectorAll('[data-nav]').forEach(node => { if (node.dataset.nav === (page === 'task' ? 'dashboard' : page)) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  document.querySelector('#breadcrumb').textContent = `Рабочее пространство / ${{dashboard:'Обзор', task:'Задача', projects:'Проекты', workflows:'Процессы', settings:'Подключения'}[page]}`;
  if (page === 'task') {
    const task = taskData.find(t => t.id === id);
    if (selectedTaskId !== id || !tasks.children.length || (task && tasks.firstElementChild.dataset.taskId !== id)) { selectedTaskId = id; tasks.replaceChildren(...(task ? [renderTask(task)] : [el('p', 'Задача не найдена.')])); }
  } else { selectedTaskId = null; tasks.replaceChildren(); }
}
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Не удалось загрузить данные');
  const data = await response.json(); token = data.token; profileTemplate = data.profileTemplate.variables; deepTemplate = data.deepTemplate;
  projectData = data.projects; taskData = data.tasks; presetData = data.presets || [];
  document.querySelector('#recovery').hidden = !data.recoveryRequired;
  document.querySelector('#profiles textarea').value = (data.profiles?.variables || []).map(v => v.source ? `${v.target}=${v.source}` : v.target).join('\n');
  for (const field of document.querySelector('#lite-settings').elements) if (field.name) field.value = data.profiles?.liteSettings?.[field.name] || '';
  for (const field of document.querySelector('#deep-settings').elements) if (field.name) field.value = data.profiles?.deepSettings?.[field.name] || '';
  projects.replaceChildren(...projectData.map(projectItem));
  const previousProject = select.value;
  select.replaceChildren(...projectData.map(p => { const option = el('option', projectName(p)); option.title = p.path; option.value = p.id; return option; }));
  select.value = projectData.some(p => p.id === previousProject) ? previousProject : projectData[0]?.id || '';
  document.querySelector('#create-task').disabled = !projectData.length;
  document.querySelector('#composer-note').textContent = projectData.length ? 'Агент запустится сразу. Подтверждение спросим, только если в репозитории уже есть твои незакоммиченные изменения.' : 'Сначала подключи репозиторий в разделе «Проекты».';
  applyProjectPreset(); renderPresetEditor(); renderDashboard(); route();
}
window.addEventListener('hashchange', route);
document.querySelector('#task-search').addEventListener('input', renderDashboard);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { taskFilter = button.dataset.filter; renderDashboard(); }));
for (const form of document.querySelectorAll('#project, #task, #profiles')) form.addEventListener('submit', async event => {
  event.preventDefault(); message.textContent = '';
  const submit = form.querySelector('button:not([type=button])'); submit.disabled = true;
  try {
    let input = Object.fromEntries(new FormData(form));
    if (form.id === 'task') {
      if (!input.presetId) {
        input.workflow = formWorkflow(form, input.workflowMode);
        if (input.workflow.mode === 'checked' && !input.workflow.checkIds.length) throw new Error('Выберите хотя бы одну проверку или режим «Один агент».');
      }
      delete input.workflowMode; delete input.checkIds; delete input.reviewModel; delete input.reviewInstructions;
      for (const key of ['maxFixes', 'timeBudgetMinutes', 'fixChecks', 'fixReview']) delete input[key];
      if (!input.presetId) delete input.presetId;
    }
    if (form.id === 'profiles') {
      const lines = input.variables.split('\n').map(line => line.trim()).filter(Boolean);
      if (lines.some(line => !/^[A-Za-z_][A-Za-z0-9_]*(?:\s*=\s*[A-Za-z_][A-Za-z0-9_]*)?$/.test(line))) throw new Error('Укажите только имена переменных или пары имён через знак =');
      input = { variables: lines.map(line => { const [target, source = ''] = line.split('=').map(value => value.trim()); return { target, source }; }) };
    }
    const endpoint = { project: 'projects', task: 'tasks', profiles: 'profiles' }[form.id];
    const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token }, body: JSON.stringify(input) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    form.reset();
    if (form.id === 'task') { autoPrepareId = result.id; location.hash = `task/${result.id}`; selectedTaskId = null; }
    await refresh(); message.textContent = form.id === 'task' ? 'Задача создана. Подготавливаем запуск…' : 'Сохранено';
  } catch (error) { message.textContent = error.message; }
  finally { submit.disabled = form.id === 'task' && !projectData.length; }
});
for (const [id, endpoint] of [['lite-settings', 'litellm-settings'], ['lite-key', 'litellm-key'], ['deep-settings', 'deepseek-settings'], ['deep-key', 'deepseek-key']]) document.getElementById(id).addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const result = document.querySelector(id.startsWith('deep') ? '#deep-result' : '#lite-result'); result.textContent = '';
  try {
    const fields = Object.fromEntries(new FormData(form));
    const payload = id.endsWith('-key') ? fields : { settings: fields };
    const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token }, body: JSON.stringify(payload) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    if (id.endsWith('-key')) form.reset();
    result.textContent = id.endsWith('-key') ? 'Ключ сохранён в Windows Credential Manager.' : 'Параметры сохранены.';
  } catch (error) { result.textContent = error.message; }
});
document.querySelector('#deep-template').addEventListener('click', () => {
  for (const field of document.querySelector('#deep-settings').elements) if (field.name) field.value = deepTemplate[field.name] || '';
  document.querySelector('#deep-result').textContent = 'Шаблон заполнен; сохраните параметры, чтобы применить.';
});
document.querySelector('#profile-template').addEventListener('click', () => {
  document.querySelector('#profiles textarea').value = profileTemplate.map(v => v.source ? `${v.target}=${v.source}` : v.target).join('\n');
  message.textContent = 'Шаблон заполнен; сохраните его, чтобы применить.';
});
for (const [id, profile] of [['check-sub', 'subscription'], ['check-lite', 'litellm'], ['check-deep', 'deepseek']]) document.getElementById(id).addEventListener('click', async () => {
  const result = document.querySelector(profile === 'deepseek' ? '#deep-result' : '#profile-result'); result.textContent = 'Проверка…';
  try {
    const response = await fetch('/api/profile-check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token }, body: JSON.stringify({ profile }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    result.textContent = profile === 'subscription' ? (data.loggedIn ? 'Claude CLI сообщает о входе. Вызов модели не проверен.' : (data.error || 'Вход не подтверждён.')) : (!data.configured ? 'Сначала сохраните настройки профиля.' : data.missing.length ? `Не найдены значения: ${data.missing.join(', ')}. Ключ в хранилище: ${data.keySaved ? 'есть' : 'нет'}.` : `Все указанные значения присутствуют. Ключ в хранилище: ${data.keySaved ? 'есть' : 'нет'}. Подключение к модели не проверено.`);
  } catch (error) { result.textContent = error.message; }
});
refresh().catch(error => { message.textContent = error.message; });
document.querySelector('#recovery-confirm').addEventListener('click', async () => {
  try { await api('recovery-acknowledge', { confirmed: true }); await refresh(); }
  catch (error) { message.textContent = error.message; }
});
function renderProcessSummary() {
  const form = document.querySelector('#task');
  const profile = form.elements.profile.value;
  const mode = form.elements.workflowMode.value;
  const graph = presetData.find(preset => preset.id === form.elements.presetId.value)?.workflow.graph;
  if (graph) { document.querySelector('#process-summary').textContent = `${graph.nodes.map(node => node.name).join(' → ')} · до ${graph.limits.timeBudgetMinutes} мин`; return; }
  const fixes = mode === 'review' && Number(form.elements.maxFixes.value) > 0;
  const reviewer = { agent: form.elements.reviewAgent.value, profile: form.elements.reviewProfile.value, model: form.elements.reviewModel.value };
  const fixer = form.elements.fixerAgent.value ? { agent: form.elements.fixerAgent.value, profile: form.elements.fixerProfile.value, model: form.elements.fixerModel.value } : null;
  document.querySelector('#process-summary').textContent = `${agentName({ agent: form.elements.agent.value })} · ${form.elements.model.value || profileNames[profile]} → ${mode !== 'quick' ? 'Выбранные проверки → ' : ''}${mode === 'review' ? `Ревью: ${roleLabel(reviewer)} → ` : ''}Твой просмотр результата${fixes ? ` · до ${form.elements.maxFixes.value} исправлений (${fixer ? roleLabel(fixer) : 'исполнитель'}) / ${form.elements.timeBudgetMinutes.value} мин` : ''}`;
}
function applyProjectPreset() {
  const project = projectData.find(p => p.id === select.value);
  const presetSelect = document.querySelector('#task-preset');
  const custom = el('option', 'Один агент / свои параметры'); custom.value = '';
  presetSelect.replaceChildren(custom, ...presetData.map(p => { const option = el('option', p.name); option.value = p.id; return option; }));
  presetSelect.value = project?.defaultPresetId || '';
  applyTaskPreset();
}
function applyTaskPreset() {
  const form = document.querySelector('#task');
  const preset = presetData.find(p => p.id === form.elements.presetId.value);
  const project = projectData.find(p => p.id === select.value);
  form.elements.agent.value = preset?.agent || 'claude';
  syncProfiles(form, preset?.profile);
  for (const name of ['agent', 'model', 'profile', 'workflowMode', 'reviewAgent', 'reviewProfile', 'reviewModel', 'reviewInstructions', 'fixerAgent', 'fixerProfile', 'fixerModel', 'maxFixes', 'timeBudgetMinutes', 'fixChecks', 'fixReview']) form.elements[name].disabled = !!preset;
  form.elements.model.value = preset?.model || '';
  setRoleFields(form, preset?.workflow);
  setAutomationFields(form, preset?.workflow.automation);
  form.elements.workflowMode.value = preset?.workflow.mode || 'quick';
  renderWorkflowChecks();
  for (const input of document.querySelectorAll('#task-check-options input')) { input.disabled = !!preset; if (preset && project) input.checked = presetCheckIds(preset, project).includes(input.value); }
  renderProcessSummary();
}
document.querySelector('#task-preset').addEventListener('change', applyTaskPreset);
document.querySelector('#task select[name="profile"]').addEventListener('change', renderProcessSummary);
function renderPresetEditor(preset) {
  const form = document.querySelector('#preset-form'); form.reset();
  form.elements.presetId.value = preset?.id || '';
  form.elements.name.value = preset?.name || '';
  form.elements.agent.value = preset?.agent || 'claude'; syncProfiles(form, preset?.profile);
  form.elements.model.value = preset?.model || '';
  setRoleFields(form, preset?.workflow);
  setAutomationFields(form, preset?.workflow.automation);
  form.elements.mode.value = preset?.workflow.mode || 'quick';
  form.elements.instructions.value = preset?.instructions || '';
  document.querySelector('#preset-editor-title').textContent = preset ? 'Редактировать процесс' : 'Новый процесс';
  graphDraft = preset?.workflow.graph ? JSON.parse(JSON.stringify(preset.workflow.graph)) : null;
  syncPresetMode();
  const list = document.querySelector('#preset-list'); list.replaceChildren();
  for (const item of presetData) {
    const row = document.createElement('div'); row.className = 'preset-row';
    const defaults = projectData.filter(p => p.defaultPresetId === item.id).map(projectName);
    const body = document.createElement('div'); body.append(el('h3', item.name), el('p', `${agentName(item)} · ${item.model || profileNames[item.profile]} · ${workflowLabel(item.workflow)}${defaults.length ? ` · по умолчанию: ${defaults.join(', ')}` : ''}`));
    const edit = el('button', 'Изменить'); edit.type = 'button'; edit.className = 'secondary'; edit.addEventListener('click', () => renderPresetEditor(item));
    row.append(body, edit, deleteButton('Удалить', defaults.length ? 'Удалить и сбросить в проектах?' : 'Точно удалить?', async () => { await api('preset-delete', { presetId: item.id }); await refresh(); }));
    list.append(row);
  }
  if (!presetData.length) list.append(el('p', 'Процессов пока нет. Создай первый в форме рядом.'));
}
document.querySelector('#preset-reset').addEventListener('click', () => renderPresetEditor());
function syncPresetMode() {
  const form = document.querySelector('#preset-form'), mode = form.elements.mode.value;
  document.querySelector('#preset-checks').hidden = mode === 'quick';
  form.querySelector('[data-review-options]').hidden = mode !== 'review';
  document.querySelector('#graph-editor').hidden = mode !== 'graph';
  if (mode === 'graph') { graphDraft ??= graphTemplates.single.build(); renderGraphEditor(); }
}
document.querySelector('#preset-form select[name="mode"]').addEventListener('change', syncPresetMode);
document.querySelector('#preset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, data = new FormData(form), result = document.querySelector('#preset-result'), submit = form.querySelector('button:not([type=button])');
  submit.disabled = true;
  try {
    const { checkIds, ...workflow } = formWorkflow(form, data.get('mode'));
    const preset = { name: data.get('name'), agent: data.get('agent'), model: data.get('model'), profile: data.get('profile'), instructions: data.get('instructions'), workflow };
    await api('preset', { presetId: data.get('presetId'), preset });
    await refresh(); result.textContent = 'Процесс сохранён. Начатые задачи используют свою копию настроек.';
  } catch (error) { result.textContent = error.message; }
  finally { submit.disabled = false; }
});
// Refresh only dashboard data; never reset an in-progress form or the task conversation.
let dashboardPollBusy = false;
setInterval(async () => {
  if (dashboardPollBusy || document.hidden || !token) return;
  dashboardPollBusy = true;
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error();
    const data = await response.json(); token = data.token; taskData = data.tasks;
    document.querySelector('#recovery').hidden = !data.recoveryRequired;
    renderDashboard();
  } catch { message.textContent = 'Нет связи с сервером. Повторяем подключение…'; }
  finally { dashboardPollBusy = false; }
}, 2500);
function syncProfiles(form, preferred, agentField = 'agent', profileField = 'profile') {
  const names = form.elements[agentField].value === 'codex' ? ['default'] : ['subscription', 'litellm', 'deepseek'];
  const previous = preferred || form.elements[profileField].value;
  form.elements[profileField].replaceChildren(...names.map(name => { const option = el('option', profileNames[name]); option.value = name; return option; }));
  form.elements[profileField].value = names.includes(previous) ? previous : names[0];
}
function setRoleFields(form, workflow) {
  const reviewer = workflow?.reviewer, fixer = workflow?.fixer;
  form.elements.reviewAgent.value = reviewer?.agent || 'codex'; syncProfiles(form, reviewer?.profile, 'reviewAgent', 'reviewProfile');
  form.elements.reviewModel.value = reviewer?.model || '';
  form.elements.reviewInstructions.value = reviewer?.instructions || '';
  form.elements.fixerAgent.value = fixer?.agent || ''; syncProfiles(form, fixer?.profile, 'fixerAgent', 'fixerProfile');
  form.elements.fixerModel.value = fixer?.model || '';
  form.querySelector('[data-fixer-options]').hidden = !fixer;
}
function formWorkflow(form, mode) {
  if (mode === 'graph') return { mode, checkIds: [], graph: JSON.parse(JSON.stringify(graphDraft)) };
  const workflow = { mode, checkIds: mode === 'quick' ? [] : new FormData(form).getAll('checkIds') };
  if (mode === 'review') {
    workflow.reviewer = { agent: form.elements.reviewAgent.value, profile: form.elements.reviewProfile.value, model: form.elements.reviewModel.value.trim(), instructions: form.elements.reviewInstructions.value.trim() };
    if (Number(form.elements.maxFixes.value) > 0) {
      workflow.automation = { maxFixes: Number(form.elements.maxFixes.value), timeBudgetMinutes: Number(form.elements.timeBudgetMinutes.value), fixChecks: form.elements.fixChecks.checked, fixReview: form.elements.fixReview.checked };
      if (form.elements.fixerAgent.value) workflow.fixer = { agent: form.elements.fixerAgent.value, profile: form.elements.fixerProfile.value, model: form.elements.fixerModel.value.trim() };
    }
  }
  return workflow;
}
for (const id of ['task', 'preset-form']) {
  const form = document.getElementById(id), summary = () => { if (id === 'task') renderProcessSummary(); };
  form.elements.agent.addEventListener('change', () => { syncProfiles(form); summary(); });
  form.elements.reviewAgent.addEventListener('change', () => { syncProfiles(form, undefined, 'reviewAgent', 'reviewProfile'); summary(); });
  form.elements.fixerAgent.addEventListener('change', () => { syncProfiles(form, undefined, 'fixerAgent', 'fixerProfile'); form.querySelector('[data-fixer-options]').hidden = !form.elements.fixerAgent.value; summary(); });
  for (const name of ['reviewProfile', 'fixerProfile']) form.elements[name].addEventListener('change', summary);
  for (const name of ['model', 'reviewModel', 'fixerModel']) form.elements[name].addEventListener('input', summary);
  setRoleFields(form);
}
document.querySelector('#check-codex').addEventListener('click', async event => {
  const button = event.currentTarget, result = document.querySelector('#codex-result'); button.disabled = true;
  result.textContent = 'Проверяем вход Codex CLI…';
  try { const response = await api('profile-check', { agent: 'codex' }); result.textContent = response.loggedIn ? 'Codex CLI сообщает о входе. Доступ к выбранной модели проверяется при запуске.' : response.error; }
  catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});
function reviewPanel(run, onFix) {
  const panel = document.createElement('section'); panel.className = 'review-panel';
  const label = run.validity === 'устарели' ? 'устарело' : run.status === 'пройдено' && run.validity !== 'совпадает' ? 'актуальность не подтверждена' : run.status;
  if (run.blocking === false) panel.append(el('p', 'Совещательная роль: её мнение не влияет на готовность и не запускает исправления.'));
  panel.append(el('h2', `${run.name || 'Независимое ревью'} · ${label}`), el('p', `${agentName(run)} · ${run.model || 'модель из CLI'} · ${run.scope}`),
    el('p', `Актуальность: ${run.validity}. Последнее сравнение: ${run.validityCheckedAt ? new Date(run.validityCheckedAt).toLocaleString() : 'ещё не выполнено'}. После этого файлы могли измениться.`));
  if (run.reason) panel.append(el('p', run.reason));
  if (run.result) {
    panel.append(el('h3', 'Итог'), el('p', run.result.summary));
    panel.append(el('h3', 'Критерии результата'));
    for (const c of run.result.criteria) {
      const item = document.createElement('div'); item.className = 'review-criterion';
      item.append(el('strong', `${{met: 'Подтверждён ревьюером', unmet: 'Не выполнен', unknown: 'Не подтверждён'}[c.status]} · ${c.criterion}`), el('p', c.evidence)); panel.append(item);
    }
    panel.append(el('h3', `Замечания · ${run.result.findings.length}`));
    for (const finding of run.result.findings) {
      const item = document.createElement('details'); item.open = true;
      item.append(el('summary', `${finding.severity} · ${finding.title}`), el('p', finding.file === null ? 'Относится к задаче в целом' : finding.line === null ? finding.file : `${finding.file}:${finding.line}`), el('p', finding.evidence)); panel.append(item);
    }
    if (run.result.limitations.length) { panel.append(el('h3', 'Ограничения')); for (const text of run.result.limitations) panel.append(el('p', text)); }
    panel.append(el('p', 'Это заключение ревьюера, а не принятие изменений пользователем.'));
    if (onFix && run.blocking !== false && (run.result.findings.length || run.result.criteria.some(c => c.status === 'unmet'))) {
      const fix = el('button', 'Передать замечания исполнителю →'); fix.type = 'button'; fix.addEventListener('click', onFix); panel.append(fix);
    }
  }
  const logs = document.createElement('details'); logs.append(el('summary', 'Журнал ревьюера'), el('pre', run.output || 'Вывода пока нет.'));
  if (run.diagnostics?.output) logs.append(el('h4', 'Диагностика CLI'), el('pre', run.diagnostics.output));
  if (run.outputTruncated || run.diagnostics?.outputTruncated) logs.append(el('p', 'Журнал ограничен: сохранены начало и конец, середина пропущена.'));
  panel.append(logs); return panel;
}
function setAutomationFields(form, automation) {
  form.elements.maxFixes.value = String(automation?.maxFixes || 0);
  form.elements.timeBudgetMinutes.value = String(automation?.timeBudgetMinutes || 30);
  form.elements.fixChecks.checked = automation?.fixChecks ?? true;
  form.elements.fixReview.checked = automation?.fixReview ?? true;
  form.querySelector('[data-automation-settings]').hidden = !automation?.maxFixes;
}
function denialPanel(denials, allow) {
  const box = document.createElement('div'); box.className = 'notice'; box.dataset.denials = '';
  box.append(el('h4', 'CLI отклонил действия'));
  for (const denial of denials) {
    box.append(el('p', denial.tool), el('pre', denial.detail || 'Параметры не переданы.'));
    box.append(el('p', denial.rule ? `Будет разрешено: ${denial.rule}` : 'CLI не примет точное правило для такого действия, поэтому кнопка его не разрешит. Выполни его вручную или попроси агента обойтись без него.'));
  }
  if (allow && denials.some(denial => denial.rule)) {
    const button = el('button', 'Разрешить и продолжить'); button.type = 'button';
    button.addEventListener('click', () => { button.disabled = true; void allow(); });
    box.append(button, el('p', 'Разрешения действуют в этой сессии до нового запуска задачи. Текст команд написан агентом: прочитай его перед подтверждением.'));
  }
  return box;
}
function automationDescription(workflow) {
  const a = workflow.automation;
  return `Первый проход + до ${a.maxFixes} автоматических исправлений. Каждый проход: исполнитель → выбранные проверки → ревью. Общий лимит — ${a.timeBudgetMinutes} мин. Причины исправления: ${[a.fixChecks ? 'ошибки проверок' : '', a.fixReview ? 'замечания ревью' : ''].filter(Boolean).join(' и ')}. При неопределённости, отсутствии прогресса или повторении проблем процесс остановится.`;
}
function automationProgress(attempt) {
  const box = document.createElement('div'); box.className = 'automation-progress';
  const a = attempt.automation;
  box.append(el('strong', a.currentFix ? `Исправление ${a.currentFix} из ${attempt.workflow.automation.maxFixes}` : 'Первый проход'),
    el('p', a.reason || 'После проверок и ревью определим, нужно ли исправление.'),
    el('p', `Общий срок: ${new Date(a.deadlineAt).toLocaleString()}. ${a.stopAfterPass ? 'Новые исправления запрещены пользователем.' : 'Можно остановить выполнение или запретить следующий цикл.'}`));
  return box;
}
const stepKindNames = { executor: 'Исполнитель задачи', write: 'Другой агент: запись', read: 'Роль: только чтение, ответ текстом', review: 'Ревью: заключения ролей', checks: 'Проверки проекта', human: 'Подтверждение человека' };
function graphOutline(graph, attempt) {
  const names = new Map(graph.nodes.map(node => [node.id, node.name])), target = id => id === 'end' ? 'конец' : names.get(id);
  const list = document.createElement('ol'); list.className = 'graph-map';
  for (const node of graph.nodes) {
    const steps = attempt?.graphRun.steps.filter(step => step.nodeId === node.id) || [], last = steps.at(-1);
    const item = el('li', '');
    item.append(el('strong', node.name), el('span', ` · ${stepKindNames[node.kind]}${node.id === graph.start ? ' · начало' : ''}`));
    if (node.kind === 'review') item.append(el('p', `Роли: ${node.members.map(member => `${member.name} (${member.blocking ? `блокирует от ${member.blockAt}` : 'совещательная'})`).join(', ')}`));
    const routes = [`далее → ${target(node.next.success ?? 'end')}`];
    if (['review', 'checks', 'human'].includes(node.kind)) routes.push(`${node.kind === 'human' ? 'при отказе' : 'при проблемах'} → ${node.next.failure ? target(node.next.failure) : 'решение пользователя'}`);
    item.append(el('p', routes.join('; ')));
    if (attempt) { item.append(el('p', last ? `Запусков: ${new Set(steps.map(step => step.visit)).size}. Последний: ${last.status}.` : 'Не запускался.')); if (attempt.graphRun.cursor === node.id && !attempt.endedAt) item.dataset.current = ''; }
    list.append(item);
  }
  return list;
}
const stepShortNames = { executor: 'исполнитель', write: 'другой агент: запись', read: 'только чтение', checks: 'проверки проекта', human: 'решение человека' };
const stepTones = { ok: 'готово', problem: 'проблемы', running: 'идёт', waiting: 'ждёт решения', stopped: 'прервано' };
function svgEl(tag, attributes = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
// A review step has several roles; an advisory role's opinion is not a problem of the process.
function stepTone(steps) {
  const latest = steps.filter(step => step.visit === steps.at(-1).visit), statuses = latest.map(step => step.status);
  if (statuses.includes('ждёт решения')) return 'waiting';
  if (statuses.some(status => ['выполняется', 'выполняются'].includes(status))) return 'running';
  if (statuses.some(status => ['прервано', 'прерваны'].includes(status))) return 'stopped';
  return latest.filter(step => step.blocking !== false).every(step => ['выполнение завершено', 'пройдены', 'пройдено', 'подтверждено', 'замечания ниже порога'].includes(step.status)) ? 'ok' : 'problem';
}
// The main route runs down the page and every other edge arcs on the right, so loops stand out instead of crossing boxes.
function graphDiagram(graph, attempt, onSelect) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), order = [], seen = new Set();
  const walk = id => {
    if (id === 'end' || seen.has(id) || !nodes.has(id)) return;
    seen.add(id); order.push(id);
    walk(nodes.get(id).next.success ?? 'end'); walk(nodes.get(id).next.failure ?? 'end');
  };
  walk(graph.start);
  const reachable = new Set(order);
  for (const node of graph.nodes) if (!seen.has(node.id)) order.push(node.id);
  order.push('end');
  const row = new Map(order.map((id, index) => [id, index]));
  const boxLeft = 8, boxWidth = 236, boxHeight = 46, gap = 26, boxRight = boxLeft + boxWidth, centerX = boxLeft + boxWidth / 2;
  const top = index => 8 + index * (boxHeight + gap), middle = index => top(index) + boxHeight / 2;
  const straight = [], arcs = [];
  for (const node of graph.nodes) {
    const from = row.get(node.id), success = row.get(node.next.success ?? 'end'), failure = row.get(node.next.failure);
    if (success !== undefined) { if (success === from + 1) straight.push(from); else arcs.push({ from, to: success, kind: 'success' }); }
    if (failure !== undefined) arcs.push({ from, to: failure, kind: 'failure' });
  }
  arcs.sort((a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to));
  const lanes = [];
  for (const arc of arcs) {
    const low = Math.min(arc.from, arc.to), high = Math.max(arc.from, arc.to);
    let lane = lanes.findIndex(taken => !taken.some(([a, b]) => low <= b && a <= high));
    if (lane < 0) lane = lanes.push([]) - 1;
    lanes[lane].push([low, high]); arc.lane = lane;
  }
  const width = boxRight + 18 * lanes.length + 14, height = top(order.length - 1) + boxHeight + 8;
  const svg = svgEl('svg', { class: 'graph-diagram', viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', 'aria-label': 'Схема процесса' });
  for (const from of straight) {
    svg.append(svgEl('path', { class: 'graph-edge', d: `M ${centerX} ${top(from) + boxHeight} V ${top(from + 1) - 7}` }),
      svgEl('polygon', { class: 'graph-arrow', points: `${centerX},${top(from + 1)} ${centerX - 4},${top(from + 1) - 7} ${centerX + 4},${top(from + 1) - 7}` }));
  }
  for (const arc of arcs) {
    const x = boxRight + 18 * (arc.lane + 1), y1 = middle(arc.from) + (arc.kind === 'failure' ? 10 : -10), y2 = middle(arc.to), direction = y2 > y1 ? 1 : -1, tone = arc.kind === 'failure' ? ' failure' : '';
    svg.append(svgEl('path', { class: `graph-edge${tone}`, d: `M ${boxRight} ${y1} H ${x - 6} Q ${x} ${y1} ${x} ${y1 + direction * 6} V ${y2 - direction * 6} Q ${x} ${y2} ${x - 6} ${y2} H ${boxRight + 7}` }),
      svgEl('polygon', { class: `graph-arrow${tone}`, points: `${boxRight},${y2} ${boxRight + 7},${y2 - 4} ${boxRight + 7},${y2 + 4}` }));
  }
  const current = attempt && (attempt.graphRun.waiting?.nodeId ?? (attempt.endedAt ? null : attempt.graphRun.cursor));
  for (const id of order) {
    const index = row.get(id);
    if (id === 'end') {
      const end = svgEl('g', { class: 'graph-end' });
      end.append(svgEl('rect', { x: boxLeft, y: top(index) + 8, width: boxWidth, height: boxHeight - 16, rx: 15 }), svgEl('text', { x: centerX, y: top(index) + 28, 'text-anchor': 'middle' }, attempt ? 'Конец: твой просмотр' : 'Конец'));
      svg.append(end); continue;
    }
    const node = nodes.get(id), steps = attempt?.graphRun.steps.filter(step => step.nodeId === id) || [], tone = steps.length ? stepTone(steps) : '';
    const runs = new Set(steps.map(step => step.visit)).size;
    const kind = node.kind === 'review' ? `ревью: ролей ${node.members.length}` : stepShortNames[node.kind];
    const sub = !reachable.has(id) ? 'недостижим: задай переход сюда' : !attempt ? kind : !steps.length ? 'не запускался' : `${stepTones[tone]}${runs > 1 ? ` · запусков: ${runs}` : ''}`;
    const open = ['review', 'checks', 'human'].includes(node.kind) && !node.next.failure;
    const box = svgEl('g', { class: ['graph-box', tone && `tone-${tone}`, id === current ? 'current' : '', reachable.has(id) ? '' : 'unreachable'].filter(Boolean).join(' '), 'data-node': id });
    box.append(svgEl('title', {}, `${node.name}. ${stepKindNames[node.kind]}.${open ? ' При проблемах решение за пользователем.' : ''}`),
      svgEl('rect', { x: boxLeft, y: top(index), width: boxWidth, height: boxHeight, rx: 8 }),
      svgEl('text', { x: boxLeft + 12, y: top(index) + 20, class: 'graph-name' }, clip(node.name, 28)),
      svgEl('text', { x: boxLeft + 12, y: top(index) + 37, class: 'graph-sub' }, clip(sub, 36)));
    if (onSelect && (!attempt || steps.length)) {
      box.setAttribute('tabindex', '0'); box.setAttribute('role', 'button'); box.setAttribute('aria-label', `Показать шаг: ${node.name}`); box.classList.add('selectable');
      box.addEventListener('click', () => onSelect(id, box));
      box.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(id, box); } });
    }
    svg.append(box);
  }
  return svg;
}
function graphSchema(graph, attempt, onSelect) {
  const box = document.createElement('div'); box.className = 'graph-schema';
  const words = document.createElement('details'); words.append(el('summary', 'То же текстом'), graphOutline(graph, attempt));
  const legend = el('p', 'Сплошная линия: следующий шаг. Пунктир: при проблемах или отказе. Если пунктира нет, решение остаётся за тобой.'); legend.className = 'subtle';
  box.append(graphDiagram(graph, attempt, onSelect), legend, words);
  return box;
}
function showAttemptStep(id, source) {
  const found = [...source.closest('[data-attempt]').querySelectorAll('[data-graph-node]')].filter(node => node.dataset.graphNode === id).at(-1);
  if (!found) return;
  if (found.tagName === 'DETAILS') found.open = true;
  found.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}
function graphProgress(attempt) {
  const box = document.createElement('div'); box.className = 'automation-progress';
  box.append(el('strong', attempt.graphRun.waiting ? 'Ждём твоего решения' : attempt.endedAt ? 'Процесс остановлен' : 'Процесс идёт'),
    el('p', attempt.automation.reason || 'Следующий шаг определяется результатом текущего.'),
    el('p', `Общий срок: ${new Date(attempt.automation.deadlineAt).toLocaleString()}. ${attempt.automation.stopAfterPass ? 'Повторы шагов запрещены пользователем.' : ''}`));
  const map = document.createElement('details'); map.open = true; map.append(el('summary', 'Схема процесса'), graphSchema(attempt.workflow.graph, attempt, showAttemptStep)); box.append(map);
  return box;
}
function graphDecision(step, decide) {
  const form = document.createElement('div'); form.className = 'notice graph-decision';
  const label = el('label', 'Комментарий (необязательно)'), comment = document.createElement('textarea'); comment.maxLength = 10000; label.append(comment);
  const approve = el('button', 'Подтвердить и продолжить'), reject = el('button', 'Отклонить');
  approve.type = reject.type = 'button'; reject.className = 'secondary danger';
  for (const [button, approved] of [[approve, true], [reject, false]]) button.addEventListener('click', () => { approve.disabled = reject.disabled = true; void decide(approved, comment.value); });
  form.append(el('h4', step.name)); if (step.instructions) form.append(el('p', step.instructions));
  form.append(label, approve, reject, el('p', 'Пока процесс ждёт, ничего не запущено и блокировка не удерживается. Изменение файлов за это время сделает прежние заключения устаревшими.'));
  return form;
}
function graphSteps(taskId, attempt, latest, { decide, fix }) {
  const box = document.createElement('div'); box.className = 'graph-steps';
  for (const step of attempt.graphRun.steps) {
    if (step.kind === 'review') { const panel = reviewPanel(step, latest ? fix : null); panel.dataset.graphNode = step.nodeId; box.append(panel); continue; }
    if (step.kind === 'human' && step.status === 'ждёт решения') { const waiting = latest ? graphDecision(step, decide) : el('p', `${step.name}: ожидание закрыто следующим ходом.`); waiting.dataset.graphNode = step.nodeId; box.append(waiting); continue; }
    const item = document.createElement('details'); item.dataset.graphNode = step.nodeId; item.open = step === attempt.graphRun.steps.at(-1) || step.kind === 'read';
    item.append(el('summary', `${step.name}${step.visit > 1 ? ` · повтор ${step.visit - 1}` : ''}: ${step.status === 'выполнение завершено' ? 'ответ получен' : step.status}${step.agent ? ` · ${roleLabel(step)}` : ''}`));
    if (step.kind === 'human') item.append(el('p', step.comment ? `Комментарий: ${step.comment}` : 'Без комментария.'));
    if (step.kind === 'checks') item.append(el('p', 'Результаты этого запуска показаны в разделе проверок ниже.'));
    if (['executor', 'write', 'read'].includes(step.kind)) {
      const output = el('pre', step.output || 'Ответа пока нет.'); output.className = 'agent-output'; item.append(output);
      if (step.outputTruncated) item.append(el('p', 'Журнал ограничен 256 Ки символов: сохранены начало и конец, середина пропущена.'));
      if (step.diagnostics?.output) { const log = document.createElement('details'); log.open = step.status === 'ошибка'; log.append(el('summary', 'Диагностика CLI (stderr)'), el('pre', step.diagnostics.output)); item.append(log); }
    }
    if (step.before) item.append(diffPanel(taskId, attempt, 'step', 'Изменения файлов за этот шаг', step));
    box.append(item);
  }
  return box;
}
// The editor is reached only by choosing a graph for a process; a simple task never meets it.
let graphDraft = null, graphStepCount = 0;
const newStepId = () => { do graphStepCount++; while (graphDraft?.nodes.some(node => node.id === `step${graphStepCount}`)); return `step${graphStepCount}`; };
const newRole = () => ({ agent: 'codex', profile: 'default', model: '' });
const newMember = (name = 'Ревью кода', blocking = true) => ({ id: `role${++graphStepCount}`, name, ...newRole(), instructions: '', blocking, blockAt: 'P1' });
const graphTemplates = {
  single: { label: 'Только исполнитель', build: () => ({ start: 'exec', limits: { maxLoops: 2, timeBudgetMinutes: 60 }, nodes: [{ id: 'exec', name: 'Исполнитель', kind: 'executor', next: {} }] }) },
  roles: { label: 'Исполнитель → ревью кода и совещательная роль', build: () => ({ start: 'exec', limits: { maxLoops: 2, timeBudgetMinutes: 60 }, nodes: [
    { id: 'exec', name: 'Исполнитель', kind: 'executor', next: { success: 'review' } },
    { id: 'review', name: 'Ревью', kind: 'review', members: [newMember('Ревью кода'), newMember('Продюсер', false)], next: { failure: 'exec' } }] }) },
  planned: { label: 'Роль готовит план → подтверждение → работа → проверки → ревью', build: () => ({ start: 'plan', limits: { maxLoops: 2, timeBudgetMinutes: 90 }, nodes: [
    { id: 'plan', name: 'Гейм-дизайнер', kind: 'read', ...newRole(), instructions: 'Уточни задачу с точки зрения дизайна: что должно получиться и как это проверить.', next: { success: 'approve' } },
    { id: 'approve', name: 'Подтвердить план', kind: 'human', instructions: '', next: { success: 'exec', failure: 'plan' } },
    { id: 'exec', name: 'Исполнитель', kind: 'executor', next: { success: 'checks' } },
    { id: 'checks', name: 'Проверки', kind: 'checks', next: { success: 'review', failure: 'exec' } },
    { id: 'review', name: 'Ревью', kind: 'review', members: [newMember('Ревью кода')], next: { failure: 'exec' } }] }) }
};
function graphField(labelText, control) { const label = el('label', labelText); label.append(control); return label; }
function graphInput(value, onChange, max = 80) {
  const input = document.createElement('input'); input.value = value ?? ''; input.maxLength = max;
  input.addEventListener('input', () => onChange(input.value)); return input;
}
function graphSelect(options, value, onChange) {
  const select = document.createElement('select');
  select.append(...options.map(([key, label]) => { const option = el('option', label); option.value = key; return option; }));
  select.value = value; select.addEventListener('change', () => onChange(select.value)); return select;
}
function graphRoleFields(role) {
  const profile = document.createElement('select');
  const fill = () => {
    const names = role.agent === 'codex' ? ['default'] : ['subscription', 'litellm', 'deepseek'];
    if (!names.includes(role.profile)) role.profile = names[0];
    profile.replaceChildren(...names.map(name => { const option = el('option', profileNames[name]); option.value = name; return option; }));
    profile.value = role.profile;
  };
  profile.addEventListener('change', () => { role.profile = profile.value; }); fill();
  return [graphField('Агент', graphSelect([['claude', 'Claude Code'], ['codex', 'Codex']], role.agent, value => { role.agent = value; fill(); })), graphField('Профиль', profile), graphField('Модель', graphInput(role.model, value => { role.model = value.trim(); }, 120))];
}
function graphInstructions(owner, labelText = 'Инструкции роли') {
  const area = document.createElement('textarea'); area.value = owner.instructions || ''; area.maxLength = 10000; area.rows = 2;
  area.addEventListener('input', () => { owner.instructions = area.value; });
  return graphField(labelText, area);
}
function graphMember(node, member, repaint) {
  const card = document.createElement('div'); card.className = 'graph-member';
  const grid = document.createElement('div'); grid.className = 'form-grid';
  grid.append(graphField('Роль', graphInput(member.name, value => { member.name = value; })), ...graphRoleFields(member),
    graphField('Влияние', graphSelect([['true', 'Блокирует результат'], ['false', 'Совещательная']], String(member.blocking), value => { member.blocking = value === 'true'; repaint(); })));
  if (member.blocking) grid.append(graphField('Блокирует от', graphSelect(['P0', 'P1', 'P2', 'P3'].map(level => [level, level]), member.blockAt, value => { member.blockAt = value; })));
  card.append(grid, graphInstructions(member));
  if (node.members.length > 1) { const remove = el('button', 'Убрать роль'); remove.type = 'button'; remove.className = 'secondary'; remove.addEventListener('click', () => { node.members = node.members.filter(item => item !== member); repaint(); }); card.append(remove); }
  return card;
}
function changeStepKind(node, kind) {
  const { id, name, next } = node;
  const kept = { success: next.success, ...(['review', 'checks', 'human'].includes(kind) && next.failure ? { failure: next.failure } : {}) };
  if (!kept.success) delete kept.success;
  for (const key of Object.keys(node)) delete node[key];
  Object.assign(node, { id, name, kind, next: kept }, ['read', 'write'].includes(kind) ? { ...newRole(), instructions: '' } : kind === 'human' ? { instructions: '' } : kind === 'review' ? { members: [newMember()] } : {});
}
function renderGraphEditor() {
  const root = document.querySelector('#graph-editor [data-graph]'); root.replaceChildren();
  const graph = graphDraft, repaint = () => renderGraphEditor();
  const stepTargets = () => graph.nodes.map(node => [node.id, node.name]);
  const fillers = [], outline = document.createElement('div');
  const selectStep = id => {
    for (const card of root.querySelectorAll('.graph-node')) card.classList.toggle('selected', card.dataset.graphStep === id);
    const card = [...root.querySelectorAll('.graph-node')].find(item => item.dataset.graphStep === id);
    card?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    card?.querySelector('input')?.focus({ preventScroll: true });
  };
  const refresh = () => { for (const fill of fillers) fill(); outline.replaceChildren(el('h4', 'Как это будет работать'), graphSchema(graph, undefined, selectStep)); };
  const targetSelect = (options, read, write) => {
    const select = document.createElement('select');
    const fill = () => { const current = read(); select.replaceChildren(...options().map(([key, label]) => { const option = el('option', label); option.value = key; return option; })); select.value = current; };
    select.addEventListener('change', () => { write(select.value); refresh(); }); fillers.push(fill); fill();
    return select;
  };
  const head = document.createElement('div'); head.className = 'form-grid';
  const template = graphSelect([['', 'Выбрать…'], ...Object.entries(graphTemplates).map(([key, item]) => [key, item.label])], '', value => { if (value) { graphDraft = graphTemplates[value].build(); repaint(); } });
  const loops = graphInput(graph.limits.maxLoops, value => { graph.limits.maxLoops = Number(value); }), minutes = graphInput(graph.limits.timeBudgetMinutes, value => { graph.limits.timeBudgetMinutes = Number(value); });
  for (const input of [loops, minutes]) input.type = 'number';
  loops.min = '0'; loops.max = '5'; minutes.min = '5'; minutes.max = '240';
  head.append(graphField('Шаблон', template), graphField('Первый шаг', targetSelect(stepTargets, () => graph.start, value => { graph.start = value; })), graphField('Повторов одного шага', loops), graphField('Общий лимит, минут', minutes));
  root.append(head);
  for (const node of graph.nodes) {
    const card = document.createElement('div'); card.className = 'graph-node'; card.dataset.graphStep = node.id;
    const grid = document.createElement('div'); grid.className = 'form-grid';
    const kinds = Object.entries(stepKindNames).filter(([key]) => node.kind === 'executor' ? key === 'executor' : key !== 'executor');
    grid.append(graphField('Название шага', graphInput(node.name, value => { node.name = value; refresh(); })), graphField('Тип', graphSelect(kinds, node.kind, value => { changeStepKind(node, value); repaint(); })));
    if (['read', 'write'].includes(node.kind)) grid.append(...graphRoleFields(node));
    grid.append(graphField('Далее', targetSelect(() => [['end', 'Конец'], ...stepTargets().filter(([id]) => id !== node.id)], () => node.next.success ?? 'end', value => { if (value === 'end') delete node.next.success; else node.next.success = value; })));
    if (['review', 'checks', 'human'].includes(node.kind)) grid.append(graphField(node.kind === 'human' ? 'При отказе' : 'При проблемах', targetSelect(() => [['', 'Решение пользователя'], ...stepTargets().filter(([id]) => id !== node.id)], () => node.next.failure ?? '', value => { if (value) node.next.failure = value; else delete node.next.failure; })));
    card.append(grid);
    if (node.kind === 'executor') card.append(el('p', 'Агент, модель и инструкции исполнителя задаются в полях процесса выше. Продолжение разговора идёт в его сессию.'));
    if (['read', 'write'].includes(node.kind)) card.append(graphInstructions(node));
    if (node.kind === 'human') card.append(graphInstructions(node, 'Что нужно решить'));
    if (node.kind === 'checks') card.append(el('p', 'Какие проверки запускать, выбирается для каждого проекта в разделе «Проекты».'));
    if (node.kind === 'review') {
      card.append(el('p', 'Роли работают одновременно, в отдельных сессиях и только на чтение. Совещательные роли только дают мнение.'));
      card.append(...node.members.map(member => graphMember(node, member, repaint)));
      if (node.members.length < 4) { const add = el('button', 'Добавить роль'); add.type = 'button'; add.className = 'secondary'; add.addEventListener('click', () => { node.members.push(newMember('Новая роль', false)); repaint(); }); card.append(add); }
    }
    if (node.kind !== 'executor') {
      const remove = el('button', 'Удалить шаг'); remove.type = 'button'; remove.className = 'secondary danger';
      remove.addEventListener('click', () => {
        graph.nodes = graph.nodes.filter(item => item !== node);
        for (const other of graph.nodes) { if (other.next.success === node.id) delete other.next.success; if (other.next.failure === node.id) delete other.next.failure; }
        if (graph.start === node.id) graph.start = graph.nodes[0].id;
        repaint();
      });
      card.append(remove);
    }
    root.append(card);
  }
  const add = el('button', 'Добавить шаг'); add.type = 'button'; add.className = 'secondary';
  add.addEventListener('click', () => { const node = { id: newStepId(), name: 'Новая роль', kind: 'read', ...newRole(), instructions: '', next: {} }; graph.nodes.push(node); repaint(); });
  // The schema comes first: it is the overview from which a step is picked for editing.
  head.after(outline); root.append(add); refresh();
}
function cycleHistory(cycle) {
  const details = document.createElement('details'); details.className = 'cycle-history';
  details.append(el('summary', `${cycle.index ? `Исправление ${cycle.index}` : 'Первый проход'}${cycle.agent ? ` · ${roleLabel(cycle)}` : ''} · проверки: ${cycle.checks} · ревью: ${cycle.review}`),
    el('p', 'История завершённого прохода. Его заключение относится к файлам на тот момент; текущий результат показан ниже.'));
  const output = el('pre', cycle.output || 'Вывода нет.'); output.className = 'agent-output'; details.append(output);
  if (cycle.outputTruncated) details.append(el('p', 'Вывод этого прохода был ограничен.'));
  if (cycle.error || cycle.snapshotError) details.append(el('p', cycle.error || cycle.snapshotError));
  if (cycle.diagnostics?.output) { const log = document.createElement('details'); log.append(el('summary', 'Диагностика исполнителя'), el('pre', cycle.diagnostics.output)); details.append(log); }
  if (cycle.reviewRun) details.append(reviewPanel(cycle.reviewRun));
  return details;
}
for (const id of ['task', 'preset-form']) {
  const form = document.getElementById(id);
  form.elements.maxFixes.addEventListener('change', () => { form.querySelector('[data-automation-settings]').hidden = form.elements.maxFixes.value === '0'; if (id === 'task') renderProcessSummary(); });
  form.elements.timeBudgetMinutes.addEventListener('input', () => { if (id === 'task') renderProcessSummary(); });
}
