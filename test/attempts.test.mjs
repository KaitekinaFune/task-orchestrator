import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createAttempts } from '../src/attempts.mjs';
import { claudeStream, stopTree, claudeArgs, permissionDenials } from '../src/claude.mjs';
import { validateChecks } from '../src/checks.mjs';
import { outputBuffer } from '../src/output.mjs';

const result = (extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...extra }) + '\n';
function harness({ script = `process.stdout.write(${JSON.stringify(result())})`, capture, timeoutMs, mutateFailure = false, checks = [], checkLaunch, checksEnvironment, workflow } = {}) {
  let state = { projects: [{ id: 'project', path: process.cwd(), checks }], tasks: [{ id: 'task', projectId: 'project', profile: 'subscription', title: 'task', description: 'description', criteria: 'criteria', ...(workflow ? { workflow } : {}) }], profiles: {}, attempts: [] };
  let launches = 0, saves = 0;
  const launchInputs = [];
  const manager = createAttempts({
    getState: () => state,
    mutate: async fn => { saves++; if (mutateFailure === true || (typeof mutateFailure === 'number' && saves >= mutateFailure)) throw new Error('disk'); const next = structuredClone(state); fn(next); state = next; },
    environmentFor: async () => ({ environment: { ...process.env }, secrets: ['test-secret-value'] }),
    capture: capture || (async () => ({ path: process.cwd(), fingerprint: 'same', clean: false, changes: [] })),
    launch: ({ cwd, environment, prompt, resumeSessionId, allowedTools }) => {
      launchInputs.push({ prompt, resumeSessionId, allowedTools });
      launches++; assert.match(prompt, /criteria/); assert.equal(cwd, process.cwd());
      const child = spawn(process.execPath, ['-e', script], { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      child.stdin.on('error', () => {}); child.stdin.end(prompt); return child;
    }, stop: stopTree, timeoutMs, checkLaunch, checksEnvironment
  });
  return { manager, launchInputs, get state() { return state; }, get launches() { return launches; }, get saves() { return saves; } };
}
async function finished(manager) {
  for (let i = 0; i < 200; i++) {
    const records = manager.list('task'); const last = records.at(-1);
    if (last && !last.active && last.endedAt && last.attribution) return last;
    await delay(20);
  }
  throw new Error('Attempt did not finish');
}
const check = (id, script, timeoutSeconds = 5) => ({ id, name: id, executable: process.execPath, args: ['-e', script], timeoutSeconds });

test('single-agent mode skips configured checks and records explicit omission of review', async () => {
  const h = harness({ workflow: { mode: 'quick', checkIds: [] }, checks: [check('must-not-run', 'process.exit(99)')] });
  const preview = await h.manager.prepare('task');
  assert.deepEqual(preview.checks, []); assert.equal(preview.review, 'не запрошено');
  // Unrelated project checks do not invalidate a single-agent preview.
  h.state.projects[0].checks[0].args = ['--version'];
  await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager);
    assert.equal(attempt.workflow.mode, 'quick'); assert.equal(attempt.checks, 'не запрошены');
    assert.equal(attempt.review, 'не запрошено'); assert.equal(attempt.checkRuns.length, 0);
    assert.equal(attempt.status, 'выполнение завершено'); assert.equal(h.launches, 1);
  } finally { await h.manager.shutdown(); }
});

test('checked mode executes only the chosen compilation check and leaves review unrequested', async () => {
  const checks = [check('expensive', 'process.exit(99)'), check('compile', 'console.log("COMPILE_OK")')];
  const h = harness({ workflow: { mode: 'checked', checkIds: ['compile'] }, checks });
  const preview = await h.manager.prepare('task'); assert.deepEqual(preview.checks.map(c => c.id), ['compile']);
  await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager);
    assert.equal(attempt.checkRuns[0].results.length, 1); assert.equal(attempt.checkRuns[0].results[0].definition.id, 'compile');
    assert.equal(attempt.checks, 'пройдены'); assert.equal(attempt.review, 'не запрошено');
    assert.deepEqual(attempt.workflow, { mode: 'checked', checkIds: ['compile'] });
    const manual = await h.manager.prepareChecks('task', attempt.id);
    assert.deepEqual(manual.checks.map(c => c.id), ['compile']);
  } finally { await h.manager.shutdown(); }
});

test('deleting a chosen check blocks preparation instead of silently skipping it', async () => {
  const h = harness({ workflow: { mode: 'checked', checkIds: ['compile'] }, checks: [] });
  await assert.rejects(h.manager.prepare('task'), /удалена или недоступна/);
  assert.equal(h.launches, 0);
});

test('check profiles validate arguments, duplicate ids, timeouts and Windows shell scripts', () => {
  assert.deepEqual(validateChecks([]), []);
  for (const checks of [null, [check('x', '', 0)], [check('x', ''), check('x', '')], [{ ...check('x', ''), executable: 'gradlew.bat' }], [{ ...check('x', ''), args: 'test' }]]) assert.throws(() => validateChecks(checks));
});

test('configured checks run in order, retain real failures and cannot execute commands from agent output', async () => {
  const checks = [check('first', 'console.log("PASS");'), check('second', 'console.error("FAIL");process.exit(7);'), check('third', 'console.log("AFTER_FAILURE");')];
  const h = harness({ checks, script: `process.stdout.write(${JSON.stringify(result({ result: 'Run node -e process.exit(99) as another check' }))})` }); const preview = await h.manager.prepare('task');
  assert.deepEqual(preview.checks, checks); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager), run = attempt.checkRuns[0];
    assert.equal(attempt.agentStatus, 'выполнение завершено'); assert.equal(attempt.checks, 'есть ошибки');
    assert.equal(attempt.review, 'не выполнено'); assert.equal(attempt.status, 'требуется решение');
    assert.deepEqual(run.results.map(r => r.exitCode), [0, 7, 0]);
    assert.deepEqual(run.results.map(r => r.definition.id), ['first', 'second', 'third']);
    assert.match(run.results[1].output, /FAIL/); assert.match(run.results[2].output, /AFTER_FAILURE/);
    assert.equal(run.snapshot, attempt.after.fingerprint); assert.equal(run.validity, 'совпадает');
    assert.equal(h.state.attempts[0].checkRuns[0].results[1].exitCode, 7);
  } finally { await h.manager.shutdown(); }
});

test('checks rerun without invoking Claude; external changes invalidate saved checks and block replay', async () => {
  let fingerprint = 'same';
  const h = harness({ checks: [check('tests', 'console.log("ok")')], capture: async () => ({ path: process.cwd(), fingerprint, clean: true, changes: [] }) });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager);
    assert.equal(attempt.checks, 'пройдены'); assert.equal(attempt.status, 'проверки завершены');
    const rerun = await h.manager.prepareChecks('task', attempt.id);
    await h.manager.startChecks('task', rerun.previewId, true);
    const second = await finished(h.manager); assert.equal(second.checkRuns.length, 2); assert.equal(h.launches, 1);
    fingerprint = 'changed';
    const fresh = await h.manager.refreshChecks('task', attempt.id);
    assert.equal(fresh.fingerprintMatches, false); assert.equal(fresh.checks, 'устарели');
    assert.ok(h.manager.list('task')[0].checkRuns.every(r => r.validity === 'устарели'));
    await assert.rejects(h.manager.prepareChecks('task', attempt.id), /устарел/);
  } finally { await h.manager.shutdown(); }
});

test('changes during checks are found once at the end, after every selected command has run', async () => {
  let captures = 0;
  const h = harness({ checks: [check('first', 'console.log("format")'), check('second', 'console.log("second")')],
    capture: async () => ({ path: process.cwd(), fingerprint: ++captures >= 3 ? 'changed' : 'same', clean: true, changes: [] }) });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager), run = attempt.checkRuns[0];
    assert.equal(attempt.checks, 'устарели'); assert.equal(run.validity, 'устарели');
    assert.equal(run.results[0].exitCode, 0); assert.equal(run.results[1].exitCode, 0);
    assert.equal(captures, 3);
  } finally { await h.manager.shutdown(); }
});

test('missing executable and check timeout are recorded with no fabricated exit code', async () => {
  const h = harness({ checks: [{ ...check('missing', ''), executable: 'orchestrator-missing-executable-99482' }, check('timeout', 'setInterval(()=>{},1000)', 1), check('never', 'console.log("never")')] });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager), run = attempt.checkRuns[0];
    assert.equal(run.results[0].status, 'ошибка запуска'); assert.equal(run.results[0].exitCode, null);
    assert.equal(run.results[1].status, 'таймаут'); assert.equal(run.results[2].status, 'не выполнена');
    assert.equal(attempt.status, 'прервана'); assert.equal(attempt.checks, 'прерваны');
  } finally { await h.manager.shutdown(); }
});

test('failed agents do not start checks and commands changed after preview are rejected', async () => {
  const h = harness({ checks: [check('never', 'console.log("never")')], script: `process.stdout.write(${JSON.stringify(result({ is_error: true }))})` });
  let preview = await h.manager.prepare('task'); h.state.projects[0].checks[0].args = ['--version'];
  await assert.rejects(h.manager.start('task', preview.previewId, true), /изменились/);
  preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try { const attempt = await finished(h.manager); assert.equal(attempt.checkRuns.length, 0); assert.equal(attempt.checks, 'не выполнены'); }
  finally { await h.manager.shutdown(); }
});

test('check arguments are literal argv and check output hides inherited secrets across interleaved streams', async () => {
  const inert = '$(do-not-execute); & echo injected';
  const definition = check('literal', String.raw`process.stdout.write(process.argv[1]+'\n');process.stderr.write('test-secret-');setTimeout(()=>{process.stdout.write('other stream\n');setTimeout(()=>process.stderr.write('value\n'),20)},20)`);
  definition.args.push(inert);
  const h = harness({ checks: [definition], checksEnvironment: () => ({ ...process.env, CHECK_API_KEY: 'test-secret-value' }) });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager), output = attempt.checkRuns[0].results[0].output;
    assert.ok(output.includes(inert)); assert.match(output, /\[скрыто\]/); assert.ok(!output.includes('test-secret-value'));
  } finally { await h.manager.shutdown(); }
});

test('an explicitly configured PowerShell command preserves a native exit code', { skip: process.platform !== 'win32' }, async () => {
  const definition = { id: 'powershell', name: 'PowerShell wrapper', executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(9)'; exit $LASTEXITCODE`], timeoutSeconds: 10 };
  const h = harness({ checks: [definition] });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try { const attempt = await finished(h.manager); assert.equal(attempt.checkRuns[0].results[0].exitCode, 9); assert.equal(attempt.checks, 'есть ошибки'); }
  finally { await h.manager.shutdown(); }
});

test('cancelling a check kills its descendants, retains the writer lock and skips later commands', async () => {
  const script = String.raw`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true});console.log('PID:'+child.pid);setInterval(()=>{},1000)`;
  const h = harness({ checks: [check('long', script), check('never', 'console.log("never")')] });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    let pid;
    for (let i = 0; i < 100; i++) { pid = h.manager.list('task')[0].checkRuns[0]?.results[0].output.match(/PID:(\d+)/)?.[1]; if (pid) break; await delay(20); }
    assert.ok(pid); await assert.rejects(h.manager.prepare('task'), /активная попытка/);
    await h.manager.cancel('task'); const attempt = await finished(h.manager);
    assert.equal(attempt.status, 'отменена'); assert.equal(attempt.checks, 'прерваны');
    assert.equal(attempt.checkRuns[0].results[0].status, 'отменена'); assert.equal(attempt.checkRuns[0].results[1].status, 'не выполнена');
    assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
  } finally { await h.manager.shutdown(); }
});

test('a snapshot failure after exit 0 never makes a check successful for the current files', async () => {
  let captures = 0;
  const h = harness({ checks: [check('test', 'console.log("ok")')], capture: async () => {
    if (++captures === 3) throw Object.assign(new Error('private stderr'), { code: 'EACCES' });
    return { path: process.cwd(), fingerprint: 'same', clean: true, changes: [] };
  } });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager), run = attempt.checkRuns[0];
    assert.equal(run.results[0].exitCode, 0); assert.equal(run.status, 'непроверены');
    assert.equal(run.validity, 'не проверена'); assert.equal(attempt.checks, 'непроверены');
  } finally { await h.manager.shutdown(); }
});

test('failed freshness comparison removes the successful current-state claim', async () => {
  let inaccessible = false;
  const h = harness({ checks: [check('test', '')], capture: async () => {
    if (inaccessible) throw Object.assign(new Error('hidden output'), { code: 'EACCES' });
    return { path: process.cwd(), fingerprint: 'same', clean: true, changes: [] };
  } });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager); assert.equal(attempt.checks, 'пройдены'); inaccessible = true;
    const state = await h.manager.refreshChecks('task', attempt.id);
    assert.equal(state.fingerprintMatches, null); assert.equal(state.checks, 'непроверены');
    assert.equal(h.manager.list('task')[0].checkRuns[0].validity, 'не проверена');
    assert.equal(h.manager.list('task')[0].checkRuns[0].results[0].exitCode, 0);
  } finally { await h.manager.shutdown(); }
});

test('editing project commands during Claude execution does not change the confirmed commands', async () => {
  const h = harness({ checks: [check('original', 'console.log("ORIGINAL")')], script: `setTimeout(()=>process.stdout.write(${JSON.stringify(result())}),100)` });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  h.state.projects[0].checks = [check('replacement', 'console.log("REPLACEMENT")')];
  try {
    const attempt = await finished(h.manager);
    assert.equal(attempt.checkRuns[0].results[0].definition.id, 'original');
    assert.match(attempt.checkRuns[0].results[0].output, /ORIGINAL/);
  } finally { await h.manager.shutdown(); }
});

test('changed files and changed check definitions invalidate a manual check preview', async () => {
  let fingerprint = 'same';
  const h = harness({ checks: [check('test', '')], capture: async () => ({ path: process.cwd(), fingerprint, clean: true, changes: [] }) });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager);
    const manual = await h.manager.prepareChecks('task', attempt.id); fingerprint = 'changed';
    await assert.rejects(h.manager.startChecks('task', manual.previewId, true), /Файлы изменились/);
    fingerprint = 'same'; const manual2 = await h.manager.prepareChecks('task', attempt.id);
    h.state.projects[0].checks[0].args = ['--version'];
    await assert.rejects(h.manager.startChecks('task', manual2.previewId, true), /Команды проверок изменились/);
    assert.equal(h.manager.list('task')[0].checkRuns.length, 1);
  } finally { await h.manager.shutdown(); }
});

test('stream parsing fails closed on missing, malformed or unsuccessful results and detects permissions', () => {
  for (const [input, code, expected] of [
    [result(), 0, 'выполнение завершено'], [result(), 1, 'ошибка'], ['', 0, 'ошибка'],
    ['not json\n' + result(), 0, 'ошибка'], [result({ is_error: 'false' }), 0, 'ошибка'],
    [result({ subtype: 'unknown' }), 0, 'ошибка'], [result({ permission_denials: [{}] }), 0, 'требуется решение'],
    [result({ is_error: true }), 0, 'ошибка'], [result({ permission_denials: {} }), 0, 'ошибка']
  ]) {
    const parser = claudeStream(() => {});
    for (let i = 0; i < input.length; i += 3) parser.push(input.slice(i, i + 3));
    assert.equal(parser.finish(code), expected);
  }
  const args = profile => claudeArgs({ profile });
  assert.ok(args('subscription').includes('auto')); assert.ok(args('litellm').includes('auto')); assert.ok(args('deepseek').includes('acceptEdits'));
  for (const profile of ['subscription', 'litellm', 'deepseek']) assert.ok(!args(profile).some(a => /bypass|dangerously/.test(a)));
});

test('denials become exact rules, and a redacted, multi-line, variable-using or file-edit action gets none', () => {
  const denials = permissionDenials([
    { tool_name: 'PowerShell', tool_input: { command: 'glab mr view C:\\x' } },
    { tool_name: 'PowerShell', tool_input: { command: 'glab mr view C:\\x' } },
    { tool_name: 'PowerShell', tool_input: { command: 'python "$HOME/gl_get.py" merge_requests/1' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Write-Output (1+1)' } },
    { tool_name: 'Bash', tool_input: { command: 'curl -H "token: s3cret"' } },
    { tool_name: 'Bash', tool_input: { command: 'one\ntwo' } },
    { tool_name: 'Edit', tool_input: { file_path: 'C:/outside.txt' } },
    { tool_name: 'WebFetch', tool_input: { url: 'https://gitlab.example/a?b=1' } },
    { tool_name: 'bad name; --flag' }, {}
  ], ['s3cret']);
  assert.deepEqual(denials.map(d => d.rule), ['PowerShell(glab mr view C:\\\\x)', null, null, null, null, null, 'WebFetch(domain:gitlab.example)', null, null]);
  assert.equal(denials[3].detail, 'curl -H "token: [скрыто]"');
  assert.deepEqual(claudeArgs({ profile: 'subscription', allowedTools: ['Bash(git status)'], resumeSessionId: 'id' }).slice(-4), ['--allowedTools', 'Bash(git status)', '--resume', 'id']);
});

test('a task with a running attempt is held from deletion, and forgetting removes its in-memory attempts', async () => {
  const h = harness({ script: `setTimeout(()=>process.stdout.write(${JSON.stringify(result())}),150)`, workflow: { mode: 'quick', checkIds: [] } });
  try {
    await h.manager.start('task', (await h.manager.prepare('task')).previewId, true);
    assert.equal(h.manager.holds(['task']), true); assert.equal(h.manager.holds(['other']), false);
    await finished(h.manager);
    assert.equal(h.manager.holds(['task']), false);
    h.state.attempts = []; h.manager.forget(['task']);
    assert.deepEqual(h.manager.list('task'), []);
  } finally { await h.manager.shutdown(); }
});

test('allowing denials resumes the same session with rules taken from the stored attempt only', async () => {
  const id = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  const denied = result({ session_id: id, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git fetch' } }] });
  const h = harness({ script: `process.stdout.write(${JSON.stringify(denied)})`, workflow: { mode: 'quick', checkIds: [] } });
  try {
    await assert.rejects(h.manager.prepare('task', undefined, true), /только при продолжении/);
    await h.manager.start('task', (await h.manager.prepare('task')).previewId, true);
    const first = await finished(h.manager);
    assert.equal(first.status, 'требуется решение'); assert.equal(first.permissionDenials[0].rule, 'Bash(git fetch)');
    const plain = await h.manager.prepare('task', 'continue with criteria');
    assert.equal(plain.allowedTools, undefined); assert.ok(!plain.command.includes('--allowedTools'));
    const preview = await h.manager.prepare('task', 'continue with criteria', true);
    assert.deepEqual(preview.allowedTools, ['Bash(git fetch)']); assert.ok(preview.command.includes('Bash(git fetch)'));
    await h.manager.start('task', preview.previewId, true);
    await delay(50);
    for (let i = 0; i < 200 && h.manager.list('task').length < 2 || !h.manager.list('task').at(-1).endedAt; i++) await delay(20);
    assert.deepEqual(h.launchInputs.at(-1).allowedTools, ['Bash(git fetch)']); assert.equal(h.launchInputs.at(-1).resumeSessionId, id);
    assert.deepEqual(h.manager.list('task').at(-1).allowedTools, ['Bash(git fetch)']);
    // The fake CLI denies again: a second click must not pretend to change anything.
    await assert.rejects(h.manager.prepare('task', 'continue with criteria', true), /несмотря на выданное разрешение/);
    assert.deepEqual((await h.manager.prepare('task', 'continue with criteria')).allowedTools, ['Bash(git fetch)']);
  } finally { await h.manager.shutdown(); }
});

test('launch persists baseline, streams output, redacts a key split across chunks and records an unverified result', async () => {
  const h = harness({ script: String.raw`process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}]}})+'\n');process.stderr.write('test-secret-');setTimeout(()=>{process.stderr.write('value\n');process.stdout.write(${JSON.stringify(result())});},100)` });
  const preview = await h.manager.prepare('task');
  const started = await h.manager.start('task', preview.previewId, true);
  assert.equal(started.status, 'выполнение');
  assert.equal(h.state.attempts.length, 1);
  const attempt = await finished(h.manager); await h.manager.shutdown();
  assert.match(attempt.output, /working/); assert.match(attempt.diagnostics.output, /\[скрыто\]/);
  assert.ok(!attempt.output.includes('[скрыто]'));
  assert.ok(!JSON.stringify(h.state).includes('test-secret-value'));
  assert.equal(attempt.status, 'выполнение завершено'); assert.equal(attempt.exitCode, 0);
  assert.equal(attempt.checks, 'не настроены'); assert.equal(attempt.review, 'не выполнено');
  assert.equal(attempt.baseline.fingerprint, 'same'); assert.equal(attempt.after.fingerprint, 'same');
  assert.match(attempt.attribution, /отделить/); assert.ok(h.state.attempts[0].endedAt);
});

test('moved HEAD, changed configuration and absent confirmation prevent launching; a file saved after preview does not', async () => {
  let fingerprint = 'before', head = 'a'; const h = harness({ capture: async () => ({ path: process.cwd(), fingerprint, head, branch: 'main', clean: false, changes: [] }) });
  let preview = await h.manager.prepare('task');
  assert.equal(preview.autoStart, false);
  await assert.rejects(h.manager.start('task', preview.previewId, false), /Подтвердите/);
  head = 'b'; await assert.rejects(h.manager.start('task', preview.previewId, true), /Ветка или HEAD/);
  head = 'a'; preview = await h.manager.prepare('task'); h.state.profiles.changed = true;
  await assert.rejects(h.manager.start('task', preview.previewId, true), /профиль изменились/);
  assert.equal(h.launches, 0);
  preview = await h.manager.prepare('task'); fingerprint = 'after';
  await h.manager.start('task', preview.previewId, true);
  try { assert.equal((await finished(h.manager)).baseline.fingerprint, 'after'); assert.equal(h.launches, 1); }
  finally { await h.manager.shutdown(); }
});

test('confirmation is skipped for a clean checkout and for the previous turn\'s own result, without hashing twice', async () => {
  const id = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  let fingerprint = 'one', clean = true, captures = 0;
  const h = harness({ script: `process.stdout.write(${JSON.stringify(result({ session_id: id }))})`, workflow: { mode: 'quick', checkIds: [] },
    capture: async () => { captures++; return { path: process.cwd(), fingerprint, clean, changes: [] }; } });
  try {
    const first = await h.manager.prepare('task'); assert.equal(first.autoStart, true);
    await h.manager.start('task', first.previewId, true); assert.equal(captures, 1);
    await finished(h.manager); assert.equal(captures, 2);
    clean = false;
    assert.equal((await h.manager.prepare('task', 'more criteria')).autoStart, true, 'Agent changes are not the user\'s changes');
    assert.equal((await h.manager.prepare('task')).autoStart, false, 'A new run does not continue that result');
    fingerprint = 'edited by user';
    assert.equal((await h.manager.prepare('task', 'more criteria')).autoStart, false);
  } finally { await h.manager.shutdown(); }
});

test('preparation errors identify Git stage and access errors without exposing raw process output', async () => {
  const h = harness({ capture: async () => { throw Object.assign(new Error('sensitive stdout and credential value'), { code: 'EACCES' }); } });
  await assert.rejects(h.manager.prepare('task'), error => {
    assert.match(error.message, /Git-состояние/); assert.match(error.message, /EACCES/);
    assert.ok(!error.message.includes('sensitive')); assert.ok(!error.message.includes('credential value'));
    return true;
  });
  const old = harness(); delete old.state.tasks[0].profile;
  await assert.rejects(old.manager.prepare('task'), /исполнителя, профиль/);
});

test('one active writer, cancellation and timeout terminate the child before releasing the lock', async () => {
  const h = harness({ script: 'setInterval(()=>{},1000)' });
  const preview = await h.manager.prepare('task');
  await h.manager.start('task', preview.previewId, true);
  try {
    await assert.rejects(h.manager.start('task', preview.previewId, true), /активная попытка/);
    await h.manager.cancel('task');
    const attempt = await finished(h.manager); assert.equal(attempt.status, 'отменена');
  } finally { await h.manager.shutdown(); }
  const timed = harness({ script: 'setInterval(()=>{},1000)', timeoutMs: 100 });
  const timedPreview = await timed.manager.prepare('task'); await timed.manager.start('task', timedPreview.previewId, true);
  try { const attempt = await finished(timed.manager); assert.equal(attempt.status, 'прервана'); assert.ok(attempt.events.some(e => e.message.includes('таймаут'))); }
  finally { await timed.manager.shutdown(); }
});

test('a failed initial save never launches the CLI', async () => {
  const h = harness({ mutateFailure: true }); const preview = await h.manager.prepare('task');
  await assert.rejects(h.manager.start('task', preview.previewId, true), /сохранить попытку перед запуском/); assert.equal(h.launches, 0);
});

test('a storage failure during streaming stops the process and blocks subsequent launches', async () => {
  const h = harness({ script: String.raw`setInterval(()=>process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}]}})+'\n'),50)`, mutateFailure: 2 });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    const attempt = await finished(h.manager); assert.equal(attempt.status, 'ошибка');
    await assert.rejects(h.manager.prepare('task'), /перезапуска/);
  } finally { await h.manager.shutdown(); }
});

test('cancellation terminates descendant processes as well as the CLI process', async () => {
  const h = harness({ script: String.raw`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true});process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'PID:'+child.pid}]}})+'\n');setInterval(()=>{},1000);` });
  const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
  try {
    let pid;
    for (let i = 0; i < 100; i++) { pid = h.manager.list('task')[0].output.match(/PID:(\d+)/)?.[1]; if (pid) break; await delay(20); }
    assert.ok(pid, 'Descendant PID not received');
    await h.manager.cancel('task'); await finished(h.manager);
    assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
  } finally { await h.manager.shutdown(); }
});

test('large output is bounded without hiding permission denials', async () => {
  // Pass a small program to Windows CreateProcess; generate the payload in the child.
  const bounded = harness({ script: String.raw`process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'a'.repeat(300000)}]}})+'\n');process.stdout.write(${JSON.stringify(result({ permission_denials: [{}] }))});` });
  const preview = await bounded.manager.prepare('task'); await bounded.manager.start('task', preview.previewId, true);
  try { const attempt = await finished(bounded.manager); assert.equal(attempt.output.length, 256 * 1024); assert.equal(attempt.outputTruncated, true); assert.equal(attempt.status, 'требуется решение'); }
  finally { await bounded.manager.shutdown(); }
});

test('a long log keeps its start and its end, including across stdout and stderr', () => {
  const target = { output: '', outputTruncated: false }, stdout = outputBuffer(target), stderr = outputBuffer(target);
  stdout('START'); stderr('x'.repeat(400 * 1024)); stdout('middle-of-the-tail'); stderr('REAL_ERROR'); stdout('', true);
  assert.equal(target.outputTruncated, true); assert.equal(target.output.length, 256 * 1024);
  assert.ok(target.output.startsWith('START')); assert.ok(target.output.endsWith('middle-of-the-tailREAL_ERROR')); assert.match(target.output, /середина вывода не сохранена/);
  const short = { output: '', outputTruncated: false }; outputBuffer(short)('all of it', true);
  assert.deepEqual(short, { output: 'all of it', outputTruncated: false });
});

test('a failed continuation keeps the session it resumed, and a stopped first turn keeps the one it started', async () => {
  const sessionId = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  // The continuation dies without reporting anything, as a CLI hitting a limit or a network failure may.
  const failing = harness({ workflow: { mode: 'quick', checkIds: [] }, script: `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(s.includes('next turn'))process.exit(1);process.stdout.write(${JSON.stringify(result({ session_id: sessionId }))})})` });
  try {
    let preview = await failing.manager.prepare('task'); await failing.manager.start('task', preview.previewId, true);
    await finished(failing.manager);
    preview = await failing.manager.prepare('task', 'next turn');
    await failing.manager.start('task', preview.previewId, true);
    const second = await finished(failing.manager); assert.equal(second.status, 'ошибка'); assert.equal(second.sessionId, sessionId);
    assert.equal((await failing.manager.prepare('task', 'again')).parentAttemptId, second.id);
  } finally { await failing.manager.shutdown(); }
  // The cut-off last line makes the stream invalid; the complete init event before it still names the session.
  const partial = [{ type: 'system', subtype: 'init', session_id: sessionId }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } }].map(event => JSON.stringify(event)).join('\n') + '\n{"type":"assist';
  const stopped = harness({ workflow: { mode: 'quick', checkIds: [] }, script: `process.stdout.write(${JSON.stringify(partial)});setInterval(()=>{},1000)` });
  try {
    const preview = await stopped.manager.prepare('task'); await stopped.manager.start('task', preview.previewId, true);
    for (let i = 0; i < 200 && !stopped.manager.list('task').at(-1).output; i++) await delay(20);
    await stopped.manager.cancel('task');
    const attempt = await finished(stopped.manager); assert.equal(attempt.status, 'отменена'); assert.equal(attempt.sessionId, sessionId);
    assert.equal((await stopped.manager.prepare('task', 'продолжай')).resumeSessionId, sessionId);
  } finally { await stopped.manager.shutdown(); }
});

test('follow-up resumes the exact latest session with preserved history and a fresh preview', async () => {
  const sessionId = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  const h = harness({ workflow: { mode: 'quick', checkIds: [] }, script: `process.stdout.write(${JSON.stringify(result({ session_id: sessionId }))})` });
  try {
    await assert.rejects(h.manager.prepare('task', 'criteria follow-up'), /нет доступной сессии/);
    let preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true);
    const first = await finished(h.manager); assert.equal(first.sessionId, sessionId);
    preview = await h.manager.prepare('task', 'criteria follow-up');
    assert.equal(preview.resumeSessionId, sessionId); assert.equal(preview.parentAttemptId, first.id);
    assert.deepEqual(preview.command.slice(-2), ['--resume', sessionId]);
    await assert.rejects(h.manager.start('task', preview.previewId, false), /Подтвердите/);
    await h.manager.start('task', preview.previewId, true);
    const second = await finished(h.manager);
    assert.equal(second.parentAttemptId, first.id); assert.equal(second.message, 'criteria follow-up');
    assert.equal(second.sessionId, sessionId); assert.equal(h.launchInputs[1].resumeSessionId, sessionId);
    assert.match(h.launchInputs[1].prompt, /criteria follow-up/);
    assert.equal(h.manager.list('task').length, 2); assert.equal(h.manager.list('task')[0].message, undefined);
    for (const value of ['', ' ', {}, 'a'.repeat(10001)]) await assert.rejects(h.manager.prepare('task', value), /Сообщение/);
    // No fallback to some earlier session after a new failed/legacy run.
    h.state.attempts.push({ id: 'newer', taskId: 'task', endedAt: new Date().toISOString(), profile: 'subscription' });
    await assert.rejects(h.manager.prepare('task', 'criteria follow-up'), /нет доступной сессии/);
  } finally { await h.manager.shutdown(); }
});

test('follow-up refuses changed task parameters after confirmation preview', async () => {
  const sessionId = 'e4a4d998-3c62-4c1f-bd0e-56661f1471ff';
  const h = harness({ workflow: { mode: 'quick', checkIds: [] }, script: `process.stdout.write(${JSON.stringify(result({ session_id: sessionId }))})` });
  try {
    const preview = await h.manager.prepare('task'); await h.manager.start('task', preview.previewId, true); await finished(h.manager);
    const next = await h.manager.prepare('task', 'criteria continuation');
    h.state.tasks[0].description = 'changed requirements';
    await assert.rejects(h.manager.start('task', next.previewId, true), /изменились/);
    assert.equal(h.launches, 1);
  } finally { await h.manager.shutdown(); }
});
