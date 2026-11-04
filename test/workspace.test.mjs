import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkspace, parseStatus, captureWorkspace, nullRecords } from '../src/workspace.mjs';

const exec = promisify(execFile);
test('submodules are ignored: their changes and missing initialization neither block nor mark results stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-submodule-'));
  const repo = join(dir, 'repo'), source = join(dir, 'source');
  const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true });
  const commit = cwd => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  try {
    await mkdir(repo); await mkdir(source);
    await git(source, 'init', '--initial-branch=main');
    await writeFile(join(source, 'tracked.txt'), 'initial'); await git(source, 'add', '.'); await commit(source);
    await git(repo, 'init', '--initial-branch=main');
    await git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'deps/module'); await commit(repo);
    const baseline = await captureWorkspace(repo);
    assert.equal(baseline.clean, true);
    await writeFile(join(repo, 'deps/module/tracked.txt'), 'changed');
    await writeFile(join(repo, 'deps/module/untracked.txt'), 'untracked');
    const changed = await captureWorkspace(repo);
    assert.equal(changed.clean, true); assert.equal(changed.fingerprint, baseline.fingerprint);
    await rename(join(repo, 'deps/module/.git'), join(repo, 'deps/module/git-file-backup'));
    assert.equal((await captureWorkspace(repo)).fingerprint, baseline.fingerprint);
    await rm(join(repo, 'deps/module'), { recursive: true, force: true });
    assert.equal((await captureWorkspace(repo)).fingerprint, baseline.fingerprint);
    await writeFile(join(repo, 'own.txt'), 'own file');
    assert.notEqual((await captureWorkspace(repo)).fingerprint, baseline.fingerprint);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('NUL decoder preserves split Unicode and handles output larger than the old Git buffer', async () => {
  const encoded = Buffer.from('путь с пробелом\0');
  const records = [];
  for await (const value of nullRecords(Readable.from([...encoded].map(byte => Buffer.from([byte]))))) records.push(value);
  assert.deepEqual(records, ['путь с пробелом']);
  let count = 0;
  const record = 'x'.repeat(500) + '\0';
  const chunks = async function* () { for (let i = 0; i < 20000; i++) yield Buffer.from(record); };
  for await (const value of nullRecords(Readable.from(chunks()))) { assert.equal(value.length, 500); count++; }
  assert.equal(count, 20000);
  await assert.rejects(async () => { for await (const value of nullRecords(Readable.from([Buffer.from('unfinished')]))) void value; }, /незавершённый/);
});

test('real Git index listing over 4 MiB can be captured without changing the repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-large-index-'));
  async function input(args, data) {
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', dir, ...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      child.stderr.resume(); child.stdin.on('error', reject); child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Git fixture failed: ${code}`)));
      child.stdin.end(data);
    });
  }
  try {
    await exec('git', ['-C', dir, 'init', '--initial-branch=main']);
    await input(['hash-object', '-w', '--stdin'], '');
    const entries = Array.from({ length: 11000 }, (_, index) => `100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\t${'a'.repeat(180)}/${'b'.repeat(180)}/${index}.txt\0`).join('');
    assert.ok(Buffer.byteLength(entries) > 4 * 1024 * 1024);
    await input(['update-index', '-z', '--index-info'], entries);
    const workspace = await captureWorkspace(dir);
    assert.equal(workspace.changes.length, 11000); assert.ok(workspace.fingerprint);
    assert.equal((await inspectWorkspace(dir)).changes.length, 11000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('porcelain parser preserves unusual names and rename source order', () => {
  assert.deepEqual(parseStatus('R  новое имя\0старое имя\0?? line\nbreak\0'), [
    { path: 'новое имя', originalPath: 'старое имя', index: 'R', workingTree: ' ', untracked: false },
    { path: 'line\nbreak', index: '?', workingTree: '?', untracked: true }
  ]);
  assert.throws(() => parseStatus('R  missing\0'));
});

test('workspace inspection handles unborn, dirty, detached and missing repositories without changing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-git-'));
  const git = (...args) => exec('git', ['-C', dir, ...args], { windowsHide: true });
  try {
    await git('init', '--initial-branch=main');
    let state = await inspectWorkspace(dir);
    assert.equal(state.branch, 'main'); assert.equal(state.head, null); assert.equal(state.clean, true);
    await writeFile(join(dir, 'tracked.txt'), 'initial');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    state = await inspectWorkspace(dir); assert.equal(state.clean, true); assert.match(state.head, /^[a-f0-9]{40,64}$/);
    await writeFile(join(dir, 'tracked.txt'), 'staged'); await git('add', '.');
    await writeFile(join(dir, 'tracked.txt'), 'unstaged');
    await writeFile(join(dir, 'новый файл.txt'), 'untracked');
    const before = (await git('status', '--porcelain=v1', '-z')).stdout;
    state = await inspectWorkspace(dir);
    assert.equal(state.clean, false);
    assert.ok(state.changes.some(c => c.path === 'tracked.txt' && c.index === 'M' && c.workingTree === 'M'));
    assert.ok(state.changes.some(c => c.path === 'новый файл.txt' && c.untracked));
    assert.equal((await git('status', '--porcelain=v1', '-z')).stdout, before);
    const baseline = await captureWorkspace(dir);
    await writeFile(join(dir, 'tracked.txt'), 'different unstaged content, same status');
    const changed = await captureWorkspace(dir);
    assert.notEqual(changed.fingerprint, baseline.fingerprint);
    await writeFile(join(dir, 'новый файл.txt'), 'different untracked content');
    assert.notEqual((await captureWorkspace(dir)).fingerprint, changed.fingerprint);
    const unstaged = await captureWorkspace(dir); await git('add', 'tracked.txt');
    assert.notEqual((await captureWorkspace(dir)).fingerprint, unstaged.fingerprint);
    await mkdir(join(dir, 'nested')); await assert.rejects(inspectWorkspace(join(dir, 'nested')));
    await git('checkout', '--detach'); state = await inspectWorkspace(dir);
    assert.equal(state.detached, true); assert.equal(state.branch, null);
    await assert.rejects(inspectWorkspace(join(dir, 'missing')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
