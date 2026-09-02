import { type ActionInputs, type ClaimConfig, loadConfig, repoFromEnv } from '../config.js';
import { createGitHubApi, type GitHubApi } from '../github.js';
import { runClaim } from './claim.js';
import { runExpire } from './expire.js';
import { runLinkPr } from './link-pr.js';
import { runSync } from './sync.js';

export interface ModeContext {
  inputs: ActionInputs;
  config: ClaimConfig;
  api: GitHubApi;
  repo: { owner: string; repo: string };
  now: Date;
}

export async function runMode(inputs: ActionInputs): Promise<void> {
  const repo = repoFromEnv();
  const ctx: ModeContext = {
    inputs,
    config: loadConfig(inputs.configPath),
    api: createGitHubApi(inputs.token, repo),
    repo,
    now: new Date(),
  };
  switch (inputs.mode) {
    case 'sync':
      return runSync(ctx);
    case 'claim':
      return runClaim(ctx);
    case 'expire':
      return runExpire(ctx);
    case 'link-pr':
      return runLinkPr(ctx);
  }
}
