import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toTrackedFiles } from '../src/lunaria.js';
import { groupByLocale } from '../src/model.js';
import { reconcile } from '../src/reconcile.js';
import { applyPlaceholders, renderBody } from '../src/render.js';
import { resolveTargets } from '../src/resolve.js';
import { parseState, serializeState } from '../src/state.js';

/** 由一个真实 VitePress 文档仓库（zh 源语言，en/ja 目标）的实际 lunaria 配置与文件清单跑 `lunaria build` 生成 */
const status = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/real-vitepress-status.json', import.meta.url)),
    'utf-8',
  ),
) as Parameters<typeof toTrackedFiles>[0];

const template = readFileSync(
  fileURLToPath(new URL('../examples/lunaria-claim.template.md', import.meta.url)),
  'utf-8',
);

const files = toTrackedFiles(status, ['en', 'ja']);
const now = new Date('2026-09-02T00:00:00Z');
const { state } = reconcile({ version: 1, files: [], claims: [] }, files, now);

describe('real-world VitePress docs pipeline', () => {
  it('mirrors the real repository scale', () => {
    expect(status.length).toBeGreaterThanOrEqual(50);
    expect(state.files.filter((file) => file.locale === 'en').length).toBe(7);
    expect(state.files.filter((file) => file.locale === 'ja').length).toBe(10);
    // 站点配置翻译（.vitepress/locales）也被纳入清单
    expect(state.files.some((file) => file.sharedPath.startsWith('.vitepress/'))).toBe(true);
  });

  it('renders a tree body under GitHub limits and round-trips the state block', () => {
    const body = applyPlaceholders(
      renderBody(template, groupByLocale(state.files), state, {
        collapseThreshold: 30,
        fileListStyle: 'tree',
      }),
      {
        ttl_days: '15',
        dashboard_url: '',
      },
    );
    expect(body).toContain('### 🌐 en');
    expect(body).toContain('### 🌐 ja');
    // 树状：出现目录行，checkbox 行数与清单条目一致（叶子保留完整 sharedPath）
    expect(body).toContain('- `src/`');
    const checkboxCount = (body.match(/^ {0,10}- \[[ x]\]/gm) ?? []).length;
    expect(checkboxCount).toBe(state.files.length);
    expect(body.length).toBeLessThan(65536);
    expect(parseState(body)).toEqual(state);
    expect(body).toContain(serializeState(state));
  });

  it('resolves claims the way contributors actually type them', () => {
    const unique = state.files.find(
      (file) => state.files.filter((other) => other.sharedPath === file.sharedPath).length === 1,
    );
    expect(unique).toBeDefined();
    if (!unique?.localizationPath) return;
    const byRepoPath = resolveTargets([unique.localizationPath], state);
    expect(byRepoPath.failures).toEqual([]);
    expect(byRepoPath.entries[0]?.kind).toBe('file');
    expect(byRepoPath.entries[0]?.files[0]?.sharedPath).toBe(unique.sharedPath);

    const shared = state.files.find(
      (file) => state.files.filter((other) => other.sharedPath === file.sharedPath).length > 1,
    );
    if (shared) {
      const ambiguous = resolveTargets([shared.sharedPath], state);
      expect(ambiguous.entries).toHaveLength(0);
      expect(ambiguous.failures[0]?.reason).toBe('ambiguous');
      const scoped = resolveTargets([`${shared.locale}/${shared.sharedPath}`], state);
      expect(scoped.entries).toHaveLength(1);
    }
    // 目录认领：真实数据里 src/blog 下应能展开出条目
    const dir = resolveTargets(['src/blog'], state);
    expect(dir.failures).toEqual([]);
    expect(dir.entries[0]?.kind).toBe('dir');
    expect(dir.entries[0]?.files.length).toBeGreaterThan(0);
  });
});
