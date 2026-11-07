import { spawn } from 'node:child_process';
import { validSessionId } from './claude.mjs';

export function codexArgs({ model = '', resumeSessionId, schemaPath, readOnly = false, images = [] } = {}) {
  if (resumeSessionId !== undefined && !validSessionId(resumeSessionId)) throw new Error('Invalid session ID');
  // The CLI splits this flag's value at commas, so such a path would silently name different files.
  if (images.some(image => image.path.includes(','))) throw new Error('Image path contains a comma');
  const args = ['-a', 'never', 'exec', '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
  if (resumeSessionId) args.push('resume', resumeSessionId);
  args.push('--json');
  if (!resumeSessionId) args.push('--color', 'never');
  if (model) args.push('--model', model);
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (readOnly) args.push('--ephemeral');
  // In one argument: the flag takes several values and would otherwise swallow the final «-».
  for (const image of images) args.push(`--image=${image.path}`);
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
  let pending = '', invalid = false, failed = false, completed = 0, sessionId, finalText = '', errorText = '', usage = null;
  function line(value) {
    if (!value.trim()) return;
    let event;
    try { event = JSON.parse(value); } catch { invalid = true; return; }
    if (!event || typeof event.type !== 'string') { invalid = true; return; }
    if (event.type === 'thread.started') {
      if (!validSessionId(event.thread_id) || (sessionId && sessionId !== event.thread_id)) invalid = true;
      else sessionId = event.thread_id;
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      failed = true;
      const message = event.message ?? event.error?.message;
      if (typeof message === 'string') errorText = message.slice(0, 2000);
    }
    if (event.type === 'turn.completed') { completed++; usage = event.usage; }
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
    finalText() { return finalText; },
    errorText() { return errorText; },
    // Input includes the cached part. Codex names neither the model nor a price here.
    usage() {
      const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
      const input = count(usage?.input_tokens), cached = Math.min(count(usage?.cached_input_tokens), input), output = count(usage?.output_tokens);
      return { models: input || output ? [{ model: '', input: input - cached, output, cacheRead: cached, cacheWrite: 0, costUsd: null }] : [], partial: false, limits: null };
    }
  };
}
