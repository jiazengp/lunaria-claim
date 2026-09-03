import { readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { applyViewEdits } from '../claims.js';
import { type ActionInputs, type ClaimConfig, loadConfig, repoFromEnv } from '../config.js';
import { createGitHubApi, type GitHubApi } from '../github.js';
import { groupByLocale, type TrackerState } from '../model.js';
import { rebuildFromTemplate, recomposeBody, renderOptions } from '../render.js';
import { parseState } from '../state.js';
import { runClaim } from './claim.js';
import { runExpire } from './expire.js';
import { runLinkPr } from './link-pr.js';
import { runSync } from './sync.js';
import { runViewEdit } from './view-edit.js';

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
  /** 用户显式配置了 templatePath（自定义模板 = 布局真相源，正文每次整体重建） */
  templateExplicit: boolean;
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
  const template = readFileSync(ctx.config.templatePath, 'utf-8');
  const sections = groupByLocale(state.files);
  const vars = {
    ttl_days: String(ctx.config.ttlDays),
    dashboard_url: ctx.config.dashboardUrl ?? '',
  };
  const options = renderOptions(ctx.config, ctx.repo, state.files);
  // 显式配置 templatePath = 模板是布局真相源，正文以模板整体重建（手写编辑不保留）；
  // 未显式配置时维持原位覆盖（尊重正文手写内容；多占位符模板仍由 recomposeBody 内部整体重建）
  if (ctx.templateExplicit) {
    return rebuildFromTemplate(template, sections, state, vars, options);
  }
  return recomposeBody(body, template, sections, state, vars, options);
}

export async function runMode(inputs: ActionInputs): Promise<void> {
  const repo = repoFromEnv();
  const loaded = loadConfig(inputs.configPath);
  const ctx: ModeContext = {
    inputs,
    config: loaded.config,
    templateExplicit: loaded.templateExplicit,
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
    case 'view-edit':
      return runViewEdit(ctx);
  }
}
