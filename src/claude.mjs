import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

// Auto mode is confirmed on the subscription and LiteLLM; DeepSeek may not offer its classifier.
export const claudePermissionMode = profile => profile === 'deepseek' ? 'acceptEdits' : 'auto';
export const validSessionId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
// Plan mode is the CLI's read-only boundary; a reviewer also has no tools for edits or for leaving that mode.
export function claudeArgs({ profile, model, resumeSessionId, allowedTools = [], readOnly = false, schemaPath }) {
  return ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', readOnly ? 'plan' : claudePermissionMode(profile), '--permission-prompts', 'none',
    ...(readOnly ? ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'ExitPlanMode', '--no-session-persistence'] : []),
    ...(schemaPath ? ['--json-schema', JSON.stringify(JSON.parse(readFileSync(schemaPath, 'utf8')))] : []),
    ...(allowedTools.length ? ['--allowedTools', ...allowedTools] : []), ...(model ? ['--model', model] : []), ...(resumeSessionId ? ['--resume', resumeSessionId] : [])];
}
export function launchClaude({ cwd, environment, prompt, resumeSessionId, ...options }) {
  if (resumeSessionId !== undefined && !validSessionId(resumeSessionId)) throw new Error('Invalid session ID');
  const args = claudeArgs({ ...options, resumeSessionId });
  const child = spawn(process.platform === 'win32' ? 'claude.exe' : 'claude', args, {
    cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return child;
}
export async function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); }
    catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
  } else process.kill(-child.pid, 'SIGTERM');
}

const maxDenials = 20, maxDenialText = 1000;
// Exact rules only: a grant must not widen beyond the action the user saw. Backslashes are escaped for the rule syntax.
// The CLI still denies commands with variables or subexpressions under an exact rule, so offering one would only fail again.
function denialRule(tool, input) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tool) || ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) return null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = input?.command;
    if (typeof command !== 'string' || !command.trim() || command.length > maxDenialText || /[\r\n$`()]/.test(command)) return null;
    return `${tool}(${command.replace(/\\/g, '\\\\')})`;
  }
  if (tool === 'WebFetch') {
    try { return `WebFetch(domain:${new URL(input?.url).hostname})`; } catch { return null; }
  }
  return tool;
}
// Denied input may hold a secret. A redacted command cannot match exactly, so it gets no rule.
export function permissionDenials(raw, secrets = []) {
  const values = secrets.filter(value => typeof value === 'string' && value), seen = new Set(), denials = [];
  for (const item of raw) {
    const tool = typeof item?.tool_name === 'string' ? item.tool_name : 'неизвестный инструмент';
    const input = item?.tool_input, text = typeof input?.command === 'string' ? input.command : typeof input?.url === 'string' ? input.url : input === undefined ? '' : JSON.stringify(input);
    let detail = text;
    for (const secret of values) detail = detail.split(secret).join('[скрыто]');
    const key = `${tool}\n${detail}`;
    if (seen.has(key) || denials.length >= maxDenials) continue;
    seen.add(key);
    denials.push({ tool, detail: detail.slice(0, maxDenialText), rule: detail === text ? denialRule(tool, input) : null });
  }
  return denials;
}

// Unknown events may be ignored; invalid JSON and invalid final results fail closed.
export function claudeStream(onOutput) {
  let pending = '', result = null, invalid = false, denied = false, sessionId;
  let lastAssistantText = new Set();
  function line(value) {
    if (!value.trim()) return;
    let event;
    try { event = JSON.parse(value); } catch { invalid = true; return; }
    if (!event || typeof event.type !== 'string') { invalid = true; return; }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const texts = event.message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text);
      if (texts.length && !event.parent_tool_use_id) lastAssistantText = new Set(['', '\n', '\n\n'].map(separator => texts.join(separator).trim()));
      for (const block of event.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') onOutput(block.text + '\n');
        if (block.type === 'tool_use' && typeof block.name === 'string') onOutput(`[Инструмент: ${block.name}]\n`);
      }
    }
    if (event.type === 'system' && event.subtype === 'permission_denied') { denied = true; onOutput('[CLI отказал в разрешении]\n'); }
    // A stopped turn never reaches the final result, so its session is known only from here.
    if (event.type === 'system' && event.subtype === 'init' && validSessionId(event.session_id)) sessionId = event.session_id;
    if (event.type === 'result') {
      if (result) invalid = true;
      result = event;
      sessionId = validSessionId(event.session_id) ? event.session_id : undefined;
      if (Array.isArray(event.permission_denials) && event.permission_denials.length) denied = true;
      // The final result normally repeats the last assistant message. Keep it
      // only when it provides text that has not already arrived as that message.
      if (typeof event.result === 'string' && event.result.trim() && !lastAssistantText.has(event.result.trim())) onOutput(event.result + '\n');
    }
  }
  return {
    sessionId() { return !invalid ? sessionId : undefined; },
    denials() { return Array.isArray(result?.permission_denials) ? result.permission_denials : []; },
    finalText() {
      const structured = result?.structured_output;
      return structured && typeof structured === 'object' ? JSON.stringify(structured) : typeof result?.result === 'string' ? result.result : '';
    },
    push(chunk) {
      pending += chunk;
      if (pending.length > 1024 * 1024) { invalid = true; pending = ''; return; }
      let end;
      while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
    },
    finish(code) {
      if (pending) line(pending);
      if (invalid || !result || typeof result.is_error !== 'boolean' || (result.permission_denials !== undefined && !Array.isArray(result.permission_denials))) return 'ошибка';
      if (denied) return 'требуется решение';
      return code === 0 && !result.is_error && result.subtype === 'success' ? 'выполнение завершено' : 'ошибка';
    }
  };
}
