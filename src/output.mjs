const outputLimit = 256 * 1024, headSize = 64 * 1024, omission = '\n\n[… середина вывода не сохранена …]\n\n';
// Builds report the error at the end of a long log, so a bounded log keeps its start and its latest output.
// Two buffers may share a target, so the position comes from the target rather than from this closure.
function appendBounded(target, text) {
  if (!target.outputTruncated && target.output.length + text.length <= outputLimit) { target.output += text; return; }
  const start = target.outputTruncated ? target.output.slice(0, headSize) : (target.output + text).slice(0, headSize);
  const rest = target.outputTruncated ? target.output.slice(headSize + omission.length) + text : (target.output + text).slice(headSize);
  target.output = start + omission + rest.slice(-(outputLimit - headSize - omission.length));
  target.outputTruncated = true;
}

export function outputBuffer(target, secrets = [], changed = () => {}) {
  const values = [...new Set(secrets.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  let tail = '';
  return (value, final = false) => {
    let safe = tail + value; tail = '';
    for (const secret of values) safe = safe.split(secret).join('[скрыто]');
    if (!final) {
      let overlap = 0;
      for (const secret of values) for (let size = 1; size < secret.length && size <= safe.length; size++) {
        if (safe.endsWith(secret.slice(0, size))) overlap = Math.max(overlap, size);
      }
      if (overlap) { tail = safe.slice(-overlap); safe = safe.slice(0, -overlap); }
    }
    appendBounded(target, safe);
    changed();
  };
}

export function environmentSecrets(environment) {
  return Object.entries(environment).filter(([key, value]) => /TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|CUSTOM_HEADERS/i.test(key) && typeof value === 'string' && value).map(([, value]) => value);
}
