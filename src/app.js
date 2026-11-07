let token;
let profileTemplate = [];
let deepTemplate = {};
let projectData = [];
let taskData = [];
let agentOptions = [];
let settings = null;
let selectedTaskId = null;
let taskFilter = 'all';
let dashboardSignature = '';
const projectName = project => project?.path.split(/[\\/]/).filter(Boolean).at(-1) || 'Проект недоступен';
function taskGroup(status) {
  if (['в очереди', 'выполнение', 'остановка'].includes(status)) return 'active';
  if (['ждёт ответа', 'требуется решение', 'ошибка', 'прервана'].includes(status)) return 'attention';
  if (status === 'готово') return 'response';
  return 'created';
}
const shortStatus = status => ({ 'создана': 'Не запущена' }[status] || status);

const projects = document.querySelector('#projects');
const tasks = document.querySelector('#tasks');
const select = document.querySelector('#task select[name="projectId"]');
const message = document.querySelector('#message');
const composerError = document.querySelector('#composer-error');
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
  if (!data.files.length) { panel.append(el('p', data.scope === 'initial' ? 'Отличий от HEAD нет.' : 'Снимки совпадают: учтённые файлы не изменились.')); return; }
  const additions = data.files.reduce((sum, file) => sum + file.additions, 0), deletions = data.files.reduce((sum, file) => sum + file.deletions, 0);
  panel.append(el('p', `Файлов: ${data.files.length}, +${additions} −${deletions}. Игнорируемые Git файлы и submodules не входят.`));
  if (data.truncated) panel.append(el('p', `Общий объём текста изменений ограничен ${Math.round(data.patchLimit / 1048576)} МиБ; список файлов полный.`));
  for (const file of data.files) panel.append(diffFile(file, data.files.length <= 10));
}
function diffPanel(taskId, cacheId, scope, title, workerId) {
  const panel = document.createElement('details'); panel.className = 'diff-panel'; panel.dataset.diff = workerId || scope;
  panel.append(el('summary', title));
  const key = `${taskId}:${scope}:${workerId || ''}:${cacheId}`;
  if (diffCache.has(key)) showDiff(panel, diffCache.get(key));
  panel.addEventListener('toggle', async () => {
    if (!panel.open || panel.dataset.loading || diffCache.has(key)) return;
    panel.dataset.loading = '1'; panel.append(el('p', 'Сравниваем снимки…'));
    try {
      const data = await api('run-diff', { taskId, scope, ...(workerId ? { workerId } : {}) });
      if (data.available) diffCache.set(key, data);
      showDiff(panel, data);
    } catch (error) { showDiff(panel, { available: false, reason: error.message }); }
    finally { delete panel.dataset.loading; }
  });
  return panel;
}
async function api(endpoint, input) {
  const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token }, body: JSON.stringify(input) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  return result;
}
function projectItem(project) {
  const item = el('li', project.path), details = document.createElement('details');
  details.append(el('summary', 'Настроить команды проверок'));
  details.append(el('p', 'Команды задаются вручную; только их супервизор может запускать через оркестратор. Выполняются в корне проекта с правами текущего пользователя. executable и args передаются напрямую, без автоматического shell. Для PowerShell или .bat задайте powershell.exe с явными аргументами. Не вводите ключи и другие секреты. Пустой список [] означает отсутствие проверок.'));
  const form = document.createElement('form'), label = el('label', 'Команды проверок (JSON)'), input = document.createElement('textarea');
  input.value = JSON.stringify(project.checks || [], null, 2); input.rows = 14;
  input.placeholder = '[{"id":"tests","name":"Тесты","executable":"bun","args":["run","test"],"timeoutSeconds":600}]';
  label.append(input); const save = el('button', 'Сохранить команды проверок'), result = el('p', ''); result.setAttribute('role', 'status');
  form.append(label, save); details.append(form, result); item.append(details);
  const taskCount = taskData.filter(t => t.projectId === project.id).length;
  item.append(deleteButton('Удалить проект', taskCount ? `Удалить вместе с задачами (${taskCount})?` : 'Точно удалить?', async () => { await api('project-delete', { projectId: project.id }); await refresh(); }));
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    try { const response = await api('project-checks', { projectId: project.id, checks: JSON.parse(input.value) }); project.checks = response.checks; input.value = JSON.stringify(response.checks, null, 2); result.textContent = 'Команды сохранены. Супервизор увидит их в следующих решениях.'; }
    catch (error) { result.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return item;
}

// Markdown from a model is untrusted: nodes are built one by one and never parsed as HTML; only http(s) links become links.
const inlinePattern = /`([^`\n]+)`|(?<!\\)\*\*(?=\S)(.+?)\*\*|(?<!\w)__(?=\S)(.+?)__(?!\w)|(?<![\w*\\])\*(?=[^\s*])([^*\n]+?)\*(?![\w*])|(?<![\w\\])_(?=[^\s_])([^_\n]+?)_(?!\w)|~~(?=\S)(.+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)|\\([\\`*_{}[\]()#+\-.!|~])/g;
function markdownLink(target, label) {
  let url;
  try { url = new URL(target); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const link = document.createElement('a'); link.href = url.href; link.title = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.textContent = label;
  return link;
}
function appendInline(parent, text) {
  let position = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const [whole, code, strong, strongAlt, em, emAlt, strike, label, target, bare, escaped] = match;
    parent.append(document.createTextNode(text.slice(position, match.index)));
    position = match.index + whole.length;
    if (code !== undefined) parent.append(el('code', code));
    else if (strong !== undefined || strongAlt !== undefined) { const node = document.createElement('strong'); appendInline(node, strong ?? strongAlt); parent.append(node); }
    else if (em !== undefined || emAlt !== undefined) { const node = document.createElement('em'); appendInline(node, em ?? emAlt); parent.append(node); }
    else if (strike !== undefined) { const node = document.createElement('del'); appendInline(node, strike); parent.append(node); }
    else if (label !== undefined) parent.append(markdownLink(target, plainMarkdown(label)) || document.createTextNode(whole));
    else if (bare !== undefined) {
      const url = bare.replace(/[.,;:!?]+$/, '');
      parent.append(markdownLink(url, url) || document.createTextNode(url), document.createTextNode(bare.slice(url.length)));
    } else parent.append(document.createTextNode(escaped));
  }
  parent.append(document.createTextNode(text.slice(position)));
}
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/, rulerLine = /^\s*([-*_])(\s*\1){2,}\s*$/, fenceLine = /^\s*(```+|~~~+)/;
const tableDivider = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
function tableCells(line) {
  const cells = []; let cell = '', inCode = false;
  const text = line.trim().replace(/^\|/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') { cell += '|'; index++; }
    else if (char === '|' && !inCode) { cells.push(cell.trim()); cell = ''; }
    else { if (char === '`') inCode = !inCode; cell += char; }
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}
const startsBlock = (lines, index) => /^#{1,6}\s/.test(lines[index]) || fenceLine.test(lines[index]) || rulerLine.test(lines[index]) || listItem.test(lines[index]) || /^\s*>/.test(lines[index]) || (lines[index].includes('|') && index + 1 < lines.length && lines[index + 1].includes('-') && tableDivider.test(lines[index + 1]));
function parseList(lines, start, indent) {
  const ordered = /\d/.test(listItem.exec(lines[start])[2]);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered) { const first = parseInt(listItem.exec(lines[start])[2], 10); if (first !== 1) list.start = first; }
  let index = start, item = null;
  while (index < lines.length) {
    const match = listItem.exec(lines[index]);
    if (!match) {
      if (lines[index].trim()) break;
      let next = index; while (next < lines.length && !lines[next].trim()) next++;
      const following = next < lines.length && listItem.exec(lines[next]);
      if (!following || following[1].length < indent) break;
      index = next; continue;
    }
    const width = match[1].length;
    if (width < indent) break;
    if (width > indent + 1 && item) { const nested = parseList(lines, index, width); item.append(nested.list); index = nested.index; continue; }
    if (/\d/.test(match[2]) !== ordered) break;
    item = document.createElement('li');
    let text = match[3]; index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index) && /^\s/.test(lines[index])) text += ` ${lines[index++].trim()}`;
    appendInline(item, text); list.append(item);
  }
  return { list, index };
}
function appendMarkdown(parent, text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = fenceLine.exec(line), heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (fence) {
      const code = []; index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) code.push(lines[index++]);
      index++;
      const block = document.createElement('pre'); block.className = 'markdown-code'; block.append(el('code', code.join('\n'))); parent.append(block);
    } else if (heading) {
      const node = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`); appendInline(node, heading[2]); parent.append(node); index++;
    } else if (rulerLine.test(line)) { parent.append(document.createElement('hr')); index++; }
    else if (line.includes('|') && index + 1 < lines.length && lines[index + 1].includes('-') && tableDivider.test(lines[index + 1])) {
      const aligns = tableCells(lines[index + 1]).map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : '');
      const table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
      const row = (cells, tag) => { const node = document.createElement('tr'); cells.forEach((cell, column) => { const entry = document.createElement(tag); if (aligns[column]) entry.dataset.align = aligns[column]; appendInline(entry, cell); node.append(entry); }); return node; };
      head.append(row(tableCells(line), 'th')); index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) body.append(row(tableCells(lines[index++]), 'td'));
      table.append(head, body);
      const wrap = document.createElement('div'); wrap.className = 'markdown-table'; wrap.append(table); parent.append(wrap);
    } else if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ''));
      const quote = document.createElement('blockquote'); appendMarkdown(quote, quoted.join('\n')); parent.append(quote);
    } else if (listItem.test(line)) {
      const parsed = parseList(lines, index, listItem.exec(line)[1].length); parent.append(parsed.list); index = parsed.index;
    } else {
      const paragraph = document.createElement('p'); let first = true;
      do { if (!first) paragraph.append(document.createElement('br')); appendInline(paragraph, lines[index++].trim()); first = false; } while (index < lines.length && lines[index].trim() && !startsBlock(lines, index));
      parent.append(paragraph);
    }
  }
}
function setMarkdown(node, text) { node.classList.add('markdown'); node.replaceChildren(); appendMarkdown(node, text); return node; }
function modelBlock(text) { const node = document.createElement('div'); node.className = 'text-block'; return setMarkdown(node, text); }
// A card has room for a few lines of words, not for tables and headings.
function plainMarkdown(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').filter(line => !(line.includes('-') && tableDivider.test(line)) && !fenceLine.test(line))
    .map(line => line.replace(/^\s*(#{1,6}|>)\s*/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, ' · ').trim()).filter(Boolean).join(' ')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1').replace(/\*\*|__|~~|`/g, '').replace(/(?<![\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1');
}
function outputBlock(text) { const node = el('pre', text); node.className = 'agent-output'; return node; }
function textBlock(text) { const node = el('div', text); node.className = 'text-block'; return node; }
function imageGallery(taskId, ids) {
  const gallery = document.createElement('div'); gallery.className = 'image-gallery';
  ids.forEach((id, index) => {
    const link = document.createElement('a'); link.href = `/images/${taskId}/${id}`; link.target = '_blank'; link.rel = 'noopener'; link.title = 'Открыть изображение';
    const image = document.createElement('img'); image.src = link.getAttribute('href'); image.alt = `Приложенное изображение ${index + 1}`; image.loading = 'lazy';
    link.append(image); gallery.append(link);
  });
  return gallery;
}
const imageSection = (taskId, ids) => ids?.length ? [detailSection('Изображения', imageGallery(taskId, ids))] : [];
const imageMeta = ids => ids?.length ? `изображений: ${ids.length}` : '';
function detailSection(title, ...content) { const section = document.createElement('section'); section.className = 'detail-section'; section.append(el('h4', title), ...content); return section; }
function whySection(why) { const section = detailSection('Почему супервизор так решил', modelBlock(why)); section.classList.add('decision'); return section; }
function keyedDetails(key, title, ...content) { const item = document.createElement('details'); item.dataset.key = key; item.append(el('summary', title), ...content); return item; }
function clock(ms) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин${seconds % 60 ? ` ${seconds % 60} с` : ''}`; }
const elapsed = from => { const minutes = Math.floor((Date.now() - Date.parse(from)) / 60000); return minutes > 0 ? `идёт ${minutes} мин` : 'идёт'; };
const clip = (text, size = 60) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > size ? `${line.slice(0, size)}…` : line; };
const workerTone = status => status === 'готово' ? 'done' : status === 'выполняется' ? 'run' : status === 'прервано' ? 'stopped' : 'bad';
const checkTone = status => status === 'пройдены' ? 'done' : status === 'выполняются' ? 'run' : status === 'прерваны' ? 'stopped' : 'bad';
const shortModel = model => (model || '').replace(/^claude-/, '');
const compactTokens = value => value < 1000 ? String(value) : value < 1e6 ? `${(value / 1000).toFixed(value < 10000 ? 1 : 0).replace('.', ',')}k` : `${(value / 1e6).toFixed(1).replace('.', ',')}M`;
// Cache reads are left out: they repeat the same context on every turn and would drown what was actually spent.
const spentTokens = models => (models || []).reduce((sum, item) => sum + item.input + item.output + item.cacheWrite, 0);
const modelNames = models => [...new Set((models || []).map(item => shortModel(item.model)).filter(Boolean))].join(', ');
const fullNumber = value => value.toLocaleString('ru-RU');
function usageSection(models, partial) {
  if (!models?.length) return [];
  const lines = models.map(item => `${shortModel(item.model) || 'Модель из настроек CLI'}: ввод ${fullNumber(item.input)}, вывод ${fullNumber(item.output)}, кеш: запись ${fullNumber(item.cacheWrite)}, чтение ${fullNumber(item.cacheRead)}${item.costUsd !== null ? `, оценка $${item.costUsd.toFixed(3)}` : ''}`);
  return [detailSection('Модель и токены', textBlock(`${lines.join('\n')}${partial ? '\nПроцесс остановлен до итогов: цифры неполные.' : ''}`))];
}
function workerStep(worker, why) {
  const agent = agentOptions.find(option => option.id === worker.rosterId)?.label || worker.rosterId;
  const running = worker.status === 'выполняется';
  const model = modelNames(worker.usage) || shortModel(worker.model), spent = spentTokens(worker.usage);
  const sub = [agent, model].filter(Boolean).join(' · ');
  const parts = [worker.access === 'write' ? 'запись' : 'чтение', running ? elapsed(worker.startedAt) : worker.endedAt ? clock(Date.parse(worker.endedAt) - Date.parse(worker.startedAt)) : '', spent ? `${compactTokens(spent)} ток.` : ''];
  if (worker.filesChanged && worker.changedPaths?.length) parts.push(`файлов: ${worker.changedPaths.length}`);
  if (workerTone(worker.status) !== 'done' && !running) parts.push(worker.status);
  return { id: worker.id, kind: 'worker', title: worker.name, sub, meta: parts.filter(Boolean).join(' · '), tone: workerTone(worker.status), why, worker };
}
function checkStep(check, why) {
  const passed = check.results.filter(result => result.status === 'пройдена').length;
  return { id: check.id, kind: 'check', title: 'Проверки', sub: `${check.status} · ${passed} из ${check.results.length}`, tone: checkTone(check.status), why, check };
}
// The journal in order of events, as rows of the graph: parallel workers share one row.
function buildSteps(task, run) {
  const taskImageIds = (task.images || []).map(image => image.id);
  const rows = [[{ id: 'task', kind: 'task', title: 'Задача', sub: 'твой запрос', meta: imageMeta(taskImageIds), tone: 'plain', text: task.description, images: taskImageIds }]];
  if (!run) return rows;
  const lastFinish = run.journal.findLastIndex(entry => entry.kind === 'decision' && entry.action === 'finish');
  const listedWorkers = new Set(), listedChecks = new Set();
  let why = '', question = null, firstMessage = true;
  run.journal.forEach((entry, index) => {
    const id = `j${index}`;
    if (entry.kind === 'user') {
      if (firstMessage) firstMessage = false;
      else rows.push([{ id, kind: 'text', title: 'Твоё сообщение', sub: clip(entry.text), meta: imageMeta(entry.images), tone: 'plain', label: 'Текст', text: entry.text, images: entry.images }]);
    } else if (entry.kind === 'decision') {
      if (entry.action === 'ask_user') { question = { id, kind: 'question', title: 'Вопрос тебе', sub: 'остался без ответа', tone: 'plain', why: entry.reason, question: '', answer: '' }; rows.push([question]); }
      else if (entry.action === 'finish') {
        const report = index === lastFinish ? run.report : null;
        rows.push([{ id, kind: 'finish', title: 'Завершение', sub: !report ? 'работа продолжена позже' : run.status === 'готово' ? 'супервизор закончил' : 'нужно твоё решение', tone: !report ? 'plain' : run.status === 'готово' ? 'done' : 'ask', why: entry.reason, report }]);
      } else why = entry.reason;
    } else if (entry.kind === 'answer') {
      const node = question || { id, kind: 'question', title: 'Вопрос тебе', tone: 'plain', why: '' };
      if (!question) rows.push([node]);
      Object.assign(node, { question: entry.question, answer: entry.text, sub: `→ ${clip(entry.text)}`, meta: imageMeta(entry.images), images: entry.images });
      question = null;
    } else if (entry.kind === 'note') rows.push([{ id, kind: 'text', title: 'Заметка оркестратора', sub: clip(entry.text), tone: 'plain', label: 'Текст', text: entry.text }]);
    else if (entry.kind === 'diff') { rows.push([{ id, kind: 'text', title: 'Diff для супервизора', sub: 'все изменения с начала', tone: 'plain', why, label: 'Diff', code: entry.text }]); why = ''; }
    else if (entry.kind === 'checks') { const check = run.checkRuns.find(item => item.id === entry.id); listedChecks.add(entry.id); if (check) rows.push([checkStep(check, why)]); why = ''; }
    else if (entry.kind === 'workers') {
      const workers = entry.ids.map(workerId => run.workers.find(item => item.id === workerId)).filter(Boolean);
      entry.ids.forEach(workerId => listedWorkers.add(workerId));
      if (workers.length) rows.push(workers.map(worker => workerStep(worker, why)));
      why = '';
    }
  });
  if (question && run.waiting) Object.assign(question, { question: run.waiting.question, sub: 'ждёт твоего ответа', tone: 'ask' });
  // Work in progress has no journal entry until it ends, and is exactly what a watcher wants to see.
  const runningWorkers = run.workers.filter(worker => !listedWorkers.has(worker.id));
  if (runningWorkers.length) rows.push(runningWorkers.map(worker => workerStep(worker, why)));
  for (const check of run.checkRuns) if (!listedChecks.has(check.id)) rows.push([checkStep(check, why)]);
  if (run.active || run.queued) rows.push([{ id: 'next', kind: 'next', title: 'Следующий шаг', sub: run.queued ? 'задача в очереди' : run.phase === 'Супервизор выбирает следующий шаг' ? 'супервизор выбирает…' : 'решит супервизор', tone: 'ghost' }]);
  return rows;
}
function latestStep(rows) {
  const real = rows.filter(row => row[0].kind !== 'next').at(-1);
  return real.find(step => step.tone === 'run') || real[0];
}
function graphNode(step) {
  const node = document.createElement('button'); node.type = 'button'; node.className = `graph-node tone-${step.tone}`; node.dataset.node = step.id; node.title = [step.title, step.sub, step.meta].filter(Boolean).join('\n');
  const title = document.createElement('span'); title.className = 'graph-node-title';
  const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true');
  const name = el('span', step.title); title.append(dot, name);
  const sub = el('span', step.sub); sub.className = 'graph-node-sub';
  node.append(title, sub);
  if (step.meta) { const meta = el('span', step.meta); meta.className = 'graph-node-sub'; node.append(meta); }
  return node;
}
const svgNode = (name, attributes = {}) => { const node = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; };
function drawEdges(graph) {
  const svg = graph.querySelector('.graph-edges'); if (!svg) return;
  const box = graph.getBoundingClientRect(), rows = [...graph.querySelectorAll('.graph-row')];
  const marker = (id, className) => { const shape = svgNode('marker', { id, viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }); shape.append(svgNode('path', { d: 'M0 0L8 4L0 8Z', class: className })); return shape; };
  const defs = svgNode('defs'); defs.append(marker('edge-end', 'edge-head'), marker('edge-end-live', 'edge-head-live'));
  svg.replaceChildren(defs);
  // Newest is on top, so every edge runs from a lower row up to the row above it.
  for (let index = rows.length - 1; index > 0; index--) for (const older of rows[index].children) for (const newer of rows[index - 1].children) {
    const from = older.getBoundingClientRect(), to = newer.getBoundingClientRect();
    const x1 = from.left + from.width / 2 - box.left, y1 = from.top - box.top, x2 = to.left + to.width / 2 - box.left, y2 = to.bottom - box.top, middle = (y1 + y2) / 2;
    const live = [older, newer].some(node => node.classList.contains('tone-run') || node.classList.contains('tone-ghost'));
    svg.append(svgNode('path', { d: `M${x1} ${y1}C${x1} ${middle},${x2} ${middle},${x2} ${y2 + 1}`, class: live ? 'edge edge-live' : 'edge', 'marker-end': `url(#edge-end${live ? '-live' : ''})` }));
  }
}
function workerDetail(taskId, worker, live) {
  const item = document.createElement('div'); item.dataset.worker = worker.id;
  if (worker.error) { const error = el('p', worker.error); error.className = 'notice'; item.append(error); }
  if (worker.denials?.length) item.append(detailSection('CLI отклонил', textBlock(worker.denials.map(denial => `${denial.tool}: ${denial.detail || 'без подробностей'}`).join('\n'))));
  if (worker.continued) item.append(el('p', `Продолжает сессию воркера ${worker.continued}.`));
  if (worker.images?.length) item.append(el('p', `Передано изображений пользователя: ${worker.images.length}.`));
  item.append(...usageSection(worker.usage, worker.usagePartial));
  item.append(detailSection('Запрос от супервизора', modelBlock(worker.prompt)));
  item.append(detailSection('Ответ воркера', worker.answer ? modelBlock(worker.answer) : el('p', worker.status === 'выполняется' ? 'Ответа пока нет.' : 'Воркер не дал ответа.')));
  if (worker.changedPaths?.length) item.append(detailSection('Изменённые файлы', textBlock(worker.changedPaths.join('\n'))));
  const logOutput = outputBlock(worker.output || 'Вывода пока нет.');
  const log = keyedDetails('log', 'Журнал CLI', logOutput);
  const stderrOutput = outputBlock(worker.diagnostics?.output || '');
  const stderr = keyedDetails('stderr', 'Диагностика CLI (stderr)', stderrOutput); stderr.hidden = !worker.diagnostics?.output;
  const more = el('button', 'Показать весь журнал'); more.type = 'button'; more.className = 'secondary'; more.hidden = !worker.logTrimmed;
  more.addEventListener('click', async () => { try { logOutput.textContent = (await api('run-worker', { taskId, workerId: worker.id })).output; live.full = true; more.hidden = true; } catch (error) { more.textContent = error.message; } });
  log.append(more, stderr); item.append(log);
  if (worker.access === 'write') { const panel = diffPanel(taskId, worker.after?.snapshot?.tree || '', 'worker', 'Изменения этого воркера', worker.id); panel.dataset.key = 'diff'; item.append(panel); }
  live.update = fresh => {
    // A growing log stays in the same element: open sections, the scroll position and any selection survive.
    if (live.full) return;
    const text = fresh.output || 'Вывода пока нет.';
    if (logOutput.textContent !== text) { const atEnd = logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 24; logOutput.textContent = text; if (atEnd) logOutput.scrollTop = logOutput.scrollHeight; }
    if (stderrOutput.textContent !== (fresh.diagnostics?.output || '')) stderrOutput.textContent = fresh.diagnostics?.output || '';
    stderr.hidden = !fresh.diagnostics?.output; more.hidden = !fresh.logTrimmed;
  };
  return item;
}
function checkDetail(check) {
  const item = document.createElement('div'); item.dataset.check = check.id;
  for (const result of check.results) {
    const detail = keyedDetails(result.definition.id, `${result.definition.name}: ${result.status}, код выхода ${result.exitCode ?? 'нет'}`, outputBlock(result.output || 'Вывода нет.'));
    if (result.logTrimmed) detail.append(el('p', 'Показаны последние строки вывода.'));
    if (!['пройдена', 'не выполнена'].includes(result.status)) detail.open = true;
    item.append(detail);
  }
  return item;
}
function taskDetail(taskId, step) {
  const item = document.createElement('div');
  const inspect = el('button', 'Показать Git-состояние'); inspect.type = 'button'; inspect.className = 'secondary';
  const workspace = document.createElement('div'); workspace.setAttribute('aria-live', 'polite');
  inspect.addEventListener('click', async () => {
    inspect.disabled = true; workspace.replaceChildren(el('p', 'Читаем состояние репозитория…'));
    try {
      const state = await api('task-workspace', { taskId });
      workspace.replaceChildren(el('p', `Текущий checkout: ${state.path}`), el('p', `Ветка: ${state.detached ? 'detached HEAD' : state.branch}. HEAD: ${state.head || 'первого коммита ещё нет'}`), el('p', state.clean ? 'Рабочая директория чистая.' : `Незакоммиченных изменений: ${state.changes.length}.`));
    } catch (error) { workspace.replaceChildren(el('p', error.message)); }
    finally { inspect.disabled = false; }
  });
  item.append(detailSection('Текст задачи', textBlock(step.text)), ...imageSection(taskId, step.images), inspect, workspace);
  return item;
}
function stepDetail(taskId, step, live) {
  if (step.kind === 'task') return taskDetail(taskId, step);
  if (step.kind === 'worker') return workerDetail(taskId, step.worker, live);
  if (step.kind === 'check') return checkDetail(step.check);
  const item = document.createElement('div');
  if (step.kind === 'question') item.append(detailSection('Вопрос', modelBlock(step.question || 'Текст вопроса не сохранён: на него не ответили.')), ...(step.answer ? [detailSection('Твой ответ', textBlock(step.answer))] : []), ...imageSection(taskId, step.images));
  else if (step.kind === 'finish' && step.report) item.append(reportPanel(step.report));
  else if (step.kind === 'next') item.append(el('p', 'Супервизор выбирает по одному действию за раз, поэтому заранее этот шаг неизвестен.'));
  else if (step.code) item.append(detailSection(step.label, outputBlock(step.code)));
  else if (step.text) item.append(detailSection(step.label, textBlock(step.text)), ...imageSection(taskId, step.images));
  return item;
}
function reportPanel(report) {
  const panel = document.createElement('section'); panel.className = 'report';
  const facts = report.evidence, summary = setMarkdown(document.createElement('div'), report.summary);
  panel.append(el('h2', report.outcome === 'done' ? 'Отчёт супервизора' : 'Супервизор не смог завершить'), summary);
  const list = document.createElement('ul');
  list.append(el('li', `Файлы: ${facts.filesChanged === null ? 'состояние не определено' : facts.filesChanged ? 'изменены' : 'не изменены'}`),
    el('li', `Проверки: ${facts.checks}`), el('li', `Независимое чтение после последней правки: ${facts.readAfterWrite ? 'было' : 'не было'}`));
  panel.append(list, el('p', 'Текст отчёта написан моделью. Список выше — факты оркестратора. Принятие результата за тобой.'));
  return panel;
}
function denialsPanel(run, onAllow) {
  const denials = run.workers.flatMap(worker => worker.denials || []);
  if (!denials.length) return null;
  const panel = document.createElement('section'); panel.className = 'panel denials';
  panel.append(el('h2', 'CLI отклонил действия'));
  for (const denial of denials) panel.append(el('p', `${denial.tool}: ${denial.detail || 'без подробностей'}${denial.rule ? '' : ' (точное разрешение выдать нельзя)'}`));
  const rules = [...new Set(denials.map(denial => denial.rule).filter(Boolean))].filter(rule => !run.grants.includes(rule));
  if (rules.length && !run.active) {
    panel.append(el('p', `Будут разрешены только эти правила для пишущих воркеров этой задачи: ${rules.join('; ')}`));
    const allow = el('button', 'Разрешить и продолжить'); allow.type = 'button'; allow.addEventListener('click', onAllow); panel.append(allow);
  }
  return panel;
}
const imageFileTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], imageFileLimit = Math.floor(3.75 * 1024 * 1024), imagesPerMessage = 5;
const readBase64 = file => new Promise((done, failed) => { const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1]); reader.onerror = () => failed(reader.error); reader.readAsDataURL(file); });
// Attaching by paste, drop or file choice. These checks only spare a round trip: the server decides by the bytes it receives.
function imagePicker(input, dropTarget) {
  const node = document.createElement('div'); node.className = 'image-picker';
  const choose = el('button', 'Приложить изображение'); choose.type = 'button'; choose.className = 'link-button'; choose.title = 'Можно вставить из буфера (Ctrl+V) или перетащить';
  const files = document.createElement('input'); files.type = 'file'; files.accept = imageFileTypes.join(','); files.multiple = true; files.hidden = true; files.setAttribute('aria-label', 'Выбрать изображения');
  const list = document.createElement('div'); list.className = 'image-previews';
  const error = el('p', ''); error.className = 'image-error'; error.setAttribute('role', 'status');
  node.append(list, choose, files, error);
  let items = [], pending = Promise.resolve();
  const removeItem = item => { items = items.filter(other => other !== item); URL.revokeObjectURL?.(item.url); item.node.remove(); };
  async function addOne(file) {
    if (!imageFileTypes.includes(file.type)) { error.textContent = 'Поддерживаются только PNG, JPEG, GIF и WebP.'; return; }
    if (file.size > imageFileLimit) { error.textContent = 'Изображение больше 3,75 МБ: уменьшите его и приложите снова.'; return; }
    if (items.length >= imagesPerMessage) { error.textContent = `За один раз можно приложить не больше ${imagesPerMessage} изображений.`; return; }
    const item = { data: await readBase64(file), url: URL.createObjectURL(file) };
    item.node = document.createElement('figure'); item.node.className = 'image-preview';
    const image = document.createElement('img'); image.src = item.url; image.alt = `Приложенное изображение ${items.length + 1}`;
    const remove = el('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Убрать изображение'); remove.title = 'Убрать изображение';
    remove.addEventListener('click', () => removeItem(item));
    item.node.append(image, remove); list.append(item.node); items.push(item);
  }
  const add = incoming => {
    error.textContent = '';
    pending = pending.then(async () => { for (const file of incoming) await addOne(file); }).catch(() => { error.textContent = 'Не удалось прочитать изображение.'; });
    return pending;
  };
  choose.addEventListener('click', () => files.click());
  files.addEventListener('change', () => { void add([...files.files]); files.value = ''; });
  input.addEventListener('paste', event => {
    const pasted = [...(event.clipboardData?.files || [])];
    // Office puts a picture of the selection next to its text; the text is what was meant then.
    if (!pasted.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault(); void add(pasted);
  });
  dropTarget.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  dropTarget.addEventListener('drop', event => { const dropped = [...(event.dataTransfer?.files || [])]; if (dropped.length) { event.preventDefault(); void add(dropped); } });
  return {
    node,
    // Waits for files still being read, so a quick send cannot leave a picture behind.
    async collect() { await pending; return items.length ? items.map(item => ({ data: item.data })) : undefined; },
    clear() { for (const item of [...items]) removeItem(item); error.textContent = ''; }
  };
}
// The same form on the task page and in a dashboard card: the question and the place to answer it are one thing.
function questionForm(send, compact = false) {
  const form = document.createElement('form'); form.className = compact ? 'question compact' : 'question';
  const text = document.createElement('div'); text.className = 'question-text';
  const input = document.createElement('textarea'); input.required = true; input.maxLength = 10000;
  const button = el('button', 'Ответить →'), error = el('p', ''); error.setAttribute('role', 'status');
  const more = el('button', 'Показать полностью'); more.type = 'button'; more.className = 'link-button'; more.hidden = true;
  more.addEventListener('click', () => { more.textContent = text.classList.toggle('expanded') ? 'Свернуть' : 'Показать полностью'; });
  const picker = imagePicker(input, form);
  if (compact) {
    input.setAttribute('aria-label', 'Твой ответ'); input.placeholder = 'Ответ супервизору…';
    form.append(text, more, input, picker.node, button, error);
  } else {
    const label = el('label', 'Твой ответ'), hint = el('span', 'Ctrl+Enter'); label.append(input); hint.className = 'subtle';
    form.append(el('h2', 'Супервизор спрашивает'), text, label, picker.node, button, hint, error);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true; error.textContent = '';
    try { await send(input.value, await picker.collect()); input.value = ''; picker.clear(); }
    catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit(); });
  return { form, text, input, more };
}
function renderTask(task) {
  const card = document.createElement('article'); card.className = 'task-detail'; card.dataset.taskId = task.id;
  const badge = el('span', shortStatus(task.status)); badge.className = `badge ${taskGroup(task.status)}`;
  const head = document.createElement('header'); head.className = 'task-head';
  const route = el('p', ''); route.className = 'workflow-route';
  const phase = el('p', 'Загружаем состояние…'); phase.className = 'phase';
  const stats = el('p', ''); stats.className = 'task-stats';
  const ask = questionForm(async (text, images) => { await api('run-message', { taskId: task.id, message: text, images }); previous = ''; void poll(); });
  ask.form.hidden = true;
  const controls = document.createElement('div'); controls.className = 'run-controls';
  const start = el('button', 'Запустить'); start.type = 'button'; start.hidden = true;
  const stop = el('button', 'Остановить'); stop.type = 'button'; stop.className = 'danger'; stop.hidden = true;
  const remove = deleteButton('Удалить задачу', 'Точно удалить?', async () => { await api('task-delete', { taskId: task.id }); location.hash = 'dashboard'; await refresh(); });
  controls.append(start, stop, remove);
  const now = document.createElement('div'); now.className = 'task-now panel';
  const nowBody = document.createElement('div'); nowBody.className = 'task-now-body';
  const nowLine = document.createElement('div'); nowLine.className = 'task-now-line'; nowLine.append(badge, phase);
  nowBody.append(nowLine, route, stats); now.append(nowBody, controls);
  head.append(el('p', projectName(projectData.find(p => p.id === task.projectId))), el('h1', task.title));
  if (task.legacy) { const old = el('p', 'Задача из прежней версии с режимами. Её журнал сохранён в .data/app/state.before-supervisor.json; запуск начнёт работу заново.'); old.className = 'notice'; head.append(old); }
  head.append(now, ask.form);
  const feedback = el('p', ''); feedback.setAttribute('role', 'status'); feedback.className = 'task-feedback';
  const reportSlot = document.createElement('div'), denialSlot = document.createElement('div'), diffSlot = document.createElement('div');
  const reply = document.createElement('form'); reply.className = 'reply panel'; reply.hidden = true;
  const replyLabel = el('label', 'Написать супервизору'), replyInput = document.createElement('textarea');
  replyInput.required = true; replyInput.maxLength = 10000; replyLabel.append(replyInput);
  const replyButton = el('button', 'Отправить →'), replyNote = el('p', ''); replyNote.className = 'subtle';
  const replyImages = imagePicker(replyInput, reply);
  reply.append(replyLabel, replyImages.node, replyButton, replyNote);
  // The graph: newest step on top, each node opening its details in the panel beside it.
  const work = document.createElement('div'); work.className = 'task-work';
  const graph = document.createElement('div'); graph.className = 'graph';
  const inspector = document.createElement('aside'); inspector.className = 'inspector panel'; inspector.setAttribute('aria-label', 'Детали шага');
  const inspectorTitle = el('h2', ''), inspectorSub = el('p', ''), inspectorBody = document.createElement('div'); inspectorSub.className = 'subtle';
  inspector.append(inspectorTitle, inspectorSub, inspectorBody);
  const details = document.createElement('div'); details.className = 'task-details'; details.append(inspector, diffSlot);
  work.append(graph, details);
  card.append(head, feedback, denialSlot, reportSlot, reply, work);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => drawEdges(graph)).observe(graph);

  let polling = false, previous = '', asked = false, shownQuestion = null, selected = null, shownSteps = [], graphKey = '', detailKey = '', detailId = '', live = {};
  function showStep() {
    const all = shownSteps.flat(), step = all.find(item => item.id === selected) || latestStep(shownSteps);
    for (const node of graph.querySelectorAll('[data-node]')) { const chosen = node.dataset.node === step.id; node.classList.toggle('selected', chosen); node.setAttribute('aria-pressed', String(chosen)); }
    inspectorTitle.textContent = step.title; inspectorSub.textContent = [step.sub, step.meta].filter(Boolean).join(' · ');
    const fields = { ...step, sub: '', meta: '', worker: step.worker && { ...step.worker, output: '', diagnostics: null, logTrimmed: false, startedAt: '' } };
    const key = JSON.stringify(fields);
    if (key === detailKey) { if (step.worker) live.update?.(step.worker); return; }
    const open = new Map();
    if (detailId === step.id) for (const node of inspectorBody.querySelectorAll('details[data-key]')) open.set(node.dataset.key, node.open);
    const keepFull = detailId === step.id && live.full;
    live = { full: keepFull };
    const reason = step.why ? [whySection(step.why)] : [];
    inspectorBody.replaceChildren(...reason, stepDetail(task.id, step, live));
    for (const node of inspectorBody.querySelectorAll('details[data-key]')) if (open.has(node.dataset.key) && open.get(node.dataset.key) !== node.open) node.open = open.get(node.dataset.key);
    detailKey = key; detailId = step.id;
  }
  function showSteps(rows) {
    shownSteps = rows;
    const key = JSON.stringify(rows.map(row => row.map(step => [step.id, step.title, step.sub, step.meta, step.tone])));
    if (key !== graphKey) {
      const focused = document.activeElement?.dataset?.node;
      const svg = svgNode('svg', { class: 'graph-edges', 'aria-hidden': 'true' });
      const nodes = [...rows].reverse().map(row => { const line = document.createElement('div'); line.className = 'graph-row'; line.style.setProperty('--columns', String(row.length)); line.append(...row.map(graphNode)); return line; });
      graph.replaceChildren(svg, ...nodes);
      graphKey = key;
      if (focused) graph.querySelector(`[data-node="${focused}"]`)?.focus();
      drawEdges(graph);
    }
    showStep();
  }
  graph.addEventListener('click', event => {
    const node = event.target.closest('[data-node]'); if (!node) return;
    selected = node.dataset.node; showStep();
    if (window.matchMedia?.('(max-width: 999px)').matches) inspector.scrollIntoView?.({ block: 'start' });
  });
  const send = async (text, allowDenied, images) => {
    replyButton.disabled = true; feedback.textContent = '';
    try { await api('run-message', { taskId: task.id, message: text, images, ...(allowDenied ? { allowDenied: true } : {}) }); replyInput.value = ''; if (images) replyImages.clear(); previous = ''; void poll(); }
    catch (error) { feedback.textContent = error.message; }
    finally { replyButton.disabled = false; }
  };
  reply.addEventListener('submit', async event => { event.preventDefault(); replyButton.disabled = true; void send(replyInput.value, false, await replyImages.collect()); });
  start.addEventListener('click', async () => {
    start.disabled = true; feedback.textContent = '';
    try { await api('run-start', { taskId: task.id }); void poll(); } catch (error) { feedback.textContent = error.message; }
    finally { start.disabled = false; }
  });
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try { await api('run-stop', { taskId: task.id }); feedback.textContent = 'Остановка запрошена.'; void poll(); }
    catch (error) { feedback.textContent = error.message; }
    finally { stop.disabled = false; }
  });
  async function load() {
    const run = await api('run', { taskId: task.id });
    if (!card.isConnected) return false;
    start.hidden = !!run; start.disabled = false;
    if (!run) { phase.textContent = 'Задача не запускалась.'; route.textContent = ''; showSteps(buildSteps(task, null)); return false; }
    const working = run.active || run.queued;
    const question = run.waiting?.question;
    stop.hidden = !working; remove.hidden = working; reply.hidden = !!question; phase.hidden = !!question; ask.form.hidden = !question;
    if (question) {
      if (question !== shownQuestion) { setMarkdown(ask.text, question); shownQuestion = question; }
      // Only when nothing else has the cursor: a question must not take over text being typed elsewhere.
      if (!asked && document.activeElement === document.body) ask.input.focus();
    }
    asked = !!question;
    badge.textContent = shortStatus(run.status); badge.className = `badge ${taskGroup(run.status)}`;
    const supervisorModel = modelNames(run.supervisorUsage) || shortModel(run.supervisor?.model), supervisorSpent = spentTokens(run.supervisorUsage);
    route.textContent = `Супервизор: ${[run.supervisor?.label || '', supervisorModel, supervisorSpent ? `${compactTokens(supervisorSpent)} ток.` : ''].filter(Boolean).join(' · ')}`;
    phase.textContent = working ? (run.queued ? 'Ждёт, пока освободится эта директория.' : run.phase || run.status) : run.statusReason || '';
    replyNote.textContent = working ? 'Супервизор прочитает сообщение перед следующим решением.' : 'Супервизор продолжит с того места, где остановился.';
    stats.textContent = `Решений: ${run.journal.filter(entry => entry.kind === 'decision').length} · запусков воркеров: ${run.workers.length}${run.costUsd ? ` · расчётная стоимость: $${run.costUsd.toFixed(3)}` : ''}`;
    // The minute keeps «идёт N мин» on a running node current even when the log is silent.
    const serialized = `${working ? Math.floor(Date.now() / 60000) : ''}${JSON.stringify(run)}`;
    if (serialized === previous) return working;
    previous = serialized;
    showSteps(buildSteps(task, run));
    // The report belongs to the final step; on its own it would push the graph off the screen.
    reportSlot.replaceChildren(...(run.report && !run.journal.some(entry => entry.action === 'finish') ? [reportPanel(run.report)] : []));
    const denied = denialsPanel(run, () => { void send('Я разрешил отклонённые действия. Продолжи работу и повтори их.', true); });
    denialSlot.replaceChildren(...(denied ? [denied] : []));
    if (!working) {
      const panels = [diffPanel(task.id, run.current?.snapshot?.tree || '', 'run', 'Все изменения с начала задачи')];
      if (run.baseline?.snapshot && !run.baseline.clean) panels.push(diffPanel(task.id, run.baseline.snapshot.tree || '', 'initial', 'Незакоммиченные изменения до запуска (не результат агентов)'));
      if (diffSlot.dataset.tree !== (run.current?.snapshot?.tree || '') || !diffSlot.children.length) { diffSlot.replaceChildren(...panels); diffSlot.dataset.tree = run.current?.snapshot?.tree || ''; }
    } else diffSlot.replaceChildren();
    return working;
  }
  async function poll() {
    if (polling || !card.isConnected) return;
    polling = true;
    let again = false, wait = 1000;
    try { again = await load(); }
    catch (error) { feedback.textContent = `${error.message}. Повторяем загрузку…`; again = true; wait = 2000; }
    finally { polling = false; }
    if (again && card.isConnected) setTimeout(poll, wait);
  }
  // The card is attached by the caller immediately after this function returns.
  setTimeout(poll, 0);
  return card;
}

function storedChoice(key) { try { return localStorage.getItem(key); } catch { return null; } }
function saveChoice(key, value) { try { localStorage.setItem(key, value); } catch { /* The choice just lasts until reload. */ } }
const boardQuery = window.matchMedia?.('(min-width: 1600px)');
let viewChoice = storedChoice('taskroom.view');
const taskView = () => viewChoice || (boardQuery?.matches ? 'board' : 'list');
const boardColumns = { attention: 'Требуют внимания', active: 'В работе', response: 'Готово', created: 'Не запущены' };
const latestLabels = { decision: 'Супервизор', report: 'Отчёт' };
const taskCards = new Map();
// A card is rebuilt only when its own task changes, so a half-written answer survives every refresh of the others.
function taskCard(t) {
  const name = projectName(projectData.find(p => p.id === t.projectId)), key = JSON.stringify([t, name]);
  const known = taskCards.get(t.id);
  if (known?.key === key) return known.node;
  const row = document.createElement('a'); row.href = `#task/${t.id}`; row.className = 'task-row';
  const icon = document.createElement('span'); icon.className = `task-icon ${taskGroup(t.status)}`; icon.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.className = 'task-row-body'; body.append(el('h3', t.title), el('p', name));
  if (t.latest?.text && !t.question) {
    const latest = document.createElement('p'); latest.className = 'task-latest';
    if (latestLabels[t.latest.kind]) { const label = el('span', `${latestLabels[t.latest.kind]}: `); label.className = 'task-latest-label'; latest.append(label); }
    latest.append(document.createTextNode(plainMarkdown(t.latest.text)));
    body.append(latest);
  }
  if (t.latest?.now && !t.question) { const now = el('p', `Сейчас: ${t.latest.now}`); now.className = 'task-now-note'; body.append(now); }
  const status = el('span', shortStatus(t.status)); status.className = `badge ${taskGroup(t.status)}`;
  row.append(icon, body, status, el('time', new Date(t.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })));
  const wrap = document.createElement('div'); wrap.className = 'task-row-wrap'; wrap.append(row);
  if (t.question) {
    const ask = questionForm(async (text, images) => { await api('run-message', { taskId: t.id, message: text, images }); message.textContent = 'Ответ отправлен, супервизор продолжает.'; await refreshTasks(); }, true);
    setMarkdown(ask.text, t.question); ask.more.hidden = t.question.length < 180 && !t.question.includes('\n');
    wrap.classList.add('has-question'); wrap.append(ask.form);
  }
  if (taskGroup(t.status) !== 'active') wrap.append(deleteButton('Удалить', 'Точно?', async () => { await api('task-delete', { taskId: t.id }); await refresh(); }));
  taskCards.set(t.id, { key, node: wrap });
  return wrap;
}
// Touches the DOM only when the list differs: moving a node would take the cursor out of an answer being typed.
function syncChildren(parent, nodes) {
  if (nodes.length === parent.children.length && nodes.every((node, index) => parent.children[index] === node)) return;
  const focused = document.activeElement;
  parent.replaceChildren(...nodes);
  if (focused?.isConnected && focused !== document.activeElement) focused.focus();
}
let boardShell = null;
function renderBoard(list, visible) {
  // «Не запущены» appear only when there is something to start: tasks normally start at once.
  const groups = taskFilter !== 'all' ? [taskFilter] : Object.keys(boardColumns).filter(group => group !== 'created' || visible.some(t => taskGroup(t.status) === group));
  const key = groups.join();
  if (boardShell?.key !== key || boardShell.root.parentNode !== list) {
    const root = document.createElement('div'); root.className = 'board'; root.dataset.columns = String(groups.length);
    const columns = {};
    for (const group of groups) {
      const column = document.createElement('section'); column.className = 'board-column'; column.dataset.group = group;
      const title = document.createElement('h2'), dot = document.createElement('i'), count = el('span', ''); dot.className = `dot ${group}`;
      title.append(dot, el('span', boardColumns[group]), count);
      const items = document.createElement('div'); items.className = 'board-list';
      const empty = el('p', 'Пусто'); empty.className = 'board-empty';
      column.append(title, items); root.append(column);
      columns[group] = { count, items, empty };
    }
    boardShell = { key, root, columns };
    list.replaceChildren(root);
  }
  for (const group of groups) {
    const { count, items, empty } = boardShell.columns[group], rows = visible.filter(t => taskGroup(t.status) === group);
    count.textContent = rows.length;
    syncChildren(items, rows.length ? rows.map(taskCard) : [empty]);
  }
}
function renderDashboard() {
  const query = document.querySelector('#task-search').value.toLocaleLowerCase();
  const view = taskView();
  const signature = JSON.stringify([taskData, projectData.map(p => [p.id, p.path]), taskFilter, query, view]);
  if (signature === dashboardSignature) return;
  dashboardSignature = signature;
  document.querySelector('#count-all').textContent = taskData.length;
  for (const group of Object.keys(boardColumns)) document.querySelector(`#count-${group}`).textContent = taskData.filter(t => taskGroup(t.status) === group).length;
  for (const id of [...taskCards.keys()]) if (!taskData.some(t => t.id === id)) taskCards.delete(id);
  const visible = [...taskData].reverse().filter(t => (taskFilter === 'all' || taskGroup(t.status) === taskFilter) && `${t.title} ${projectName(projectData.find(p => p.id === t.projectId))}`.toLocaleLowerCase().includes(query));
  const list = document.querySelector('#dashboard-tasks');
  if (visible.length && view === 'board') renderBoard(list, visible);
  else if (visible.length) syncChildren(list, visible.map(taskCard));
  else {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.append(el('span', '↗'), el('h3', taskData.length ? 'Ничего не найдено' : 'Здесь начнётся работа'), el('p', taskData.length ? 'Попробуй другой запрос или статус.' : 'Нажми «Новая задача» и опиши, что нужно сделать. Дальше работает супервизор.'));
    if (!projectData.length) { const link = el('a', 'Подключить первый проект →'); link.href = '#projects'; empty.append(link); }
    list.replaceChildren(empty);
  }
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === taskFilter)));
  document.querySelectorAll('[data-view-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.viewChoice === view)));
}
function renderQuestions() {
  const waiting = taskData.filter(task => task.question).length;
  const count = document.querySelector('#nav-questions');
  count.hidden = !waiting; count.textContent = waiting;
  document.title = waiting ? `(${waiting}) Есть вопрос — Taskroom` : 'Taskroom — задачи агентов';
}
const composer = document.querySelector('#composer');
const taskImages = imagePicker(document.querySelector('#task-description'), document.querySelector('#task'));
document.querySelector('#task-images').append(taskImages.node);
function openComposer() { if (composer.open) return; composer.showModal(); document.querySelector('#task-description').focus(); }
document.querySelector('#new-task').addEventListener('click', openComposer);
document.querySelector('#composer-cancel').addEventListener('click', () => composer.close());
// Closing keeps the draft: a stray click on the backdrop must not cost a written task.
composer.addEventListener('click', event => { if (event.target === composer) composer.close(); });
document.querySelector('#task-description').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) document.querySelector('#task').requestSubmit(); });
document.addEventListener('keydown', event => {
  if (event.code !== 'KeyN' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  event.preventDefault(); openComposer();
});
async function refreshTasks() {
  const response = await fetch('/api/state'); if (!response.ok) throw new Error('Нет связи с сервером');
  const data = await response.json(); token = data.token; taskData = data.tasks;
  document.querySelector('#recovery').hidden = !data.recoveryRequired;
  renderDashboard(); renderQuestions();
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
  const page = ['dashboard', 'task', 'projects', 'usage', 'settings'].includes(requested) ? requested : 'dashboard';
  document.querySelectorAll('[data-page]').forEach(node => { node.hidden = node.dataset.page !== page; });
  document.querySelectorAll('[data-nav]').forEach(node => { if (node.dataset.nav === (page === 'task' ? 'dashboard' : page)) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  document.querySelector('#breadcrumb').textContent = `Рабочее пространство / ${{ dashboard: 'Обзор', task: 'Задача', projects: 'Проекты', usage: 'Расход', settings: 'Подключения' }[page]}`;
  if (page === 'usage') void loadUsage();
  if (page === 'task') {
    const task = taskData.find(t => t.id === id);
    if (selectedTaskId !== id || !tasks.children.length || (task && tasks.firstElementChild.dataset.taskId !== id)) { selectedTaskId = id; tasks.replaceChildren(task ? renderTask(task) : el('p', 'Задача не найдена.')); }
  } else { selectedTaskId = null; tasks.replaceChildren(); }
}
let usagePeriod = storedChoice('taskroom.usagePeriod') || '7', usageRequest = 0;
function usageStart(period) {
  if (period === 'all') return null;
  if (period === 'today') { const day = new Date(); day.setHours(0, 0, 0, 0); return day.toISOString(); }
  return new Date(Date.now() - Number(period) * 86400000).toISOString();
}
const usageDate = value => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const windowNames = { five_hour: '5 часов', seven_day: '7 дней' };
function usageMeter(window) {
  const row = document.createElement('div'); row.className = 'usage-meter';
  const percent = Math.round(window.utilization * 100), passed = window.resetsAt && Date.parse(window.resetsAt) <= Date.now();
  const head = document.createElement('div'); head.className = 'usage-meter-head';
  head.append(el('span', windowNames[window.name] || window.name), el('strong', passed ? 'окно обновилось' : `${percent}%`));
  row.append(head);
  if (!passed) {
    const track = document.createElement('div'); track.className = 'usage-meter-track'; track.setAttribute('role', 'meter'); track.setAttribute('aria-valuenow', String(percent)); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-label', windowNames[window.name] || window.name);
    const fill = document.createElement('div'); fill.className = `usage-meter-fill${percent >= 95 ? ' critical' : percent >= 80 ? ' warning' : ''}`; fill.style.setProperty('--value', `${percent}%`); track.append(fill); row.append(track);
  }
  const note = el('p', passed ? 'Новое значение появится после следующего запуска.' : window.resetsAt ? `Сброс: ${usageDate(window.resetsAt)}` : ''); note.className = 'subtle'; row.append(note);
  return row;
}
function usageTable(caption, first, rows) {
  const section = document.createElement('section'); section.className = 'panel usage-section';
  const table = document.createElement('table'), head = document.createElement('tr');
  for (const title of [first, 'Запуски', 'Ввод', 'Вывод', 'Кеш: запись', 'Кеш: чтение', 'Оценка']) head.append(el('th', title));
  const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head);
  for (const { name, item } of rows) {
    const row = document.createElement('tr'), label = document.createElement('td'); label.append(name); row.append(label);
    for (const value of [item.runs, item.input, item.output, item.cacheWrite, item.cacheRead]) row.append(el('td', fullNumber(value)));
    row.append(el('td', item.costUsd === null ? '—' : `$${item.costUsd.toFixed(2)}`));
    body.append(row);
  }
  table.append(thead, body);
  const wrap = document.createElement('div'); wrap.className = 'usage-table'; wrap.append(table);
  section.append(el('h2', caption), wrap);
  return section;
}
function usageTile(label, value, note) {
  const tile = document.createElement('div'); tile.className = 'usage-tile';
  tile.append(el('span', label), el('strong', value)); if (note) { const small = el('p', note); small.className = 'subtle'; tile.append(small); }
  return tile;
}
function renderUsage(data) {
  const report = document.querySelector('#usage-report'), nodes = [];
  if (data.writeFailed) { const warning = el('p', 'Последнюю запись в журнал расхода сохранить не удалось: цифры могут быть неполными.'); warning.className = 'notice'; nodes.push(warning); }
  if (data.limits?.length) {
    const section = document.createElement('section'); section.className = 'panel usage-section';
    section.append(el('h2', 'Лимиты подписки'));
    for (const limit of data.limits) {
      const group = document.createElement('div'); group.className = 'usage-limits';
      const note = el('p', `${limit.label} · по данным последнего запуска, ${usageDate(limit.observedAt)}`); note.className = 'subtle';
      group.append(note, ...limit.windows.map(usageMeter)); section.append(group);
    }
    nodes.push(section);
  }
  if (!data.totals.runs) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.append(el('h3', data.firstAt ? 'За этот период запусков нет' : 'Расход пока не записан'), el('p', 'Расход записывается для каждого нового запуска агента. Токены прошлых запусков не сохранялись.'));
    nodes.push(empty); report.replaceChildren(...nodes); return;
  }
  const { totals } = data, tiles = document.createElement('div'); tiles.className = 'usage-tiles';
  tiles.append(usageTile('Потрачено токенов', compactTokens(totals.input + totals.output + totals.cacheWrite), 'Ввод, вывод и запись в кеш'), usageTile('Вывод', compactTokens(totals.output)), usageTile('Чтение из кеша', compactTokens(totals.cacheRead), 'Повторный контекст, стоит дешевле'), usageTile('Оценка стоимости', totals.costUsd === null ? '—' : `$${totals.costUsd.toFixed(2)}`, 'Только подписка, по ценам API'));
  nodes.push(tiles);
  nodes.push(usageTable('По агентам', 'Агент', data.agents.map(item => ({ name: item.label, item }))));
  nodes.push(usageTable('По моделям', 'Модель', data.models.map(item => ({ name: shortModel(item.model) || 'Модель из настроек CLI', item }))));
  nodes.push(usageTable('Супервизор и воркеры', 'Роль', data.roles.map(item => ({ name: item.kind === 'supervisor' ? 'Супервизор' : 'Воркеры', item }))));
  nodes.push(usageTable('Самые затратные задачи', 'Задача', data.tasks.map(item => {
    if (item.title === null) return { name: 'Удалённая задача', item };
    const link = el('a', item.title); link.href = `#task/${item.taskId}`;
    return { name: link, item };
  })));
  const notes = document.createElement('div'); notes.className = 'usage-notes subtle';
  notes.append(el('p', 'Оценка — это цена тех же токенов по API, а не реальное списание с подписки. Для LiteLLM, DeepSeek и Codex стоимость не показывается: CLI считает её не по твоему тарифу или не отдаёт.'));
  notes.append(el('p', `Учёт ведётся с ${usageDate(data.firstAt)}; более ранние запуски не учтены. Лимиты известны только для подписки Claude.`));
  if (totals.partial) notes.append(el('p', `Запусков, остановленных до итогов: ${totals.partial}. Их цифры неполные.`));
  nodes.push(notes);
  report.replaceChildren(...nodes);
}
async function loadUsage() {
  const request = ++usageRequest;
  document.querySelectorAll('[data-usage-period]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.usagePeriod === usagePeriod)));
  try {
    const data = await api('usage', { from: usageStart(usagePeriod) });
    if (request === usageRequest) renderUsage(data);
  } catch (error) { if (request === usageRequest) document.querySelector('#usage-report').replaceChildren(el('p', error.message)); }
}
document.querySelectorAll('[data-usage-period]').forEach(button => button.addEventListener('click', () => { usagePeriod = button.dataset.usagePeriod; saveChoice('taskroom.usagePeriod', usagePeriod); void loadUsage(); }));
// Fixed list: which CLI may supervise and which may work. The supervisor chooses within it for each task.
function renderTeam() {
  const form = document.querySelector('#team');
  if (!settings || form.contains(document.activeElement)) return;
  const supervisor = form.elements.supervisor;
  supervisor.replaceChildren(...agentOptions.map(option => { const node = el('option', option.label); node.value = option.id; return node; }));
  supervisor.value = settings.supervisor.id; form.elements.supervisorModel.value = settings.supervisor.model;
  const list = document.querySelector('#team-workers'); list.replaceChildren();
  for (const option of agentOptions) {
    const chosen = settings.workers.find(worker => worker.id === option.id);
    const row = document.createElement('fieldset'); row.dataset.workerOption = option.id;
    const enable = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.className = 'inline-checkbox'; box.checked = !!chosen; box.dataset.enabled = '';
    enable.append(box, document.createTextNode(` ${option.label}`));
    const modelLabel = el('label', 'Модель'), model = document.createElement('input'); model.maxLength = 120; model.placeholder = 'По умолчанию из CLI'; model.value = chosen?.model || ''; model.dataset.model = ''; modelLabel.append(model);
    const noteLabel = el('label', 'Подсказка супервизору'), note = document.createElement('input'); note.maxLength = 300; note.placeholder = 'Например: хорош в C#, дешёвый, для ревью'; note.value = chosen?.note || ''; note.dataset.note = ''; noteLabel.append(note);
    const grid = document.createElement('div'); grid.className = 'form-grid'; grid.append(modelLabel, noteLabel);
    row.append(enable, grid); list.append(row);
  }
}
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Не удалось загрузить данные');
  const data = await response.json(); token = data.token; profileTemplate = data.profileTemplate.variables; deepTemplate = data.deepTemplate;
  projectData = data.projects; taskData = data.tasks; agentOptions = data.agentOptions; settings = data.settings;
  document.querySelector('#recovery').hidden = !data.recoveryRequired;
  document.querySelector('#profiles textarea').value = (data.profiles?.variables || []).map(v => v.source ? `${v.target}=${v.source}` : v.target).join('\n');
  for (const field of document.querySelector('#lite-settings').elements) if (field.name) field.value = data.profiles?.liteSettings?.[field.name] || '';
  for (const field of document.querySelector('#deep-settings').elements) if (field.name) field.value = data.profiles?.deepSettings?.[field.name] || '';
  projects.replaceChildren(...projectData.map(projectItem));
  const previousProject = select.value;
  select.replaceChildren(...projectData.map(p => { const option = el('option', projectName(p)); option.title = p.path; option.value = p.id; return option; }));
  select.value = projectData.some(p => p.id === previousProject) ? previousProject : projectData[0]?.id || '';
  document.querySelector('#create-task').disabled = !projectData.length;
  document.querySelector('#composer-note').textContent = projectData.length ? 'Супервизор начнёт сразу. Твои незакоммиченные изменения сохраняются, а агенты их не откатывают.' : 'Сначала подключи репозиторий в разделе «Проекты».';
  renderTeam(); renderDashboard(); renderQuestions(); route();
}
window.addEventListener('hashchange', route);
document.querySelector('#task-search').addEventListener('input', renderDashboard);
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { taskFilter = button.dataset.filter; renderDashboard(); }));
for (const form of document.querySelectorAll('#project, #task, #profiles')) form.addEventListener('submit', async event => {
  event.preventDefault(); message.textContent = ''; composerError.textContent = '';
  const submit = form.querySelector('button:not([type=button])'); submit.disabled = true;
  try {
    let input = Object.fromEntries(new FormData(form));
    if (form.id === 'profiles') {
      const lines = input.variables.split('\n').map(line => line.trim()).filter(Boolean);
      if (lines.some(line => !/^[A-Za-z_][A-Za-z0-9_]*(?:\s*=\s*[A-Za-z_][A-Za-z0-9_]*)?$/.test(line))) throw new Error('Укажите только имена переменных или пары имён через знак =');
      input = { variables: lines.map(line => { const [target, source = ''] = line.split('=').map(value => value.trim()); return { target, source }; }) };
    }
    if (form.id === 'task') input.images = await taskImages.collect();
    const result = await api({ project: 'projects', task: 'tasks', profiles: 'profiles' }[form.id], input);
    const chosenProject = select.value;
    form.reset();
    if (form.id === 'task') { taskImages.clear(); select.value = chosenProject; if (composer.open) composer.close(); location.hash = `task/${result.id}`; selectedTaskId = null; if (result.startError) message.textContent = result.startError; }
    await refresh();
    if (form.id !== 'task') message.textContent = 'Сохранено';
  } catch (error) { (form.id === 'task' && composer.open ? composerError : message).textContent = error.message; }
  finally { submit.disabled = form.id === 'task' && !projectData.length; }
});
document.querySelector('#team').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, result = document.querySelector('#team-result');
  const workers = [...form.querySelectorAll('[data-worker-option]')].filter(row => row.querySelector('[data-enabled]').checked).map(row => ({ id: row.dataset.workerOption, model: row.querySelector('[data-model]').value, note: row.querySelector('[data-note]').value }));
  try { settings = await api('settings', { supervisor: { id: form.elements.supervisor.value, model: form.elements.supervisorModel.value }, workers }); result.textContent = 'Сохранено. Применится к следующим запускам.'; }
  catch (error) { result.textContent = error.message; }
});
for (const [id, endpoint] of [['lite-settings', 'litellm-settings'], ['lite-key', 'litellm-key'], ['deep-settings', 'deepseek-settings'], ['deep-key', 'deepseek-key']]) document.getElementById(id).addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const result = document.querySelector(id.startsWith('deep') ? '#deep-result' : '#lite-result'); result.textContent = '';
  try {
    const fields = Object.fromEntries(new FormData(form));
    await api(endpoint, id.endsWith('-key') ? fields : { settings: fields });
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
document.querySelector('#check-codex').addEventListener('click', async () => {
  const result = document.querySelector('#codex-result'); result.textContent = 'Проверка…';
  try { const data = await api('profile-check', { agent: 'codex' }); result.textContent = data.loggedIn ? 'Codex CLI сообщает о входе. Вызов модели и лимиты не проверены.' : data.error; }
  catch (error) { result.textContent = error.message; }
});
for (const [id, profile] of [['check-sub', 'subscription'], ['check-lite', 'litellm'], ['check-deep', 'deepseek']]) document.getElementById(id).addEventListener('click', async () => {
  const result = document.querySelector(profile === 'deepseek' ? '#deep-result' : '#profile-result'); result.textContent = 'Проверка…';
  try {
    const data = await api('profile-check', { profile });
    result.textContent = profile === 'subscription' ? (data.loggedIn ? 'Claude CLI сообщает о входе. Вызов модели не проверен.' : (data.error || 'Вход не подтверждён.')) : (!data.configured ? 'Сначала сохраните настройки профиля.' : data.missing.length ? `Не найдены значения: ${data.missing.join(', ')}. Ключ в хранилище: ${data.keySaved ? 'есть' : 'нет'}.` : `Все указанные значения присутствуют. Ключ в хранилище: ${data.keySaved ? 'есть' : 'нет'}. Подключение к модели не проверено.`);
  } catch (error) { result.textContent = error.message; }
});
refresh().catch(error => { message.textContent = error.message; });
document.querySelector('#recovery-confirm').addEventListener('click', async () => {
  try { await api('recovery-acknowledge', { confirmed: true }); await refresh(); }
  catch (error) { message.textContent = error.message; }
});
// Refresh only dashboard data; never reset an in-progress form or the task conversation.
let dashboardPollBusy = false, usageTicks = 0;
setInterval(async () => {
  if (dashboardPollBusy || document.hidden || !token) return;
  dashboardPollBusy = true;
  try {
    await refreshTasks();
    // Reads the whole journal, so not at the pace of the task list.
    if (!document.querySelector('[data-page=usage]').hidden && ++usageTicks % 6 === 0) await loadUsage();
  } catch { message.textContent = 'Нет связи с сервером. Повторяем подключение…'; }
  finally { dashboardPollBusy = false; }
}, 2500);
