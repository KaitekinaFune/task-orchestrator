export class RequestError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

// Never forward raw child-process errors: they can contain stdout, stderr or keys.
export function stageError(stage, error) {
  if (error instanceof RequestError) return error;
  const code = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EBUSY', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code) ? ` (${error.code})` : '';
  return new RequestError(`${stage}${code}. ${code.includes('EACCES') || code.includes('EPERM') ? 'Проверьте права процесса сервера.' : 'Проверьте доступность файлов и повторите подготовку.'}`, 400);
}
