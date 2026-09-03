import * as core from '@actions/core';
import {
  applyClaimEntries,
  composeClaimReplies,
  extractKnownPaths,
  hasIntent,
  parseClaimComment,
  releaseClaimsByCommentId,
} from '../claims.js';
import { readEventPayload } from '../event.js';
import { message } from '../messages.js';
import { activeClaims, fileKey, type TrackerState } from '../model.js';
import { resolveTargets } from '../resolve.js';
import {
  loadTrackerState,
  type ModeContext,
  recomposeTrackerBody,
  writeStepSummary,
} from './index.js';

interface IssueCommentEvent {
  action?: 'created' | 'edited' | 'deleted';
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
  const { state } = loadTrackerState(ctx, issue, 'claim processing');

  // 账本语义：编辑 = 先释放该评论的全部活跃认领，再按新正文完整重放；
  // 删除 = 只静默释放 + 写回（不解析正文、不打 reaction、不回复）。
  let releasedByEdit = 0;
  if (event.action === 'edited') {
    releasedByEdit = releaseClaimsByCommentId(state, event.comment.id, ctx.now, 'voluntary').length;
    core.info(
      `comment #${event.comment.id} edited: released ${releasedByEdit} previous claim(s), replaying new content`,
    );
  } else if (event.action === 'deleted') {
    const released = releaseClaimsByCommentId(state, event.comment.id, ctx.now, 'voluntary');
    if (released.length === 0) {
      core.info('deleted comment had no active claims, nothing to do');
      return;
    }
    const updated = recomposeTrackerBody(ctx, issue.body, state);
    await ctx.api.updateIssueBody(issue.number, updated);
    core.info(
      `released ${released.length} claim(s) after comment #${event.comment.id} was deleted`,
    );
    await writeStepSummary(
      `**🗑️ Claim comment deleted (issue #${event.issue.number})**
      
- Released: ${released.length}`,
    );
    return;
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
    if (releasedByEdit > 0) {
      // 编辑成普通文字 = 只释放：把 edited 分支的释放落盘
      const updated = recomposeTrackerBody(ctx, issue.body, state);
      await ctx.api.updateIssueBody(issue.number, updated);
      core.info('no claim/release intent in the edited content; persisted the releases only');
      await writeStepSummary(
        `**✏️ Claim comment edited (issue #${event.issue.number})**
        
- Released: ${releasedByEdit} previous claim(s) (new content has no claim intent)`,
      );
      return;
    }
    core.info('no claim/release intent found, treating as a normal comment');
    return;
  }

  const before = JSON.stringify(state.claims);
  const replies: string[] = [];
  let claimedAny = false;
  let releasedAny = false;

  const { entries, failures } = resolveTargets([...claimTokens, ...lenientTokens], state);
  const application = applyClaimEntries(
    state,
    entries,
    user,
    event.comment.created_at,
    event.comment.id,
    event.comment.html_url,
  );
  claimedAny = application.created > 0;
  replies.push(
    ...composeClaimReplies({
      entries,
      failures,
      skipped: application.skipped,
      config: ctx.config,
    }),
  );
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

  const changed = before !== JSON.stringify(state.claims) || releasedByEdit > 0;
  if (changed) {
    const updated = recomposeTrackerBody(ctx, issue.body, state);
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
  await writeStepSummary(
    [
      `**🤖 Claim processing (issue #${event.issue.number})**`,
      '',
      `- Created: ${application.created}, skipped: ${application.skipped.length}, failed: ${failures.length}`,
      releasedAny ? `- Given up: ${releaseTokens.length} target(s)` : null,
      replies.length > 0 ? `- Replies posted: ${replies.length}` : null,
      changed ? '- Body: updated' : '- Body: unchanged',
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
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
