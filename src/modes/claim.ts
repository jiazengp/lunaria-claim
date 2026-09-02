import * as core from '@actions/core';
import { extractKnownPaths, hasIntent, parseClaimComment } from '../claims.js';
import { readEventPayload } from '../event.js';
import { message } from '../messages.js';
import { activeClaims, fileKey, groupByLocale } from '../model.js';
import { renderBody } from '../render.js';
import { resolveTargets } from '../resolve.js';
import { parseState } from '../state.js';
import type { ModeContext } from './index.js';

interface IssueCommentEvent {
  comment: {
    id: number;
    body: string;
    user: { login: string };
    html_url: string;
    created_at: string;
  };
  issue: { number: number };
}

export async function runClaim(ctx: ModeContext): Promise<void> {
  const event = readEventPayload<IssueCommentEvent>();
  const user = event.comment.user.login;
  if (user.endsWith('[bot]')) {
    core.info('bot comment, skipping');
    return;
  }

  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
  if (!issue?.body || issue.number !== event.issue.number) {
    core.info('comment is not on the tracker issue, skipping');
    return;
  }
  const state = parseState(issue.body);
  if (!state) {
    throw new Error(`tracker issue #${issue.number} has no readable state block`);
  }

  const body = event.comment.body;
  const commands = parseClaimComment(body);
  const claimTokens = commands.filter((c) => c.kind === 'claim').flatMap((c) => c.paths);
  const releaseTokens = commands.filter((c) => c.kind === 'release').flatMap((c) => c.paths);
  const lenient =
    claimTokens.length === 0 &&
    !ctx.config.strictClaimSyntax &&
    hasIntent(body, ctx.config.lenientKeywords);
  const lenientTokens = lenient
    ? extractKnownPaths(
        body,
        state.files.map((file) => file.sharedPath),
      )
    : [];
  if (claimTokens.length === 0 && releaseTokens.length === 0 && lenientTokens.length === 0) {
    core.info('no claim/release intent found, treating as a normal comment');
    return;
  }

  const before = JSON.stringify(state.claims);
  const replies: string[] = [];
  let claimedAny = false;
  let releasedAny = false;

  const { resolved, failures } = resolveTargets([...claimTokens, ...lenientTokens], state);
  for (const failure of failures) {
    replies.push(
      failure.reason === 'ambiguous'
        ? message(ctx.config, 'ambiguous', {
            token: failure.token,
            candidates: failure.candidates.join('、'),
          })
        : message(ctx.config, 'unknown_file', { token: failure.token }),
    );
  }
  for (const file of resolved) {
    const existing = activeClaims(state).find(
      (claim) => fileKey(claim.locale, claim.path) === fileKey(file.locale, file.sharedPath),
    );
    if (existing && existing.user !== user) {
      replies.push(
        message(ctx.config, 'duplicate', {
          path: file.sharedPath,
          locale: file.locale,
          claimer: existing.user,
        }),
      );
      continue;
    }
    if (!existing) {
      state.claims.push({
        path: file.sharedPath,
        locale: file.locale,
        user,
        claimedAt: event.comment.created_at,
        commentId: event.comment.id,
        commentUrl: event.comment.html_url,
      });
    }
    claimedAny = true;
  }
  for (const token of releaseTokens) {
    const release = resolveTargets([token], state);
    for (const failure of release.failures) {
      replies.push(message(ctx.config, 'unknown_file', { token: failure.token }));
    }
    for (const file of release.resolved) {
      const own = activeClaims(state).find(
        (claim) =>
          claim.user === user &&
          fileKey(claim.locale, claim.path) === fileKey(file.locale, file.sharedPath),
      );
      if (own) {
        own.releasedAt = ctx.now.toISOString();
        own.releaseReason = 'voluntary';
        releasedAny = true;
      }
    }
  }

  const changed = before !== JSON.stringify(state.claims);
  if (changed) {
    const updated = renderBody(
      issue.body,
      groupByLocale(state.files),
      state,
      ctx.config.collapseThreshold,
    );
    await ctx.api.updateIssueBody(issue.number, updated);
  }
  if (claimedAny) await ctx.api.reactToComment(event.comment.id, 'rocket');
  else if (releasedAny) await ctx.api.reactToComment(event.comment.id, 'eyes');
  if (replies.length > 0) {
    await ctx.api.addComment(issue.number, replies.join('\n\n'));
    await ctx.api.reactToComment(event.comment.id, 'confused');
  }
  core.info(
    `claim processing done: ${resolved.length} resolved, ${failures.length} failed, changed=${changed}`,
  );
}
