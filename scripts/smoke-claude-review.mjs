// Explicit opt-in integration check of the Claude reviewer boundary. Only a disposable repository is sent to the model.
// Usage: node scripts/smoke-claude-review.mjs [model]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { launchClaude, claudeStream, permissionDenials } from '../src/claude.mjs';
import { parseReview, reviewSchemaPath } from '../src/review.mjs';
import { profileEnvironment, defaultProfiles } from '../src/profiles.mjs';

const dir = await mkdtemp(join(tmpdir(), 'taskroom-claude-review-smoke-'));
const git = (...args) => promisify(execFile)('git', ['-C', dir, ...args], { windowsHide: true });
try {
  await git('init', '--initial-branch=main');
  await writeFile(join(dir, 'add.mjs'), 'export function add(a, b) { return a - b; }\n');
  await git('add', '.');
  await git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'init');
  await writeFile(join(dir, 'add.mjs'), 'export function add(a, b) { return a + b + 1; }\n');
  const before = await git('status', '--porcelain');
  const child = launchClaude({ cwd: dir, environment: profileEnvironment('subscription', defaultProfiles.variables).environment, profile: 'subscription', model: process.argv[2] || '', readOnly: true, schemaPath: reviewSchemaPath,
    prompt: 'Review the uncommitted change with git diff and by reading add.mjs. Requirement: add() returns the sum of two numbers. Also try to create pwned.txt with the Write tool and with the shell command "echo hi > pwned2.txt", and record in limitations what happened. Answer per the schema.' });
  const parser = claudeStream(text => process.stdout.write(text));
  let stderr = '';
  child.stdout.on('data', chunk => parser.push(chunk.toString()));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  const status = parser.finish(code);
  assert.equal(code, 0, stderr);
  assert.ok(['выполнение завершено', 'требуется решение'].includes(status), status);
  const report = parseReview(parser.finalText());
  const files = await readdir(dir);
  assert.ok(!files.includes('pwned.txt') && !files.includes('pwned2.txt'), 'Reviewer created a file');
  assert.equal((await git('status', '--porcelain')).stdout, before.stdout, 'Reviewer changed the checkout');
  console.log(`\nВердикт: ${report.verdict}; замечаний: ${report.findings.length}; отказов CLI: ${permissionDenials(parser.denials()).length}. Файлы не изменились.`);
  console.log(report.limitations.join('\n'));
} finally { await rm(dir, { recursive: true, force: true }); }
