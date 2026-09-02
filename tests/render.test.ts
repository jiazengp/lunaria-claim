import { describe, expect, it } from 'vitest';
import { groupByLocale, type TrackerState } from '../src/model.js';
import { renderBody, renderFilesRegion } from '../src/render.js';

const template = '<!-- LUNARIA-CLAIM:FILES -->\n{{files}}\n<!-- /LUNARIA-CLAIM:FILES -->';

const files = [
  { sharedPath: 'src/index.md', locale: 'ja', status: 'missing' as const },
  { sharedPath: 'src/manual/client/canvas.md', locale: 'ja', status: 'missing' as const },
  { sharedPath: 'src/manual/faq/updater.md', locale: 'ja', status: 'outdated' as const },
  { sharedPath: '.vitepress/theme.ts', locale: 'ja', status: 'missing' as const },
];

const state: TrackerState = {
  version: 1,
  files,
  claims: [
    {
      path: 'src/manual/client/canvas.md',
      locale: 'ja',
      user: 'alice',
      claimedAt: '2026-09-01T00:00:00Z',
      commentId: 1,
      commentUrl: 'https://example.com/1',
    },
  ],
};

describe('renderFilesRegion', () => {
  it('renders a nested directory tree by default', () => {
    const body = renderBody(template, groupByLocale(files), state, {
      collapseThreshold: 30,
      fileListStyle: 'tree',
    });
    // 目录在前、文件在后，各自按名称排序；叶子保留完整 sharedPath
    expect(body).toContain('- `.vitepress/`');
    expect(body).toContain('  - [ ] `.vitepress/theme.ts`');
    expect(body).toContain('- `src/`');
    expect(body).toContain('  - `manual/`');
    expect(body).toContain('    - `client/`');
    expect(body).toContain('      - [x] `src/manual/client/canvas.md` — @alice · 2026-09-01');
    expect(body).toContain('    - `faq/`');
    expect(body).toContain('  - [ ] `src/index.md`');
  });

  it('renders a flat list when configured', () => {
    const body = renderFilesRegion(groupByLocale(files), state, {
      collapseThreshold: 30,
      fileListStyle: 'flat',
    });
    expect(body).not.toContain('- `.vitepress/`\n');
    expect(body).toContain('- [ ] `.vitepress/theme.ts`');
    expect(body).toContain('- [ ] `src/index.md`');
  });

  it('wraps the section in details when over the threshold', () => {
    const body = renderBody(template, groupByLocale(files), state, {
      collapseThreshold: 2,
      fileListStyle: 'tree',
    });
    expect(body).toContain('<details><summary>共 4 个文件待处理（点击展开）</summary>');
  });
});
