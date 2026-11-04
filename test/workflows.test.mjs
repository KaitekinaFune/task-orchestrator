import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, workflowPlan } from '../src/workflows.mjs';

const project = { checks: [{ id: 'compile', name: 'Compile', executable: 'compiler.exe', args: [], timeoutSeconds: 30 }] };
test('workflow validation rejects unavailable review modes and invalid check selections', () => {
  for (const workflow of [null, {}, { mode: 'review', checkIds: [] }, { mode: 'quick', checkIds: ['compile'] },
    { mode: 'checked', checkIds: [] }, { mode: 'checked', checkIds: ['missing'] }, { mode: 'checked', checkIds: ['compile', 'compile'] },
    { mode: 'checked', checkIds: ['compile'], autoMerge: true }]) assert.throws(() => validateWorkflow(workflow, project));
  assert.deepEqual(validateWorkflow({ mode: 'checked', checkIds: ['compile'] }, project), { mode: 'checked', checkIds: ['compile'] });
});
test('legacy tasks retain all project checks and an unperformed review', () => {
  const plan = workflowPlan({}, project);
  assert.equal(plan.workflow.mode, 'legacy'); assert.deepEqual(plan.checks, project.checks); assert.equal(plan.review, 'не выполнено');
});
