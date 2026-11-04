import { spawn } from 'node:child_process';
import { validSessionId } from './claude.mjs';

export function codexArgs({ model = '', resumeSessionId, schemaPath, readOnly = false } = {}) {
  if (resumeSessionId !== undefined && !validSessionId(resumeSessionId)) throw new Error('Invalid session ID');
  const args = ['-a', 'never', 'exec', '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
  if (resumeSessionId) args.push('resume', resumeSessionId);
  args.push('--json');
  if (!resumeSessionId) args.push('--color', 'never');
  if (model) args.push('--model', model);
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (readOnly) args.push('--ephemeral');
  args.push('-');
  return args;
}
export function launchCodex({ cwd, environment, prompt, ...options }) {
  const child = spawn(process.platform === 'win32' ? 'codex.exe' : 'codex', codexArgs(options), {
    cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
  });
  child.stdin.on('error', () => {}); child.stdin.end(prompt); return child;
}

export function codexStream(onOutput) {
  let pending = '', invalid = false, failed = false, completed = 0, sessionId, finalText = '';
  function line(value) {
    if (!value.trim()) return;
    let event;
    try { event = JSON.parse(value); } catch { invalid = true; return; }
    if (!event || typeof event.type !== 'string') { invalid = true; return; }
    if (event.type === 'thread.started') {
      if (!validSessionId(event.thread_id) || (sessionId && sessionId !== event.thread_id)) invalid = true;
      else sessionId = event.thread_id;
    }
    if (event.type === 'error' || event.type === 'turn.failed') failed = true;
    if (event.type === 'turn.completed') completed++;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text !== 'string' || event.item.text.length > 256 * 1024) invalid = true;
      else { finalText = event.item.text; onOutput(finalText + '\n'); }
    }
    if (event.type === 'item.started' && event.item?.type && event.item.type !== 'agent_message') onOutput(`[Инструмент: ${event.item.type}]\n`);
  }
  return {
    push(chunk) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        if (end > 1024 * 1024) invalid = true; else line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 1024 * 1024) { invalid = true; pending = ''; }
    },
    finish(code) {
      if (pending) { line(pending); pending = ''; }
      return code === 0 && !invalid && !failed && completed === 1 && sessionId && finalText.trim() ? 'выполнение завершено' : 'ошибка';
    },
    sessionId() { return !invalid && !failed ? sessionId : undefined; },
    finalText() { return finalText; }
  };
}
