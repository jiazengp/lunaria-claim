import { existsSync, readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { readLunariaStatus, toTrackedFiles } from '../lunaria.js';
import { groupByLocale, type TrackerState } from '../model.js';
import { reconcile } from '../reconcile.js';
import { applyPlaceholders, renderBody, renderOptions } from '../render.js';
import { parseState } from '../state.js';
import type { ModeContext } from './index.js';

export async function runSync(ctx: ModeContext): Promise<void> {
  const { statusJsonPath, templatePath } = ctx.inputs;
  if (!existsSync(statusJsonPath)) {
    throw new Error(`status.json not found at ${statusJsonPath} — run \`lunaria build\` first`);
  }
  const template = readFileSync(templatePath, 'utf-8');
  const status = readLunariaStatus(statusJsonPath);
  const locales = [...new Set(status.flatMap((item) => Object.keys(item.localizations)))];
  const desiredFiles = toTrackedFiles(status, locales);
  core.info(
    `lunaria status: ${status.length} shared paths, ${desiredFiles.length} entries needing translation`,
  );

  const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
  if (!issue) {
    const state: TrackerState = { version: 1, files: desiredFiles, claims: [] };
    const body = applyPlaceholders(
      renderBody(template, groupByLocale(desiredFiles), state, renderOptions(ctx.config)),
      {
        ttl_days: String(ctx.config.ttlDays),
        dashboard_url: ctx.config.dashboardUrl ?? '',
      },
    );
    const number = await ctx.api.createIssue({
      title: ctx.config.issue.title,
      body,
      labels: [ctx.config.issue.label],
    });
    core.info(`created tracker issue #${number}`);
    return;
  }

  const current = parseState(issue.body ?? '');
  if (!current) {
    throw new Error(`tracker issue #${issue.number} has no readable state block`);
  }
  const { state, sections, changed } = reconcile(current, desiredFiles, ctx.now);
  if (!changed) {
    core.info(`tracker issue #${issue.number} is up to date`);
    return;
  }
  const body = renderBody(issue.body ?? template, sections, state, renderOptions(ctx.config));
  await ctx.api.updateIssueBody(issue.number, body);
  core.info(`updated tracker issue #${issue.number}`);
}
