import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePreset, validatePresetChecks, presetCheckIds, projectWorkflow, migratePresets } from '../src/presets.mjs';

const check = id => ({ id, name: id, executable: 'node', args: ['--version'], timeoutSeconds: 5 });
const checked = { id: 'p', name: 'Checked', profile: 'subscription', instructions: '', workflow: { mode: 'checked' } };

test('presets reject unsupported steps, credentials and check selections of their own', () => {
  const preset = { name: ' Simple ', profile: 'subscription', instructions: '', workflow: { mode: 'quick' } };
  assert.equal(validatePreset(preset).name, 'Simple');
  assert.deepEqual(validatePreset({ ...preset, workflow: { mode: 'checked' } }).workflow, { mode: 'checked' });
  for (const value of [null, {}, { ...preset, key: 'secret' }, { ...preset, profile: 'unknown' },
    { ...preset, workflow: undefined }, { ...preset, name: '' }, { ...preset, instructions: [] },
    { ...preset, workflow: { mode: 'review' } },
    { ...preset, workflow: { mode: 'checked', checkIds: ['tests'] } }]) {
    assert.throws(() => validatePreset(value));
  }
});

test('one process runs each project\'s own checks: all by default, or the stored choice', () => {
  const unity = { id: 'unity', checks: [check('compile'), check('playmode')] };
  const java = { id: 'java', checks: [check('gradle')], presetChecks: { p: ['gradle'] } };
  assert.deepEqual(projectWorkflow(checked, unity), { mode: 'checked', checkIds: ['compile', 'playmode'] });
  assert.deepEqual(projectWorkflow(checked, java), { mode: 'checked', checkIds: ['gradle'] });
  unity.presetChecks = { p: ['compile'] };
  assert.deepEqual(presetCheckIds(checked, unity), ['compile']);
  assert.deepEqual(projectWorkflow({ ...checked, workflow: { mode: 'quick' } }, unity), { mode: 'quick', checkIds: [] });
});

test('a process needing checks is refused in a project without them, never silently skipped', () => {
  assert.throws(() => projectWorkflow(checked, { checks: [] }), /не выбраны/);
  assert.throws(() => projectWorkflow(checked, { checks: [check('a')], presetChecks: { p: [] } }), /не выбраны/);
  const review = { ...checked, workflow: { mode: 'review', reviewer: { agent: 'codex', profile: 'default', model: '', instructions: '' } } };
  assert.deepEqual(projectWorkflow(review, { checks: [] }).checkIds, []);
});

test('check selection accepts only checks of the project and null resets it', () => {
  const project = { checks: [check('a')] };
  assert.deepEqual(validatePresetChecks(checked, project, ['a']), ['a']);
  assert.equal(validatePresetChecks(checked, project, null), null);
  assert.throws(() => validatePresetChecks(checked, project, ['missing']), /удалена/);
  assert.throws(() => validatePresetChecks(checked, project, []), /хотя бы одну/);
  assert.throws(() => validatePresetChecks(checked, project, 'a'));
  assert.throws(() => validatePresetChecks({ ...checked, workflow: { mode: 'quick' } }, project, ['a']), /не запускает/);
});

test('migration merges identical presets and keeps each project\'s defaults and checks', () => {
  const shared = { name: 'Fix', profile: 'subscription', instructions: '', updatedAt: '2026-01-01' };
  const state = { tasks: [{ id: 't', preset: { id: 'old', name: 'kept copy' } }], projects: [
    { id: 'a', path: 'C:\\Projects\\alpha', checks: [check('x')], defaultPresetId: 'a1', presets: [{ ...shared, id: 'a1', workflow: { mode: 'checked', checkIds: ['x'] } }, { ...shared, id: 'a2', name: 'Quick', workflow: { mode: 'quick', checkIds: [] } }] },
    { id: 'b', path: 'C:\\Projects\\beta', checks: [check('y')], defaultPresetId: 'b1', presets: [{ ...shared, id: 'b1', workflow: { mode: 'checked', checkIds: ['y'] } }, { ...shared, id: 'b2', instructions: 'Other', workflow: { mode: 'checked', checkIds: ['y'] } }] },
    { id: 'c', path: 'C:\\Projects\\gamma', defaultPresetId: 'removed', presets: [] },
    { id: 'd', path: 'C:\\Projects\\delta' }
  ] };
  assert.equal(migratePresets(state), true);
  assert.deepEqual(state.presets.map(p => [p.id, p.name]), [['a1', 'Fix'], ['a2', 'Quick'], ['b2', 'Fix (beta)']]);
  assert.deepEqual(state.presets[0].workflow, { mode: 'checked' });
  const [alpha, beta, gamma] = state.projects;
  assert.equal(alpha.defaultPresetId, 'a1'); assert.deepEqual(alpha.presetChecks, { a1: ['x'] });
  assert.equal(beta.defaultPresetId, 'a1'); assert.deepEqual(beta.presetChecks, { a1: ['y'], b2: ['y'] });
  assert.equal(gamma.defaultPresetId, '');
  assert.ok(state.projects.every(project => !('presets' in project)));
  assert.equal(state.tasks[0].preset.name, 'kept copy');
  const once = structuredClone(state);
  assert.equal(migratePresets(state), false); assert.deepEqual(state, once);
});
