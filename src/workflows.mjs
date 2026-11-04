import { validateChecks } from './checks.mjs';
import { RequestError } from './errors.mjs';
import { validateAutomation } from './automation.mjs';
import { validateAgent } from './agents.mjs';
import { validateGraph, graphRunsChecks, graphRunsReview } from './graph.mjs';

export const workflowRunsChecks = workflow => workflow.mode === 'graph' ? graphRunsChecks(workflow.graph) : workflow.mode !== 'quick';

// Any configured agent may take a role. Older reviewers stored only {agent: 'codex', model, instructions}.
function validateRole(role, allowed, message) {
  if (!role || typeof role !== 'object' || Array.isArray(role) || typeof role.agent !== 'string' || typeof role.model !== 'string' ||
      Object.keys(role).some(key => !allowed.includes(key))) throw new RequestError(message, 400);
  try { return validateAgent(role.agent, role.profile ?? (role.agent === 'codex' ? 'default' : undefined), role.model); }
  catch { throw new RequestError(message, 400); }
}

// Without a project only the shape is checked: a global process does not know the project's checks.
export function validateWorkflow(value, project) {
  // Existing API clients/tasks retain the old all-project-checks behavior.
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['mode', 'checkIds', 'reviewer', 'fixer', 'automation', 'graph'].includes(key)) ||
    !['quick', 'checked', 'review', 'graph'].includes(value.mode) || !Array.isArray(value.checkIds) ||
    value.checkIds.length > 12 || value.checkIds.some(id => typeof id !== 'string') || new Set(value.checkIds).size !== value.checkIds.length) {
    throw new RequestError('Выберите режим «Один агент» или «Агент + проверки» и корректный список проверок', 400);
  }
  if (value.graph !== undefined && value.mode !== 'graph') throw new RequestError('Граф шагов допустим только в режиме графа', 400);
  if (value.mode === 'graph') {
    if (['reviewer', 'fixer', 'automation'].some(key => value[key] !== undefined)) throw new RequestError('Ревьюер, исправления и лимиты графа задаются в его шагах', 400);
    const graph = validateGraph(value.graph);
    if (!graphRunsChecks(graph) && value.checkIds.length) throw new RequestError('В этом графе нет шага проверок', 400);
    if (project && graphRunsChecks(graph)) {
      const available = validateChecks(project.checks || []);
      if (!value.checkIds.length) throw new RequestError('В графе есть шаг проверок: выберите хотя бы одну проверку проекта', 400);
      if (value.checkIds.some(id => !available.some(check => check.id === id))) throw new RequestError('Выбранная проверка удалена или недоступна. Выберите проверки проекта заново.', 400);
    }
    return { mode: value.mode, checkIds: [...value.checkIds], graph };
  }
  if (value.mode === 'quick') {
    if (value.checkIds.length) throw new RequestError('В режиме «Один агент» автоматические проверки отключены. Для них выберите «Агент + проверки».', 400);
  } else if (project) {
    const available = validateChecks(project.checks || []);
    if (value.mode === 'checked' && !value.checkIds.length) throw new RequestError('Выберите хотя бы одну проверку для режима «Агент + проверки»', 400);
    if (value.checkIds.some(id => !available.some(check => check.id === id))) throw new RequestError('Выбранная проверка удалена или недоступна. Выберите проверки проекта заново.', 400);
  }
  if (value.mode === 'review') {
    const r = value.reviewer, message = 'Настройте ревьюера: агент, профиль, модель и инструкции';
    const reviewer = validateRole(r, ['agent', 'profile', 'model', 'instructions'], message);
    if (typeof r.instructions !== 'string' || r.instructions.length > 10000) throw new RequestError(message, 400);
    const automation = validateAutomation(value.automation);
    if (value.fixer !== undefined && !automation?.maxFixes) throw new RequestError('Отдельный агент исправлений допустим только при включённых автоматических исправлениях', 400);
    const fixer = value.fixer === undefined ? undefined : validateRole(value.fixer, ['agent', 'profile', 'model'], 'Настройте агента исправлений: агент, профиль и модель');
    return { mode: value.mode, checkIds: [...value.checkIds], reviewer: { ...reviewer, instructions: r.instructions.trim() }, ...(fixer ? { fixer } : {}), ...(automation ? { automation } : {}) };
  }
  if (value.reviewer !== undefined) throw new RequestError('Ревьюер допустим только в режиме с ревью', 400);
  if (value.fixer !== undefined) throw new RequestError('Агент исправлений допустим только в режиме с ревью', 400);
  if (value.automation !== undefined) throw new RequestError('Автоматические исправления допустимы только в режиме с ревью', 400);
  return { mode: value.mode, checkIds: [...value.checkIds] };
}

export function workflowPlan(task, project) {
  const workflow = validateWorkflow(task.workflow, project);
  if (!workflow) return { workflow: { mode: 'legacy', checkIds: null }, checks: validateChecks(project.checks || []), review: 'не выполнено' };
  return { workflow, checks: workflowRunsChecks(workflow) ? validateChecks(project.checks || []).filter(check => workflow.checkIds.includes(check.id)) : [], review: workflow.mode === 'review' || (workflow.mode === 'graph' && graphRunsReview(workflow.graph)) ? 'не выполнено' : 'не запрошено' };
}
