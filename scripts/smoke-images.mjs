// Explicit opt-in check with real models. Only generated solid-colour pictures and a disposable repository are sent; it uses the model limit.
// The colour is named only in the picture, so a correct answer shows the model received it.
// Usage: node scripts/smoke-images.mjs [claude] [codex] [claude-model=haiku]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { adapters } from '../src/agents.mjs';

function solidPng([red, green, blue], size = 64) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const red = solidPng([220, 20, 20]), blue = solidPng([20, 40, 220]);
const isRed = /красн|\bred\b/i, isBlue = /син|голуб|\bblue\b/i;
const question = 'Какого цвета приложенное изображение? Ответь одним словом. Если изображения не видишь, ответь: НЕТ.';

const args = process.argv.slice(2), agents = args.filter(arg => ['claude', 'codex'].includes(arg)), selected = agents.length ? agents : ['claude', 'codex'];
const claudeModel = args.find(arg => !['claude', 'codex'].includes(arg)) ?? 'haiku';
const base = await mkdtemp(join(tmpdir(), 'taskroom-images-smoke-')), repo = join(base, 'repo'), data = join(base, 'data');
const git = (...command) => promisify(execFile)('git', command, { cwd: repo, windowsHide: true });
await promisify(execFile)('git', ['init', '--initial-branch=main', repo], { windowsHide: true });
await writeFile(join(repo, 'README.md'), 'smoke\n');
await git('add', '.');
await git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'init');
const redPath = join(base, 'red.png'), bluePath = join(base, 'blue.png');
await writeFile(redPath, red); await writeFile(bluePath, blue);

// The adapter alone: first turn, then a continued session that receives a new picture.
function ask(agent, options) {
  return new Promise((done, failed) => {
    const adapter = adapters[agent], parser = adapter.stream(() => {}), child = adapter.launch({ agent, profile: 'subscription', cwd: repo, environment: process.env, model: agent === 'claude' ? claudeModel : '', ...options });
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => parser.push(chunk)); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', failed);
    child.on('close', code => { const status = parser.finish(code); done({ status, text: parser.finalText(), session: parser.sessionId(), error: parser.errorText?.() || stderr.slice(-500), code }); });
  });
}
const server = spawn(process.execPath, ['src/server.mjs'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, TASK_ORCHESTRATOR_DATA: data, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  for (const agent of selected) {
    console.log(`\n${agent}: прямой запуск`);
    const first = await ask(agent, { prompt: question, images: [{ path: redPath, type: 'image/png' }] });
    console.log(`  первый ход: ${first.status}, ответ: ${first.text.trim()} ${first.error}`);
    assert.equal(first.status, 'выполнение завершено'); assert.match(first.text, isRed);
    assert.ok(first.session, 'нет сессии');
    const second = await ask(agent, { prompt: 'Теперь приложено новое изображение. Какого оно цвета? Ответь одним словом.', images: [{ path: bluePath, type: 'image/png' }], resumeSessionId: first.session });
    console.log(`  продолжение: ${second.status}, ответ: ${second.text.trim()} ${second.error}`);
    assert.equal(second.status, 'выполнение завершено'); assert.match(second.text, isBlue);
  }

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
  const project = await post('projects', { path: repo });
  for (const agent of selected) {
    const id = agent === 'claude' ? 'claude-subscription' : 'codex', model = agent === 'claude' ? claudeModel : '';
    await post('settings', { supervisor: { id, model }, workers: [{ id, model, note: '' }] });
    console.log(`\n${agent}: задача через сервер, супервизор и воркер`);
    const task = await post('tasks', { projectId: project.id, description: 'Какого цвета приложенное изображение? Поручи это одному воркеру на чтение, файлы не меняй. В summary назови цвет так, как его назвал воркер.', images: [{ data: red.toString('base64') }] });
    assert.ok(!task.startError, task.startError);
    const settled = async () => {
      const end = Date.now() + 6 * 60000;
      while (Date.now() < end) { const run = await post('run', { taskId: task.id }); if (!run.active && !run.queued) return run; await delay(1000); }
      throw new Error('Задача не завершилась вовремя');
    };
    const run = await settled();
    console.log(`  статус: ${run.status}. Воркеров: ${run.workers.length}. Отчёт: ${run.report?.summary} ${run.error || ''}`);
    assert.equal(run.status, 'готово');
    assert.ok(run.workers.length >= 1, 'супервизор не запустил воркера');
    assert.equal(run.workers[0].images.length, 1);
    assert.match(run.workers[0].answer, isRed); assert.match(run.report.summary, isRed);
    await post('run-message', { taskId: task.id, message: 'Я приложил к этому сообщению ещё одно изображение. Какого цвета именно оно? Поручи воркеру на чтение и назови цвет нового изображения в summary. Файлы не меняй.', images: [{ data: blue.toString('base64') }] });
    const next = await settled();
    console.log(`  продолжение: ${next.status}. Отчёт: ${next.report?.summary} ${next.error || ''}`);
    assert.equal(next.status, 'готово'); assert.equal(next.images.length, 2);
    assert.match(next.report.summary, isBlue);
    assert.equal((await git('status', '--porcelain')).stdout, '', 'картинки или результат попали в репозиторий');
  }
  console.log('\nГотово.');
} finally {
  server.kill(); if (server.exitCode === null) await once(server, 'exit');
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
