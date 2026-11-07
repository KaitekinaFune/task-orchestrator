import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkspace } from '../src/workspace.mjs';
import { createSnapshots, parseDiffSummary, splitPatch } from '../src/snapshots.mjs';
import { createRuns } from '../src/runs.mjs';
import { defaultSettings } from '../src/supervisor.mjs';
import { stopTree } from '../src/claude.mjs';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout;
const commit = cwd => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-snapshot-'));
  const repo = join(dir, 'repo');
  try {
    await mkdir(repo); await git(repo, 'init', '--initial-branch=main');
    await git(repo, 'config', 'core.autocrlf', 'false');
    await run({ dir, repo, snapshots: createSnapshots(join(dir, 'snapshots')) });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
}
const take = async (snapshots, repo) => snapshots.take('task', repo, await captureWorkspace(repo));

test('diff between snapshots shows only the change of the turn, with status and line counts', async () => {
  await fixture(async ({ repo, snapshots }) => {
    await writeFile(join(repo, 'edited.txt'), 'one\ntwo\n');
    await writeFile(join(repo, 'removed.txt'), 'gone\n');
    await writeFile(join(repo, 'moved.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    await git(repo, 'add', '.'); await commit(repo);
    // A change the user made before the run must not be attributed to this turn.
    await writeFile(join(repo, 'user file.txt'), 'user work\n');
    const start = await take(snapshots, repo);
    assert.ok(start.tree, start.error);

    await writeFile(join(repo, 'edited.txt'), 'one\nchanged\nthree\n');
    await rm(join(repo, 'removed.txt'));
    await rm(join(repo, 'moved.txt')); await writeFile(join(repo, 'renamed.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    await writeFile(join(repo, 'новый файл.txt'), 'привет\n');
    await writeFile(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 0, 3]));
    await writeFile(join(repo, 'ignored.txt'), 'never included\n');
    const end = await take(snapshots, repo);
    assert.ok(end.tree, end.error);

    const diff = await snapshots.diff('task', repo, start.tree, end.tree);
    const byPath = Object.fromEntries(diff.files.map(file => [file.path, file]));
    assert.deepEqual(Object.keys(byPath).sort(), ['edited.txt', 'image.bin', 'removed.txt', 'renamed.txt', 'новый файл.txt'].sort());
    assert.equal(byPath['edited.txt'].status, 'M'); assert.equal(byPath['edited.txt'].additions, 2); assert.equal(byPath['edited.txt'].deletions, 1);
    assert.match(byPath['edited.txt'].patch, /\n\+changed\n/);
    assert.equal(byPath['removed.txt'].status, 'D');
    assert.equal(byPath['renamed.txt'].status, 'R'); assert.equal(byPath['renamed.txt'].originalPath, 'moved.txt');
    assert.equal(byPath['image.bin'].binary, true); assert.equal(byPath['новый файл.txt'].status, 'A');
    assert.equal(diff.truncated, false);

    const initial = await snapshots.diff('task', repo, start.head, start.tree);
    assert.deepEqual(initial.files.map(file => file.path), ['user file.txt']);
  });
});

test('snapshot leaves the user index and object store untouched and survives later edits', async () => {
  await fixture(async ({ dir, repo, snapshots }) => {
    await writeFile(join(repo, 'a.txt'), 'committed\n'); await git(repo, 'add', '.'); await commit(repo);
    await writeFile(join(repo, 'a.txt'), 'unstaged edit\n');
    await writeFile(join(repo, 'staged.txt'), 'staged\n'); await git(repo, 'add', 'staged.txt');
    await writeFile(join(repo, 'untracked.txt'), 'private content\n');
    const statusBefore = await git(repo, 'status', '--porcelain=v1');
    const indexBefore = await readFile(join(repo, '.git/index'));
    const objectsBefore = (await git(repo, 'count-objects', '-v'));

    const start = await take(snapshots, repo);
    assert.ok(start.tree, start.error);
    assert.equal(await git(repo, 'status', '--porcelain=v1'), statusBefore);
    assert.deepEqual(await readFile(join(repo, '.git/index')), indexBefore);
    assert.equal(await git(repo, 'count-objects', '-v'), objectsBefore);
    assert.deepEqual((await readdir(join(dir, 'snapshots/task'))), ['objects'], 'the temporary index is removed');

    // The stored state stays readable after the working copy moves on.
    await writeFile(join(repo, 'untracked.txt'), 'overwritten\n');
    const initial = await snapshots.diff('task', repo, start.head, start.tree);
    assert.match(initial.files.find(file => file.path === 'untracked.txt').patch, /\+private content/);

    await snapshots.remove(['task']);
    await assert.rejects(stat(join(dir, 'snapshots/task')), { code: 'ENOENT' });
    await assert.rejects(snapshots.diff('task', repo, start.head, start.tree));
  });
});

test('repository without commits is compared to an empty tree', async () => {
  await fixture(async ({ repo, snapshots }) => {
    await writeFile(join(repo, 'first.txt'), 'first\n');
    const start = await take(snapshots, repo);
    assert.equal(start.head, null); assert.ok(start.tree, start.error);
    const diff = await snapshots.diff('task', repo, start.head, start.tree);
    assert.deepEqual(diff.files.map(file => [file.status, file.path]), [['A', 'first.txt']]);
  });
});

test('oversized changes and long patches are reported, not silently dropped', async () => {
  await fixture(async ({ dir, repo }) => {
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', '.'); await commit(repo);
    const limited = createSnapshots(join(dir, 'limited'), { sizeLimit: 10 });
    await writeFile(join(repo, 'big.txt'), 'x'.repeat(100));
    assert.match((await take(limited, repo)).error, /МиБ/);

    const short = createSnapshots(join(dir, 'short'), { patchLimit: 200 });
    const start = await take(short, repo);
    await writeFile(join(repo, 'a.txt'), 'b\n'.repeat(500)); await writeFile(join(repo, 'z.txt'), 'z\n');
    const end = await take(short, repo);
    const diff = await short.diff('task', repo, start.tree, end.tree);
    assert.equal(diff.truncated, true); assert.deepEqual(diff.files.map(file => file.path), ['a.txt', 'z.txt']);
    assert.ok(diff.files.at(-1).patchTruncated); assert.equal(diff.files.at(-1).patch, undefined);
  });
});

test('viewing a diff does not run drivers configured in the repository', async () => {
  await fixture(async ({ dir, repo, snapshots }) => {
    const marker = join(dir, 'executed').replaceAll('\\', '/');
    await writeFile(join(repo, 'a.txt'), 'a\n'); await git(repo, 'add', '.'); await commit(repo);
    const start = await take(snapshots, repo);
    await writeFile(join(repo, 'a.txt'), 'b\n');
    const end = await take(snapshots, repo);
    await git(repo, 'config', 'diff.external', `sh -c 'touch ${marker}'`);
    const diff = await snapshots.diff('task', repo, start.tree, end.tree);
    assert.match(diff.files[0].patch, /\+b/);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  });
});

test('summary parser and patch splitter handle renames, tabs and lines resembling headers', () => {
  const raw = ':100644 100644 aaa bbb M\0a\tb.txt\0:100644 100644 aaa ccc R090\0old.txt\0new.txt\0\x001\t2\ta\tb.txt\0-\t-\t\0old.txt\0new.txt\0';
  assert.deepEqual(parseDiffSummary(raw), [
    { status: 'M', additions: 1, deletions: 2, binary: false, path: 'a\tb.txt' },
    { status: 'R', additions: 0, deletions: 0, binary: true, originalPath: 'old.txt', path: 'new.txt' }
  ]);
  const parts = splitPatch('diff --git a/x b/x\n+diff --git inside\n+text\rdiff --git after cr\ndiff --git a/y b/y\n');
  assert.equal(parts.length, 2);
  assert.deepEqual(splitPatch(''), []);
});

test('a run keeps the snapshots and serves its diff after the files move on', async () => {
  await fixture(async ({ repo, snapshots }) => {
    await writeFile(join(repo, 'code.txt'), 'old\n'); await git(repo, 'add', '.'); await commit(repo);
    await writeFile(join(repo, 'user.txt'), 'user change\n');
    const state = { projects: [{ id: 'project', path: repo, checks: [] }], tasks: [{ id: 'task', projectId: 'project', title: 't', description: 'd' }], settings: defaultSettings() };
    const action = fields => ({ reason: 'r', workers: [], check_ids: [], question: null, summary: null, outcome: null, ...fields });
    const decisions = [action({ action: 'run_workers', workers: [{ name: 'W', agent: 'claude-subscription', access: 'write', prompt: 'p', continue_worker: null }] }), action({ action: 'get_diff' }), action({ action: 'finish', outcome: 'done', summary: 'ok' })];
    const line = extra => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...extra }) + '\n';
    const prompts = [];
    const manager = createRuns({ getState: () => state, snapshots, store: { save: async () => {} },
      environmentFor: async () => ({ environment: { ...process.env }, secrets: [] }),
      launch: ({ cwd, environment, supervisor, prompt }) => {
        if (supervisor) prompts.push(prompt);
        const script = supervisor ? `process.stdout.write(${JSON.stringify(line({ structured_output: decisions.shift() }))})` : `require('fs').writeFileSync('code.txt', 'new\\n'); process.stdout.write(${JSON.stringify(line())})`;
        const child = spawn(process.execPath, ['-e', script], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); child.stdin.on('error', () => {}); child.stdin.end(); return child;
      }, stop: stopTree });
    await manager.start('task');
    let run;
    for (let i = 0; i < 500 && (run = manager.get('task')).status !== 'готово'; i++) await delay(20);
    assert.equal(run.status, 'готово', run.error);
    assert.ok(run.baseline.snapshot.tree); assert.ok(run.current.snapshot.tree);
    assert.deepEqual(run.workers[0].changedPaths, ['code.txt'], 'the worker is not credited with the user\'s earlier change');
    assert.match(prompts[2], /\+new/, 'the supervisor saw the diff it asked for');
    assert.doesNotMatch(prompts[2], /user change/, 'user changes from before the run are not part of it');

    await writeFile(join(repo, 'code.txt'), 'edited later\n');
    const diff = await manager.diff('task', 'run');
    assert.equal(diff.available, true); assert.deepEqual(diff.files.map(file => file.path), ['code.txt']);
    assert.match(diff.files[0].patch, /\+new/); assert.doesNotMatch(diff.files[0].patch, /edited later/);
    const worker = await manager.diff('task', 'worker', 'w1');
    assert.deepEqual(worker.files.map(file => file.path), ['code.txt']);
    const initial = await manager.diff('task', 'initial');
    assert.deepEqual(initial.files.map(file => file.path), ['user.txt']);
    await assert.rejects(manager.diff('task', 'other'), /область/);
    await assert.rejects(manager.diff('task', 'worker', 'w9'), /не найден/);
    await manager.shutdown();
  });
});
