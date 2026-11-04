import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./credential.ps1', import.meta.url));
export const credentialTarget = 'TaskOrchestrator/LiteLLM';
export const deepseekCredentialTarget = 'TaskOrchestrator/DeepSeek';
export function credential(action, secret = '', target = credentialTarget) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows Credential Manager недоступен'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Action', action, '-Target', target], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 10000) child.kill(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Хранилище Windows недоступно')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(action === 'read' ? output : true); else if (code === 3 && (action === 'exists' || action === 'read')) resolve(action === 'exists' ? false : null); else reject(new Error('Ошибка хранилища Windows')); });
    child.stdin.on('error', () => {}); child.stdin.end(action === 'write' ? secret : '');
  });
}
