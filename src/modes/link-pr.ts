import * as core from '@actions/core';
import { readEventPayload } from '../event.js';
import { message } from '../messages.js';
import { activeClaims, fileKey, type TrackerState } from '../model.js';
import {
  loadTrackerState,
  type ModeContext,
  recomposeTrackerBody,
  writeStepSummary,
} from './index.js';

interface PullRequestEvent {
  action: 'opened' | 'synchronize' | 'closed';
  pull_request: { number: number; html_url: string; merged: boolean; user: { login: string } };
}

export async function runLinkPr(ctx: ModeContext): Promise<void> {
  const event = readEventPayload<PullRequestEvent>();
  const pr = event.pull_request;

  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
  if (!issue?.body) {
    core.info('no tracker issue found, nothing to link');
    return;
  }
  const { state } = loadTrackerState(ctx, issue, 'PR linking');

  if (event.action === 'closed') {
    await handleClosed(ctx, issue.number, issue.body, state, pr);
    return;
  }

  const changedFiles = new Set(await ctx.api.listPullRequestFiles(pr.number));
  const linked: string[] = [];
  for (const claim of activeClaims(state)) {
    if (claim.prUrl || claim.user !== pr.user.login) continue;
    // claim.path 是 sharedPath，PR 变更文件是仓库真实路径，通过清单条目的 localizationPath 换算
    const file = state.files.find(
      (candidate) =>
        fileKey(candidate.locale, candidate.sharedPath) === fileKey(claim.locale, claim.path),
    );
    if (
      changedFiles.has(claim.path) ||
      (file?.localizationPath && changedFiles.has(file.localizationPath))
    ) {
      claim.prUrl = pr.html_url;
      linked.push(`\`${claim.path}\`（${claim.locale}）`);
    }
  }
  if (linked.length === 0) {
    core.info(`PR #${pr.number} does not match any active claim`);
    return;
  }
  const updated = recomposeTrackerBody(ctx, issue.body, state);
  await ctx.api.updateIssueBody(issue.number, updated);
  core.info(`linked PR #${pr.number} to ${linked.length} claim(s), expiry frozen`);
  await writeStepSummary(
    `**🔗 PR linked (PR #${pr.number})**

- Linked: ${linked.length} (expiry frozen, body updated)`,
  );
}

async function handleClosed(
  ctx: ModeContext,
  issueNumber: number,
  body: string,
  state: TrackerState,
  pr: PullRequestEvent['pull_request'],
): Promise<void> {
  if (pr.merged) {
    core.info(`PR #${pr.number} merged; sync will settle the list`);
    return;
  }
  const released: string[] = [];
  for (const claim of activeClaims(state)) {
    if (claim.prUrl === pr.html_url) {
      claim.releasedAt = ctx.now.toISOString();
      claim.releaseReason = 'pr-closed';
      released.push(`\`${claim.path}\`（${claim.locale}）`);
    }
  }
  if (released.length === 0) {
    core.info('no claims linked to this PR');
    return;
  }
  const updated = recomposeTrackerBody(ctx, body, state);
  await ctx.api.updateIssueBody(issueNumber, updated);
  await ctx.api.addComment(
    issueNumber,
    message(ctx.config, 'pr_closed', { user: pr.user.login, paths: released.join('、') }),
  );
  core.info(`released ${released.length} claim(s) after PR #${pr.number} closed unmerged`);
  await writeStepSummary(
    `**↩️ PR closed unmerged (PR #${pr.number})**

- Released: ${released.length} (with reminder)`,
  );
}
