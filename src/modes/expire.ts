import * as core from '@actions/core';
import { findExpiredClaims } from '../claims.js';
import { message } from '../messages.js';
import {
  loadTrackerState,
  type ModeContext,
  recomposeTrackerBody,
  writeStepSummary,
} from './index.js';

export async function runExpire(ctx: ModeContext): Promise<void> {
  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
  if (!issue?.body) {
    core.info('no tracker issue found, nothing to sweep');
    return;
  }
  const { state, releasedByView } = loadTrackerState(ctx, issue, 'expiry sweep');
  const expired = findExpiredClaims(state, ctx.now, ctx.config.ttlDays);
  if (expired.length === 0 && releasedByView === 0) {
    core.info('no expired claims and no view edits');
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
  const body = recomposeTrackerBody(ctx, issue.body, state);
  await ctx.api.updateIssueBody(issue.number, body);
  core.info(`released ${expired.length} expired claim(s) on issue #${issue.number}`);
  await writeStepSummary(
    `**⏰ Expiry sweep (issue #${issue.number})**

- Released: ${expired.length} overdue claim(s), with reminder comments
`,
  );
}
