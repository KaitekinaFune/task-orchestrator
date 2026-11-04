import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RequestError } from './errors.mjs';

const objectId = /^[0-9a-f]{40,64}$/;
const metaLimit = 4 * 1024 * 1024;

function run(path, args, { env = {}, limit = 1024 * 1024, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path, ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
    });
    const chunks = [];
    let size = 0, truncated = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (truncated) return;
      if (size + chunk.length > limit) { chunks.push(chunk.subarray(0, limit - size)); size = limit; truncated = true; child.kill(); return; }
      chunks.push(chunk); size += chunk.length;
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Git timed out (${args[0]})`));
      else if (code !== 0 && !truncated) reject(new Error(`Git failed (${args[0]}, code ${code})`));
      else resolvePromise({ stdout: Buffer.concat(chunks).toString('utf8'), truncated });
    });
  });
}

// `--raw --numstat -z` lists every file twice: status from the raw part, line counts from numstat.
export function parseDiffSummary(output) {
  const tokens = output.split('\0'), files = [], byPath = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token[0] === ':') {
      const status = token.split(' ')[4]?.[0];
      if (!status) throw new Error('Invalid Git raw diff');
      const file = { status, additions: 0, deletions: 0, binary: false };
      if (/[RC]/.test(status)) file.originalPath = tokens[++i];
      file.path = tokens[++i];
      if (!file.path) throw new Error('Invalid Git raw diff');
      files.push(file); byPath.set(file.path, file);
    } else {
      const first = token.indexOf('\t'), second = token.indexOf('\t', first + 1);
      if (first < 0 || second < 0) throw new Error('Invalid Git numstat');
      let path = token.slice(second + 1);
      if (!path) { i++; path = tokens[++i]; }
      const file = byPath.get(path);
      if (!file) throw new Error('Invalid Git numstat');
      file.binary = token[0] === '-';
      if (!file.binary) { file.additions = Number(token.slice(0, first)); file.deletions = Number(token.slice(first + 1, second)); }
    }
  }
  return files;
}

// Hunk lines are always prefixed, so only a real file header starts with these bytes after a newline.
export function splitPatch(patch) { return patch ? patch.split(/(?<=\n)(?=diff --git )/) : []; }

// Snapshots are Git trees built with a temporary index and a private object directory:
// neither the user's index nor their .git/objects is written. The repository's objects are
// read through an alternate, so history pruned from it later makes an old diff unavailable, never wrong.
export function createSnapshots(root, { sizeLimit = 512 * 1024 * 1024, patchLimit = 4 * 1024 * 1024 } = {}) {
  const store = taskId => {
    if (typeof taskId !== 'string' || !/^[\w-]+$/.test(taskId)) throw new RequestError('Некорректный идентификатор задачи', 400);
    return resolve(root, taskId);
  };
  const gitPath = async (path, name) => resolve(path, (await run(path, ['rev-parse', '--git-path', name])).stdout.trim());
  const objectEnvironment = async (taskId, path) => ({
    GIT_OBJECT_DIRECTORY: resolve(store(taskId), 'objects'),
    // Quoted C-style, so that a path containing the list separator stays one entry.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify((await gitPath(path, 'objects')).replaceAll('\\', '/'))
  });
  async function changedSize(path, changes) {
    let total = 0;
    for (const change of changes) {
      try { const info = await lstat(resolve(path, change.path)); if (info.isFile()) total += info.size; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return total;
  }
  return {
    // A failed snapshot must not stop the agent: the error is recorded and the diff reports it.
    async take(taskId, path, workspace) {
      let temp;
      try {
        if (await changedSize(path, workspace.changes || []) > sizeLimit) return { error: `Изменённые файлы занимают больше ${Math.round(sizeLimit / 1048576)} МиБ; копия не сохранена.` };
        const objects = resolve(store(taskId), 'objects');
        await mkdir(objects, { recursive: true });
        temp = await mkdtemp(resolve(store(taskId), 'tmp-'));
        const index = resolve(temp, 'index');
        // The copied index keeps stat data, so unchanged files are not hashed again.
        try { await copyFile(await gitPath(path, 'index'), index); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const env = { ...await objectEnvironment(taskId, path), GIT_INDEX_FILE: index };
        await run(path, ['-c', 'core.safecrlf=false', '-c', 'advice.addEmbeddedRepo=false', 'add', '-A'], { env });
        const tree = (await run(path, ['write-tree'], { env })).stdout.trim();
        if (!objectId.test(tree)) throw new Error('Invalid tree');
        return { tree, head: workspace.head ?? null, takenAt: new Date().toISOString() };
      } catch { return { error: 'Git не смог сохранить копию файлов. Проверьте доступ к файлам и свободное место.' }; }
      finally { if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {}); }
    },
    // `from` is null for a repository without commits. External diff drivers and textconv are
    // disabled: viewing a diff must not run commands configured in the repository.
    async diff(taskId, path, from, to) {
      const env = await objectEnvironment(taskId, path);
      const base = from ?? (await run(path, ['hash-object', '-t', 'tree', '--stdin'], { env })).stdout.trim();
      if (!objectId.test(base) || !objectId.test(to)) throw new RequestError('Некорректный идентификатор снимка', 400);
      const args = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--find-renames', '--ignore-submodules=all'];
      const summary = await run(path, [...args, '--raw', '--numstat', '-z', base, to], { env, limit: metaLimit });
      if (summary.truncated) throw new RequestError('Изменено слишком много файлов для показа diff', 400);
      const files = parseDiffSummary(summary.stdout);
      const patch = await run(path, [...args, '--patch', base, to], { env, limit: patchLimit });
      const parts = splitPatch(patch.stdout);
      if (patch.truncated ? parts.length > files.length : parts.length !== files.length) throw new Error('Git diff does not match its summary');
      files.forEach((file, index) => {
        if (index < parts.length) file.patch = parts[index];
        if (patch.truncated && index >= parts.length - 1) file.patchTruncated = true;
      });
      return { files, truncated: patch.truncated, patchLimit };
    },
    async remove(taskIds) {
      await Promise.all(taskIds.map(taskId => rm(store(taskId), { recursive: true, force: true, maxRetries: 3 })));
    }
  };
}
