import * as core from '@actions/core';
import { applyClaimEntries, extractKnownPaths, hasIntent, parseClaimComment } from '../claims.js';
import { readEventPayload } from '../event.js';
import { message } from '../messages.js';
import { activeClaims, fileKey, groupByLocale, type TrackerState } from '../model.js';
import { renderBody, renderOptions } from '../render.js';
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
  const lenientTokens = lenient ? lenientTargets(body, state) : [];
  if (claimTokens.length === 0 && releaseTokens.length === 0 && lenientTokens.length === 0) {
    core.info('no claim/release intent found, treating as a normal comment');
    return;
  }

  const before = JSON.stringify(state.claims);
  const replies: string[] = [];
  let claimedAny = false;
  let releasedAny = false;

  const { entries, failures } = resolveTargets([...claimTokens, ...lenientTokens], state);
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
  const application = applyClaimEntries(
    state,
    entries,
    user,
    event.comment.created_at,
    event.comment.id,
    event.comment.html_url,
  );
  claimedAny = application.created > 0;
  // 目录级跳过聚合成一条提示；单文件跳过保持逐条 duplicate 提示
  const dirSkips = new Map<
    string,
    { list: (typeof application.skipped)[number][]; total: number }
  >();
  for (const skipped of application.skipped) {
    if (skipped.dir) {
      const bucket = dirSkips.get(skipped.dir) ?? { list: [], total: 0 };
      bucket.list.push(skipped);
      dirSkips.set(skipped.dir, bucket);
    } else {
      replies.push(
        message(ctx.config, 'duplicate', {
          path: skipped.path,
          locale: skipped.locale,
          claimer: skipped.claimer,
        }),
      );
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    const bucket = dirSkips.get(entry.token);
    if (!bucket) continue;
    bucket.total = entry.files.length;
    const shown = bucket.list
      .slice(0, 3)
      .map((skip) => `\`${skip.path}\`（@${skip.claimer}）`)
      .join('、');
    const more = bucket.list.length > 3 ? ` 等 ${bucket.list.length} 个` : '';
    replies.push(
      message(ctx.config, 'dir_skipped', {
        dir: entry.token,
        claimed: String(bucket.total - bucket.list.length),
        skippedCount: String(bucket.list.length),
        skipped: shown + more,
      }),
    );
  }
  for (const token of releaseTokens) {
    const release = resolveTargets([token], state);
    for (const failure of release.failures) {
      replies.push(message(ctx.config, 'unknown_file', { token: failure.token }));
    }
    for (const entry of release.entries) {
      for (const file of entry.files) {
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
  }

  const changed = before !== JSON.stringify(state.claims);
  if (changed) {
    const updated = renderBody(
      issue.body,
      groupByLocale(state.files),
      state,
      renderOptions(ctx.config),
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
    `claim processing done: ${entries.length} entry(ies), ${failures.length} failed, changed=${changed}`,
  );
}

/** 宽松模式：先对齐清单里出现的完整 sharedPath，再看目录前缀（如 `src/manual/`） */
function lenientTargets(body: string, state: TrackerState): string[] {
  const known = new Set(state.files.map((file) => file.sharedPath));
  for (const file of state.files) {
    const parts = file.sharedPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      known.add(`${parts.slice(0, i).join('/')}/`);
    }
  }
  return extractKnownPaths(body, [...known]);
}
