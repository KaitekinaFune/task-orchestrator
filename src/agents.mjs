import { RequestError } from './errors.mjs';
import { launchClaude, claudeStream, claudeArgs } from './claude.mjs';
import { launchCodex, codexStream, codexArgs } from './codex.mjs';

export function validateAgent(agent = 'claude', profile, model = '') {
  if (!['claude', 'codex'].includes(agent) ||
      !(agent === 'codex' ? profile === 'default' : ['subscription', 'litellm', 'deepseek'].includes(profile)) ||
      typeof model !== 'string' || (model !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model))) {
    throw new RequestError('Проверьте исполнителя, профиль и название модели', 400);
  }
  return { agent, profile, model };
}
export const adapters = {
  claude: { name: 'Claude', launch: launchClaude, stream: claudeStream, command: options => ['claude', ...claudeArgs(options)] },
  codex: { name: 'Codex', launch: launchCodex, stream: codexStream, command: options => ['codex', ...codexArgs(options)] }
};
