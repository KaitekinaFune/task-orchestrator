// Explicit opt-in check with real models. Only a disposable repository is sent to them; it uses the model limit.
// Usage: node scripts/smoke-supervisor.mjs [model] [--keep]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2), keep = args.includes('--keep'), model = args.find(arg => !arg.startsWith('--')) ?? 'haiku';
const base = await mkdtemp(join(tmpdir(), 'taskroom-supervisor-smoke-')), repo = join(base, 'repo'), data = join(base, 'data');
const git = (...command) => promisify(execFile)('git', command, { cwd: repo, windowsHide: true });
await promisify(execFile)('git', ['init', '--initial-branch=main', repo], { windowsHide: true });
await writeFile(join(repo, 'add.mjs'), 'export function add(a, b) { return a - b; }\n');
await writeFile(join(repo, 'add.test.mjs'), "import assert from 'node:assert/strict';\nimport { add } from './add.mjs';\nassert.equal(add(2, 3), 5);\n");
await git('add', '.');
await git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'init');
const head = (await git('rev-parse', 'HEAD')).stdout;
// A change that belongs to the user and has to survive the run.
await writeFile(join(repo, 'notes.txt'), 'мои заметки\n');

const server = spawn(process.execPath, ['src/server.mjs'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, TASK_ORCHESTRATOR_DATA: data, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  let output = '';
  for await (const chunk of server.stdout) { output += chunk; if (output.includes('http://127.0.0.1:')) break; }
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const { token } = await (await fetch(`${url}/api/state`)).json();
  const post = async (endpoint, value) => {
    const response = await fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Token': token, Origin: url }, body: JSON.stringify(value) });
    const body = await response.json();
    assert.ok(response.ok, `${endpoint}: ${JSON.stringify(body)}`);
    return body;
  };
  await post('settings', { supervisor: { id: 'claude-subscription', model }, workers: [{ id: 'claude-subscription', model, note: '' }] });
  const project = await post('projects', { path: repo });
  await post('project-checks', { projectId: project.id, checks: [{ id: 'tests', name: 'Тесты', executable: process.execPath, args: ['add.test.mjs'], timeoutSeconds: 60 }] });
  const task = await post('tasks', { projectId: project.id, description: 'Функция add() в add.mjs считает неправильно. Исправь её и убедись, что проверка проекта проходит.' });
  assert.ok(!task.startError, task.startError);

  let seen = 0;
  async function settled(limitMinutes = 6) {
    const end = Date.now() + limitMinutes * 60000;
    while (Date.now() < end) {
      const run = await post('run', { taskId: task.id });
      for (const entry of run.journal.slice(seen)) if (entry.kind === 'decision') console.log(`  решение: ${entry.action} — ${entry.reason}`);
      seen = run.journal.length;
      if (!run.active && !run.queued) return run;
      await delay(1000);
    }
    throw new Error('Задача не завершилась вовремя');
  }
  console.log('Первая задача:');
  const first = await settled();
  console.log(`Статус: ${first.status}. ${first.statusReason}\n${first.error || ''}`);
  console.log(`Отчёт: ${first.report?.summary}\nФакты: ${JSON.stringify(first.report?.evidence)}\nРешений: ${first.counters.turns}, воркеров: ${first.workers.length}, стоимость: $${first.costUsd.toFixed(4)}`);
  assert.equal(first.status, 'готово');
  const { add } = await import(`file:///${join(repo, 'add.mjs').replaceAll('\\', '/')}`);
  assert.equal(add(2, 3), 5, 'add() не исправлена');
  assert.equal(first.report.evidence.filesChanged, true);
  assert.equal(await readFile(join(repo, 'notes.txt'), 'utf8'), 'мои заметки\n', 'изменение пользователя потеряно');
  assert.equal((await git('rev-parse', 'HEAD')).stdout, head, 'появился коммит');
  const diff = await post('run-diff', { taskId: task.id, scope: 'run' });
  assert.deepEqual(diff.files.map(file => file.path), ['add.mjs'], 'diff задачи включает чужие файлы');

  console.log('\nПродолжение:');
  await post('run-message', { taskId: task.id, message: 'Какой файл ты менял? Файлы больше не меняй, просто ответь.' });
  const second = await settled();
  console.log(`Статус: ${second.status}. Отчёт: ${second.report?.summary}\nРешений: ${second.counters.turns}, стоимость всего: $${second.costUsd.toFixed(4)}`);
  assert.equal(second.status, second.report.evidence.checks === 'устарели' ? 'требуется решение' : 'готово');
  assert.match(second.report.summary, /add\.mjs/);
  assert.deepEqual(second.journal.filter(entry => entry.kind === 'user').length, 2);
  console.log(`\nГотово. Журнал задачи: ${join(data, 'runs', `${task.id}.json`)}`);
} finally {
  server.kill(); if (server.exitCode === null) await once(server, 'exit');
  if (keep) console.log(`Данные сохранены: ${base}`); else await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
