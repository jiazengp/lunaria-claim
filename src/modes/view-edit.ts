import * as core from '@actions/core';
import { applyClaimEntries, releaseClaimForViewEntry } from '../claims.js';
import { readEventPayload } from '../event.js';
import { fileKey } from '../model.js';
import { parseViewCheckboxes, type ViewCheckbox } from '../render.js';
import { resolveTargets } from '../resolve.js';
import { parseState } from '../state.js';
import { type ModeContext, recomposeTrackerBody, writeStepSummary } from './index.js';

interface IssuesEditedEvent {
  action: 'edited';
  sender: { login: string; type: string };
  issue: { number: number; body: string };
  changes: { body?: { from: string } };
}

/**
 * 正文编辑对账（issues: [edited] 触发）：手工勾选/取消勾选认领清单。
 * - 取消勾选（或整行删除）= 手动释放，并在原认领评论上打 👎 通知；
 * - 勾选未认领行 = 以编辑者为认领人入账（commentId=0 哨兵，正文勾选认领无法从评论自愈回放）。
 * 只读事件 payload 的 issue.body，不重新 fetch；与写回之间的竞态由 concurrency 串行
 * + 下一次 sync 全量对账兜底（与 claim mode 一致）。
 */
export async function runViewEdit(ctx: ModeContext): Promise<void> {
  const event = readEventPayload<IssuesEditedEvent>();
  if (event.sender.type === 'Bot') {
    core.info('bot edited the issue, skipping (avoids a self-loop on our own writeback)');
    return;
  }
  const from = event.changes?.body?.from;
  if (!from) {
    core.info('issue edit did not touch the body, skipping');
    return;
  }

  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
  if (!issue || issue.number !== event.issue.number) {
    core.info('edited issue is not the tracker issue, skipping');
    return;
  }
  const state = parseState(event.issue.body);
  if (!state) {
    throw new Error(`tracker issue #${event.issue.number} has no readable state block`);
  }

  const keyOf = (entry: ViewCheckbox) =>
    entry.locale ? fileKey(entry.locale, entry.sharedPath) : entry.sharedPath;
  // 同一路径可能跨区块重复出现（如 {{files}} 单区模板的目录行会在每个语言区块各渲染一次），
  // 按键汇聚勾选态：任一区块勾选即算勾选（last-wins 会吞掉跨区块的差异）
  interface MergedView {
    oldEntry: ViewCheckbox;
    newEntry: ViewCheckbox;
    wasChecked: boolean;
    isChecked: boolean;
  }
  const merged = new Map<string, MergedView>();
  for (const entry of parseViewCheckboxes(from)) {
    const key = keyOf(entry);
    const current = merged.get(key) ?? {
      oldEntry: entry,
      newEntry: entry,
      wasChecked: false,
      isChecked: false,
    };
    current.oldEntry = entry;
    current.wasChecked = current.wasChecked || entry.checked;
    merged.set(key, current);
  }
  for (const entry of parseViewCheckboxes(event.issue.body)) {
    const key = keyOf(entry);
    const current = merged.get(key) ?? {
      oldEntry: entry,
      newEntry: entry,
      wasChecked: false,
      isChecked: false,
    };
    current.newEntry = entry;
    current.isChecked = current.isChecked || entry.checked;
    merged.set(key, current);
  }
  // 释放侧条目按"现在未勾选"归一（checked:false），配合 releaseClaimForViewEntry 的勾选守卫
  const uncheckedNow = [...merged.values()]
    .filter((view) => view.wasChecked && !view.isChecked)
    .map((view) => ({ ...view.oldEntry, checked: false }));
  const checkedNow = [...merged.values()]
    .filter((view) => view.isChecked && !view.wasChecked)
    .map((view) => view.newEntry);
  if (uncheckedNow.length === 0 && checkedNow.length === 0) {
    core.info('no view checkbox changes, skipping');
    return;
  }

  const before = JSON.stringify(state.claims);
  let released = 0;
  const reactedIds = new Set<number>();
  for (const entry of uncheckedNow) {
    for (const claim of releaseClaimForViewEntry(state, entry, ctx.now)) {
      released++;
      if (claim.commentId !== 0) reactedIds.add(claim.commentId);
    }
  }
  let created = 0;
  for (const entry of checkedNow) {
    const { entries, failures } = resolveTargets([entry.sharedPath], state);
    for (const failure of failures) {
      core.info(`view-edit claim target not resolvable: ${failure.token}`);
    }
    const application = applyClaimEntries(
      state,
      entries,
      event.sender.login,
      ctx.now.toISOString(),
      0,
      '',
    );
    created += application.created;
  }

  if (before === JSON.stringify(state.claims)) {
    core.info('view edit changed nothing, skipping writeback');
    return;
  }
  const updated = recomposeTrackerBody(ctx, event.issue.body, state);
  await ctx.api.updateIssueBody(issue.number, updated);
  for (const commentId of reactedIds) {
    await ctx.api.reactToComment(commentId, '-1');
  }
  core.info(
    `view edit reconciled: released ${released} claim(s) (${reactedIds.size} 👎 reaction(s)), claimed ${created} file(s) as ${event.sender.login}`,
  );
  await writeStepSummary(
    [
      `**✏️ View edit reconciliation (issue #${event.issue.number})**`,
      '',
      released > 0
        ? `- Released: ${released}${reactedIds.size > 0 ? ' (with 👎 on the claim comments)' : ''}`
        : null,
      created > 0 ? `- Claimed: ${created} (as @${event.sender.login})` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  );
}
