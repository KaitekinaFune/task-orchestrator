import { spawn } from 'node:child_process';
import { RequestError } from './errors.mjs';

export function validateChecks(input) {
  if (!Array.isArray(input) || input.length > 12) throw new RequestError('Укажите список не более 12 проверок', 400);
  const ids = new Set();
  return input.map(value => {
    const string = (text, max) => typeof text === 'string' && text.trim() && text.length <= max && !/[\r\n\0]/.test(text);
    if (!value || Object.keys(value).some(k => !['id', 'name', 'executable', 'args', 'timeoutSeconds'].includes(k)) ||
      !string(value.id, 80) || ids.has(value.id) || !string(value.name, 160) || !string(value.executable, 4096) ||
      !Array.isArray(value.args) || value.args.length > 100 || value.args.some(a => typeof a !== 'string' || a.length > 8192 || /[\r\n\0]/.test(a)) ||
      !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 3600) {
      throw new RequestError('Проверьте id, название, executable, массив args и timeoutSeconds (1–3600) каждой проверки', 400);
    }
    if (/\.(cmd|bat)$/i.test(value.executable.trim())) throw new RequestError('Для .cmd/.bat укажите powershell.exe и явные аргументы запуска скрипта. Автоматический shell не используется.', 400);
    ids.add(value.id);
    return { id: value.id, name: value.name.trim(), executable: value.executable.trim(), args: [...value.args], timeoutSeconds: value.timeoutSeconds };
  });
}

export function launchCheck({ definition, cwd, environment }) {
  return spawn(definition.executable, definition.args, { cwd, env: environment, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
}

// No shell interpolation: executable and argv come only from saved user profiles.
export function executeProcess({ launch, running, onStdout, onStderr, timeoutMs, onTimeout }) {
  return new Promise(resolve => {
    let child;
    try { child = launch(); }
    catch { resolve({ code: null, signal: null, spawnError: true }); return; }
    running.children.add(child);
    let spawnError = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
    child.on('error', () => { spawnError = true; });
    const timer = setTimeout(onTimeout, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer); running.children.delete(child);
      resolve({ code: spawnError ? null : code, signal, spawnError });
    });
  });
}
