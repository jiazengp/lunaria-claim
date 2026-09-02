import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const ModeSchema = z.enum(['sync', 'claim', 'expire', 'link-pr']);
export type Mode = z.infer<typeof ModeSchema>;

export interface ActionInputs {
  mode: Mode;
  token: string;
  statusJsonPath: string;
  configPath: string;
  templatePath: string;
}

export const ClaimConfigSchema = z.object({
  issue: z
    .object({
      title: z.string().default('🙋 翻译认领'),
      label: z.string().default('lunaria-claim'),
      /** true 时按语言拆分子 issue（M5），默认单 issue + 超长折叠 */
      perLocale: z.boolean().default(false),
    })
    .default({ title: '🙋 翻译认领', label: 'lunaria-claim', perLocale: false }),
  /** 认领后未提交 PR 的最长保留天数 */
  ttlDays: z.number().int().positive().default(15),
  /** true 时只接受 /claim 命令；false 时评论含清单内完整路径也算认领 */
  strictClaimSyntax: z.boolean().default(false),
  /** 宽松模式下判定认领意图的关键词 */
  lenientKeywords: z.array(z.string()).default(['认领', '领取', 'claim', '我来', '接单']),
  /** 单语言区块超过该条数后用 <details> 折叠 */
  collapseThreshold: z.number().int().positive().default(30),
  dashboardUrl: z.string().optional(),
  messages: z.record(z.string(), z.string()).default({}),
});

export type ClaimConfig = z.infer<typeof ClaimConfigSchema>;

export function parseInputs(raw: Record<string, string>): ActionInputs {
  const token = raw.token || process.env.GITHUB_TOKEN || '';
  if (!token) {
    throw new Error('token is required (action input `token` or env GITHUB_TOKEN)');
  }
  return {
    mode: ModeSchema.parse(raw.mode),
    token,
    statusJsonPath: raw.statusJson || './dist/lunaria/status.json',
    configPath: raw.configPath || '.github/lunaria-claim.yml',
    templatePath: raw.templatePath || '.github/lunaria-claim.md',
  };
}

export function loadConfig(path: string): ClaimConfig {
  const raw: unknown = parseYaml(readFileSync(path, 'utf-8'));
  return ClaimConfigSchema.parse(raw ?? {});
}

export function repoFromEnv(): { owner: string; repo: string } {
  const full = process.env.GITHUB_REPOSITORY;
  if (!full?.includes('/')) {
    throw new Error('GITHUB_REPOSITORY env is not set (are you running inside a workflow?)');
  }
  const [owner, repo] = full.split('/');
  if (!owner || !repo) {
    throw new Error(`invalid GITHUB_REPOSITORY: ${full}`);
  }
  return { owner, repo };
}
