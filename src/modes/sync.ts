import { existsSync, readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { applyViewEdits, type RawComment, rebuildClaimsFromComments } from '../claims.js';
import { readLunariaStatus, toTrackedFiles } from '../lunaria.js';
import { groupByLocale, type TrackedFile, type TrackerState } from '../model.js';
import { reconcile } from '../reconcile.js';
import { applyPlaceholders, renderBody, renderOptions } from '../render.js';
import { parseState } from '../state.js';
import { type ModeContext, writeStepSummary } from './index.js';

export async function runSync(ctx: ModeContext): Promise<void> {
  const { statusJsonPath, dryRun } = ctx.inputs;
  if (!existsSync(statusJsonPath)) {
    throw new Error(
      `status.json not found at ${statusJsonPath} — check the \`outDir\` in lunaria.config.json; ` +
        `status.json lives under your outDir (the default './dist/lunaria/status.json' is only an example).`,
    );
  }
  const template = readFileSync(ctx.config.templatePath, 'utf-8');
  const status = readLunariaStatus(statusJsonPath);
  const locales = [...new Set(status.flatMap((item) => Object.keys(item.localizations)))];
  const desiredFiles = toTrackedFiles(status, locales);
  core.info(
    `lunaria status: ${status.length} shared paths, ${desiredFiles.length} entries needing translation`,
  );

  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);

  let current: TrackerState;
  let baseBody: string;
  let rebuiltClaims = 0;
  if (!issue) {
    current = { version: 1, files: desiredFiles, claims: [] };
    baseBody = template;
  } else {
    baseBody = issue.body ?? template;
    const parsed = parseState(baseBody);
    if (parsed) {
      current = parsed;
    } else {
      current = await rebuildTrackerState(ctx, issue.number, desiredFiles);
      rebuiltClaims = current.claims.length;
    }
  }

  const releasedByView = applyViewEdits(current, baseBody, ctx.now);
  const { state, sections, changed } = reconcile(current, desiredFiles, ctx.now);
  const rendered = applyPlaceholders(
    renderBody(baseBody, sections, state, renderOptions(ctx.config)),
    {
      ttl_days: String(ctx.config.ttlDays),
      dashboard_url: ctx.config.dashboardUrl ?? '',
    },
  );

  if (dryRun) {
    await writeSyncSummary(ctx, state, rendered, {
      preview: true,
      issueNumber: issue?.number ?? null,
      rebuiltClaims,
      releasedByView,
    });
    return;
  }

  if (!issue) {
    const number = await ctx.api.createIssue({
      title: ctx.config.issue.title,
      body: rendered,
      labels: [ctx.config.issue.label],
    });
    core.setOutput(
      'issue-url',
      `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/issues/${number}`,
    );
    await writeSyncSummary(ctx, state, rendered, {
      preview: false,
      issueNumber: number,
      rebuiltClaims,
      releasedByView,
    });
    return;
  }
  if (!changed && rebuiltClaims === 0) {
    core.info(`tracker issue #${issue.number} is up to date`);
    core.setOutput(
      'issue-url',
      `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/issues/${issue.number}`,
    );
    return;
  }
  await ctx.api.updateIssueBody(issue.number, rendered);
  core.setOutput(
    'issue-url',
    `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/issues/${issue.number}`,
  );
  await writeSyncSummary(ctx, state, rendered, {
    preview: false,
    issueNumber: issue.number,
    rebuiltClaims,
    releasedByView,
  });
}

/** 状态块损坏时的自愈：从认领评论回放重建，并告知 contributors 重建结果 */
async function rebuildTrackerState(
  ctx: ModeContext,
  issueNumber: number,
  files: TrackedFile[],
): Promise<TrackerState> {
  core.warning(
    `tracker issue #${issueNumber} state block is unreadable — rebuilding from claim comments`,
  );
  const comments: RawComment[] = await ctx.api.listComments(issueNumber);
  const { claims, skippedBot } = rebuildClaimsFromComments(comments, files, ctx.config);
  await ctx.api.addComment(
    issueNumber,
    `♻️ The tracker state block was unreadable — ${claims.length} active claim(s) rebuilt from claim comments` +
      (skippedBot > 0 ? ` (${skippedBot} bot comment(s) ignored)` : '') +
      '. Please re-claim if anything is missing.',
  );
  return { version: 1, files, claims };
}

async function writeSyncSummary(
  ctx: ModeContext,
  state: TrackerState,
  rendered: string,
  info: {
    preview: boolean;
    issueNumber: number | null;
    rebuiltClaims: number;
    releasedByView: number;
  },
): Promise<void> {
  const heading = info.preview
    ? '🔍 Template preview (dry-run — nothing was written)'
    : '🤖 Tracker board updated';
  let body = `**${heading}**\n\n`;
  if (info.preview) {
    body += '```markdown\n';
    body +=
      rendered.length > 12000 ? `${rendered.slice(0, 12000)}\n…(preview truncated)` : rendered;
    body += '\n```\n\n';
  } else {
    body += `- Tracker issue: ${info.issueNumber ?? 'not found'}\n`;
    body += `- Entries needing translation: ${state.files.length}\n`;
  }
  const notes: string[] = [];
  if (info.releasedByView > 0) {
    notes.push(`admin unchecked ${info.releasedByView} line(s), released`);
  }
  if (info.rebuiltClaims > 0) {
    notes.push(`state block corrupted, rebuilt ${info.rebuiltClaims} claim(s) from comments`);
  }
  if (notes.length > 0) body += `- ${notes.join('; ')}\n`;
  await writeStepSummary(body);
}
