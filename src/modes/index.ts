import { readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { applyViewEdits } from '../claims.js';
import { type ActionInputs, type ClaimConfig, loadConfig, repoFromEnv } from '../config.js';
import { createGitHubApi, type GitHubApi } from '../github.js';
import { groupByLocale, type TrackerState } from '../model.js';
import { recomposeBody, renderOptions } from '../render.js';
import { parseState } from '../state.js';
import { runClaim } from './claim.js';
import { runExpire } from './expire.js';
import { runLinkPr } from './link-pr.js';
import { runSync } from './sync.js';

/** 写入 GitHub Step Summary；环境不支持时降级为日志，不失败 */
export async function writeStepSummary(content: string): Promise<void> {
  try {
    await core.summary.addRaw(content).write();
  } catch (error) {
    core.warning(`step summary unavailable: ${String(error)}`);
  }
}

export interface ModeContext {
  inputs: ActionInputs;
  config: ClaimConfig;
  api: GitHubApi;
  repo: { owner: string; repo: string };
  now: Date;
}

/** 读取 issue body 里的状态块；损坏时抛出统一错误。返回状态与视图对账结果。 */
export function loadTrackerState(
  ctx: ModeContext,
  issue: { number: number; body: string | null },
  phase: string,
): { state: TrackerState; releasedByView: number } {
  const body = issue.body ?? '';
  const state = parseState(body);
  if (!state) {
    throw new Error(`tracker issue #${issue.number} has no readable state block`);
  }
  const releasedByView = applyViewEdits(state, body, ctx.now);
  if (releasedByView > 0) {
    core.info(`manual view edits released ${releasedByView} claim(s) before ${phase}`);
  }
  return { state, releasedByView };
}

/** 用模板 + 配置 + 渲染参数重写 body（4 个模式的统一入口） */
export function recomposeTrackerBody(ctx: ModeContext, body: string, state: TrackerState): string {
  return recomposeBody(
    body,
    readFileSync(ctx.config.templatePath, 'utf-8'),
    groupByLocale(state.files),
    state,
    { ttl_days: String(ctx.config.ttlDays), dashboard_url: ctx.config.dashboardUrl ?? '' },
    renderOptions(ctx.config, ctx.repo, state.files),
  );
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
