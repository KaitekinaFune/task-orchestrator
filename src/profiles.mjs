// Variable names are persisted; secrets are obtained separately from the Windows vault.
export const defaultProfiles = { variables: [
  ...['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].map(name => ({ target: name, source: name })),
  ...['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'].map(name => ({ target: name, source: '' }))
] };
const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const liteFields = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
export const deepFields = [...liteFields, 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
export const deepDefaults = { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' };
export function validateVariables(variables) {
  if (!Array.isArray(variables) || variables.length > 32) return false;
  const targets = new Set();
  return variables.every(v => {
    if (!v || typeof v.target !== 'string' || typeof v.source !== 'string' || !validName.test(v.target) || (v.source !== '' && !validName.test(v.source)) || v.target.length > 128 || v.source.length > 128 || targets.has(v.target.toUpperCase())) return false;
    targets.add(v.target.toUpperCase()); return true;
  });
}
export function profileEnvironment(profile, variables, inherited = process.env, liteSettings = {}, secret = null) {
  if (!['subscription', 'litellm', 'deepseek'].includes(profile) || !validateVariables(variables)) throw new Error('Invalid profile');
  const environment = { ...inherited };
  // Environment keys are case-insensitive on Windows, including keys in a plain JS object.
  const remove = name => { for (const key of Object.keys(environment)) if (key.toUpperCase() === name.toUpperCase()) delete environment[key]; };
  const find = name => Object.keys(inherited).find(key => key.toUpperCase() === name.toUpperCase());
  const missing = [];
  for (const { target } of defaultProfiles.variables) remove(target);
  for (const { target, source } of variables) { remove(target); if (source) remove(source); }
  if (profile === 'litellm') {
    for (const { target, source } of variables) {
      if (!source) continue;
      const key = find(source);
      if (!key || !inherited[key]) missing.push(source);
      else environment[target] = inherited[key];
    }
    for (const target of liteFields) if (liteSettings[target]) { remove(target); environment[target] = liteSettings[target]; }
    if (secret) { remove('ANTHROPIC_AUTH_TOKEN'); environment.ANTHROPIC_AUTH_TOKEN = secret; }
    for (let i = missing.length - 1; i >= 0; i--) {
      const entry = variables.find(v => v.source === missing[i]);
      if (entry && ((entry.target === 'ANTHROPIC_AUTH_TOKEN' && secret) || (liteFields.includes(entry.target) && liteSettings[entry.target]))) missing.splice(i, 1);
    }
  }
  if (profile === 'deepseek') {
    for (const target of deepFields) if (liteSettings[target]) environment[target] = liteSettings[target];
    if (secret) environment.ANTHROPIC_AUTH_TOKEN = secret;
    for (const target of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN']) if (!environment[target]) missing.push(target);
  }
  return { environment, missing };
}
