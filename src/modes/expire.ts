import * as core from '@actions/core';
import { applyViewEdits, findExpiredClaims } from '../claims.js';
import { message } from '../messages.js';
import { groupByLocale } from '../model.js';
import { renderBody, renderOptions } from '../render.js';
import { parseState } from '../state.js';
import { type ModeContext, writeStepSummary } from './index.js';

export async function runExpire(ctx: ModeContext): Promise<void> {
  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
  if (!issue?.body) {
    core.info('no tracker issue found, nothing to sweep');
    return;
  }
  const state = parseState(issue.body);
  if (!state) {
    throw new Error(`tracker issue #${issue.number} has no readable state block`);
  }
  const releasedByView = applyViewEdits(state, issue.body, ctx.now);
  if (releasedByView > 0) {
    core.info(`manual view edits released ${releasedByView} claim(s) before expiry sweep`);
  }
  const expired = findExpiredClaims(state, ctx.now, ctx.config.ttlDays);
  if (expired.length === 0) {
    core.info('no expired claims');
    return;
  }
  for (const claim of expired) {
    claim.releasedAt = ctx.now.toISOString();
    claim.releaseReason = 'expired';
    await ctx.api.addComment(
      issue.number,
      message(ctx.config, 'expired', {
        user: claim.user,
        path: claim.path,
        locale: claim.locale,
        ttlDays: String(ctx.config.ttlDays),
      }),
    );
  }
  const body = renderBody(
    issue.body,
    groupByLocale(state.files),
    state,
    renderOptions(ctx.config, ctx.repo, state.files),
  );
  await ctx.api.updateIssueBody(issue.number, body);
  core.info(`released ${expired.length} expired claim(s) on issue #${issue.number}`);
  await writeStepSummary(
    `**⏰ Expiry sweep (issue #${issue.number})**

- Released: ${expired.length} overdue claim(s), with reminder comments
`,
  );
}
