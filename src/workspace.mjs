import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RequestError, stageError } from './errors.mjs';

const exec = promisify(execFile);
async function git(path, args) {
  return (await exec('git', ['--no-optional-locks', '-C', path, ...args], {
    timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout;
}

// Keep only one record in the decoder, even for multi-megabyte Git listings.
export async function* nullRecords(stream) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of stream) {
    const data = pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
    let start = 0, end;
    while ((end = data.indexOf('\0', start)) !== -1) {
      if (end - start > 65536) throw new RequestError('Git вернул слишком длинную запись пути', 400);
      yield data.slice(start, end); start = end + 1;
    }
    pending = data.slice(start);
    if (pending.length > 65536) throw new RequestError('Git вернул слишком длинную запись пути', 400);
  }
  pending += decoder.end();
  if (pending) throw new RequestError('Git вернул незавершённый список файлов', 400);
}

async function* gitRecords(path, args) {
  const child = spawn('git', ['--no-optional-locks', '-C', path, ...args], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new RequestError(`Git не смог прочитать список файлов (${args[0]}, код ${code ?? 'неизвестен'}). Проверьте доступ к репозиторию.`, 400)));
  });
  // Attach immediately: process errors may arrive before stdout has finished.
  completed.catch(() => {});
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    yield* nullRecords(child.stdout);
    await completed;
  } catch (error) { throw stageError('Не удалось прочитать список файлов Git', error); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
}

// NUL-delimited porcelain preserves spaces, Unicode and newlines in filenames.
export function parseStatus(output) {
  const records = output.split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Invalid Git status');
    const index = record[0], workingTree = record[1];
    const change = { path: record.slice(3), index, workingTree, untracked: record.startsWith('??') };
    if (/[RC]/.test(index + workingTree)) {
      change.originalPath = records[++i];
      if (!change.originalPath) throw new Error('Invalid Git rename');
    }
    changes.push(change);
  }
  return changes;
}

export async function inspectWorkspace(path) {
  const actual = await realpath(path);
  const top = (await git(actual, ['rev-parse', '--show-toplevel'])).trim();
  const canonicalTop = await realpath(top);
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (normalize(actual) !== normalize(canonicalTop)) throw new Error('Repository root changed');
  let branchRef;
  try { branchRef = (await git(actual, ['symbolic-ref', '-q', 'HEAD'])).trim(); }
  catch (error) { if (error.code !== 1) throw error; branchRef = 'HEAD'; }
  const changes = [];
  let rename = null;
  for await (const record of gitRecords(actual, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])) {
    if (rename !== null) { changes.push(...parseStatus(rename + '\0' + record + '\0')); rename = null; }
    else if (/[RC]/.test(record.slice(0, 2))) rename = record;
    else changes.push(...parseStatus(record + '\0'));
  }
  if (rename !== null) throw new RequestError('Git вернул незавершённое переименование', 400);
  let head = null;
  // A new repository has a symbolic HEAD but no commit yet.
  if (branchRef === 'HEAD' || branchRef.startsWith('refs/heads/')) {
    try { head = (await git(actual, ['rev-parse', '--verify', 'HEAD'])).trim(); }
    catch (error) { if (branchRef === 'HEAD') throw error; }
  } else throw new Error('Invalid HEAD');
  return { path: canonicalTop, branch: branchRef.startsWith('refs/heads/') ? branchRef.slice(11) : null,
    head, detached: branchRef === 'HEAD', clean: changes.length === 0, changes,
    inspectedAt: new Date().toISOString() };
}

// A comparison fingerprint, not a restorable snapshot. Never follow symlinks.
// Submodules are ignored entirely: their state neither blocks a run nor marks results stale.
export async function captureWorkspace(path) {
  const workspace = await inspectWorkspace(path);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([workspace.path, workspace.branch, workspace.head, workspace.changes]));
  const gitlinks = new Set();
  for await (const entry of gitRecords(workspace.path, ['ls-files', '--stage', '-z'])) {
    if (entry.startsWith('160000 ')) gitlinks.add(entry.slice(entry.indexOf('\t') + 1));
    else hash.update(entry + '\0');
  }
  const paths = new Set();
  for await (const name of gitRecords(workspace.path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])) if (!gitlinks.has(name)) paths.add(name);
  async function fileFingerprint(name) {
    const file = resolve(workspace.path, name);
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return 'missing'; }
    if (info.isSymbolicLink()) return 'link\0' + await readlink(file);
    else if (info.isFile()) {
      // Reject a path traversing a directory junction outside this repository.
      const canonical = await realpath(file);
      const prefix = workspace.path.endsWith('\\') || workspace.path.endsWith('/') ? workspace.path : workspace.path + (process.platform === 'win32' ? '\\' : '/');
      const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (!normalized(canonical).startsWith(normalized(prefix))) throw new RequestError(`Файл «${name}» ведёт за пределы репозитория. Запуск заблокирован.`, 400);
      const content = createHash('sha256');
      for await (const chunk of createReadStream(file)) content.update(chunk);
      return 'file\0' + info.mode + '\0' + content.digest('hex');
    } else throw new RequestError(`Неподдерживаемый тип файла «${name}». Запуск заблокирован.`, 400);
  }
  const names = [...paths].sort();
  // Bound concurrent file reads while preserving deterministic hash order.
  for (let start = 0; start < names.length; start += 16) {
    const batch = names.slice(start, start + 16);
    const results = await Promise.allSettled(batch.map(fileFingerprint));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') throw stageError(`Не удалось прочитать файл «${batch[index]}» для сравнения состояния`, result.reason);
      hash.update(batch[index] + '\0' + result.value + '\0');
    }
  }
  const after = await inspectWorkspace(path);
  if (JSON.stringify([workspace.head, workspace.branch, workspace.changes]) !== JSON.stringify([after.head, after.branch, after.changes])) throw new RequestError('Репозиторий изменился во время подготовки. Дождитесь завершения внешних изменений и повторите подготовку.', 409);
  return { ...workspace, fingerprint: hash.digest('hex') };
}
