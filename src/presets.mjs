import { RequestError } from './errors.mjs';
import { validateWorkflow, workflowRunsChecks } from './workflows.mjs';
import { validateAgent } from './agents.mjs';
import { validateChecks } from './checks.mjs';

// A process says how to work, so it is global. Which checks it runs is decided by each project,
// because check IDs have meaning only there.
export function validatePreset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 ||
      typeof value.instructions !== 'string' || value.instructions.length > 10000 ||
      Object.keys(value).some(key => !['name', 'profile', 'instructions', 'workflow', 'agent', 'model'].includes(key))) {
    throw new RequestError('Проверьте название, профиль и инструкции процесса', 400);
  }
  validateAgent(value.agent, value.profile, value.model);
  if (!value.workflow || typeof value.workflow !== 'object' || Array.isArray(value.workflow)) throw new RequestError('Укажите этапы процесса', 400);
  if ('checkIds' in value.workflow) throw new RequestError('Проверки выбираются в настройках проекта, а не в процессе', 400);
  const { checkIds, ...workflow } = validateWorkflow({ ...value.workflow, checkIds: [] }, null);
  return { name: value.name.trim(), profile: value.profile, ...(value.agent ? { agent: value.agent } : {}), ...(value.model ? { model: value.model } : {}), instructions: value.instructions.trim(), workflow };
}

// No stored choice means every check of the project, including ones added later.
export function presetCheckIds(preset, project) {
  if (!workflowRunsChecks(preset.workflow)) return [];
  return project.presetChecks?.[preset.id] ?? validateChecks(project.checks || []).map(check => check.id);
}

export function projectWorkflow(preset, project) {
  const checkIds = presetCheckIds(preset, project);
  if (['checked', 'graph'].includes(preset.workflow.mode) && workflowRunsChecks(preset.workflow) && !checkIds.length) throw new RequestError(`Процесс «${preset.name}» запускает проверки, но в этом проекте они не выбраны. Настройте их в разделе «Проекты».`, 400);
  return { ...preset.workflow, checkIds };
}

export function validatePresetChecks(preset, project, checkIds) {
  if (!workflowRunsChecks(preset.workflow)) throw new RequestError('Этот процесс не запускает проверки', 400);
  if (checkIds === null) return null;
  return validateWorkflow({ ...preset.workflow, checkIds }, project).checkIds;
}

// Presets used to live in projects. Identical ones merge; a repeated name with different settings
// gets its project's name, so that a global list stays readable. Returns whether anything changed.
export function migratePresets(state) {
  const legacy = state.projects.some(project => 'presets' in project);
  state.presets ??= [];
  if (!legacy) return false;
  const byDefinition = new Map(), names = new Set(state.presets.map(preset => preset.name));
  for (const project of state.projects) {
    const replaced = new Map();
    for (const preset of project.presets || []) {
      const { id, updatedAt, workflow: { checkIds = [], ...workflow }, ...rest } = preset;
      const key = JSON.stringify({ ...rest, workflow });
      let target = byDefinition.get(key);
      if (!target) {
        const name = names.has(rest.name) ? `${rest.name} (${project.path.split(/[\\/]/).filter(Boolean).at(-1)})`.slice(0, 80) : rest.name;
        target = { ...rest, name, workflow, id, updatedAt };
        byDefinition.set(key, target); names.add(name); state.presets.push(target);
      }
      replaced.set(id, target.id);
      if (workflow.mode !== 'quick') (project.presetChecks ??= {})[target.id] = checkIds;
    }
    if (project.defaultPresetId) project.defaultPresetId = replaced.get(project.defaultPresetId) ?? '';
    delete project.presets;
  }
  return true;
}
