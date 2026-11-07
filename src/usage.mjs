import { appendFile, readFile } from 'node:fs/promises';

export const spentTokens = item => item.input + item.output + item.cacheWrite;
export function mergeModels(current = [], added = []) {
  const merged = current.map(item => ({ ...item }));
  for (const item of added) {
    const known = merged.find(other => other.model === item.model);
    if (!known) { merged.push({ ...item }); continue; }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) known[field] += item[field];
    if (item.costUsd !== null) known.costUsd = (known.costUsd ?? 0) + item.costUsd;
  }
  return merged;
}

// Counters only: no prompt, answer or title gets here, so deleting a task leaves nothing of its content behind.
export function createUsageLedger(path) {
  let writes = Promise.resolve(), failed = false;
  return {
    append(entry) {
      // Accounting must never stop the work it accounts for.
      writes = writes.then(() => appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })).then(() => { failed = false; }, () => { failed = true; });
      return writes;
    },
    async read() {
      await writes;
      let text;
      try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      // A crash can leave half a line at the end; the rest of the history still counts.
      return text.split('\n').flatMap(line => { if (!line.trim()) return []; try { const entry = JSON.parse(line); return Array.isArray(entry?.models) ? [entry] : []; } catch { return []; } });
    },
    failed: () => failed
  };
}

const bucket = fields => ({ ...fields, runs: 0, partial: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });
function add(target, models, entry) {
  target.runs++; if (entry.partial) target.partial++;
  for (const item of models) {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) target[field] += item[field] || 0;
    if (typeof item.costUsd === 'number') target.costUsd = (target.costUsd ?? 0) + item.costUsd;
  }
}
const ranked = map => [...map.values()].sort((a, b) => spentTokens(b) - spentTokens(a));
const slot = (map, key, fields) => { if (!map.has(key)) map.set(key, bucket(fields)); return map.get(key); };

export function summarizeUsage(entries, { from = null, tasks = [] } = {}) {
  const since = from ? Date.parse(from) : -Infinity;
  const totals = bucket({}), agents = new Map(), models = new Map(), roles = new Map(), byTask = new Map(), limits = new Map();
  for (const entry of entries) {
    // Limits describe the account now, whatever period the table shows.
    if (entry.limits) limits.set(entry.agentId, { agentId: entry.agentId, label: entry.label, ...entry.limits });
    if (Date.parse(entry.at) < since) continue;
    add(totals, entry.models, entry);
    add(slot(agents, entry.agentId, { id: entry.agentId, label: entry.label, profile: entry.profile }), entry.models, entry);
    add(slot(roles, entry.kind, { kind: entry.kind }), entry.models, entry);
    const task = tasks.find(item => item.id === entry.taskId);
    add(slot(byTask, entry.taskId, { taskId: entry.taskId, title: task?.title ?? null, projectId: task?.projectId ?? null }), entry.models, entry);
    for (const item of entry.models) add(slot(models, item.model || '', { model: item.model || '' }), [item], entry);
  }
  return { from, firstAt: entries[0]?.at ?? null, totals, agents: ranked(agents), models: ranked(models), roles: ranked(roles), tasks: ranked(byTask).slice(0, 10), limits: [...limits.values()] };
}
