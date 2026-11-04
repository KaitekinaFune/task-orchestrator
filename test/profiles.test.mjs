import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileEnvironment, validateVariables, deepDefaults, defaultProfiles } from '../src/profiles.mjs';

test('profile environments isolate values case-insensitively without modifying the parent', () => {
  const parent = { Anthropic_Base_Url: 'old', MY_URL: 'new', MY_SECRET: 'private', PATH: 'path' };
  const variables = [{ target: 'ANTHROPIC_BASE_URL', source: 'MY_URL' }, { target: 'ANTHROPIC_AUTH_TOKEN', source: 'MY_SECRET' }];
  const subscription = profileEnvironment('subscription', variables, parent);
  assert.deepEqual(subscription.environment, { PATH: 'path' });
  const lite = profileEnvironment('litellm', variables, parent);
  assert.deepEqual(lite.environment, { PATH: 'path', ANTHROPIC_BASE_URL: 'new', ANTHROPIC_AUTH_TOKEN: 'private' });
  assert.equal(parent.MY_SECRET, 'private');
  assert.deepEqual(profileEnvironment('litellm', variables, { MY_URL: 'x' }).missing, ['MY_SECRET']);
  assert.equal(validateVariables([{ target: 'x', source: 'a' }, { target: 'X', source: 'b' }]), false);
  assert.equal(validateVariables([{ target: 'TOKEN', source: 'secret value' }]), false);
  const cleanupOnly = profileEnvironment('litellm', [{ target: 'ANTHROPIC_API_KEY', source: '' }], { ANTHROPIC_API_KEY: 'old' });
  assert.deepEqual(cleanupOnly, { environment: {}, missing: [] });
  const stored = profileEnvironment('litellm', variables, {}, { ANTHROPIC_BASE_URL: 'https://example.test' }, 'vault-secret');
  assert.deepEqual(stored.missing, []);
  assert.equal(stored.environment.ANTHROPIC_BASE_URL, 'https://example.test');
  assert.equal(stored.environment.ANTHROPIC_AUTH_TOKEN, 'vault-secret');
});

test('DeepSeek never inherits provider values and uses its own saved settings and key', () => {
  const inherited = { ANTHROPIC_BASE_URL: 'https://corporate.test', ANTHROPIC_AUTH_TOKEN: 'corporate-secret', ANTHROPIC_MODEL: 'corporate-model', PATH: 'path' };
  const deep = profileEnvironment('deepseek', defaultProfiles.variables, inherited, deepDefaults, 'personal-secret');
  assert.deepEqual(deep.missing, []);
  assert.equal(deep.environment.ANTHROPIC_BASE_URL, deepDefaults.ANTHROPIC_BASE_URL);
  assert.equal(deep.environment.ANTHROPIC_AUTH_TOKEN, 'personal-secret');
  assert.equal(deep.environment.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.deepEqual(profileEnvironment('deepseek', defaultProfiles.variables, inherited, {}, null).missing, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN']);
});
