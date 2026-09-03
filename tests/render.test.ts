import { describe, expect, it } from 'vitest';
import { groupByLocale, type TrackerState } from '../src/model.js';
import {
  applyPlaceholders,
  parseViewCheckboxes,
  recomposeBody,
  renderBody,
} from '../src/render.js';

const STATE = '<!-- LUNARIA-CLAIM:STATE v1 -->\n{}\n<!-- /LUNARIA-CLAIM:STATE -->';
const template = `${STATE}\n\n<!-- LUNARIA-CLAIM:FILES -->\n{{files}}\n<!-- /LUNARIA-CLAIM:FILES -->`;

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

const options = { collapseThreshold: 30, fileListStyle: 'tree' as const };

describe('renderBody', () => {
  it('renders a nested directory tree for the global {{files}} placeholder', () => {
    const body = renderBody(template, groupByLocale(files), state, options);
    expect(body).toContain('- [ ] `.vitepress/`');
    expect(body).toContain('  - [ ] `.vitepress/theme.ts`');
    expect(body).toContain('- [ ] `src/`');
    expect(body).toContain('  - [ ] `manual/`');
    expect(body).toContain('    - [x] `client/`');
    expect(body).toContain('      - [x] `src/manual/client/canvas.md` — @alice · 2026-09-01');
    expect(body).toContain('    - [ ] `faq/`');
    expect(body).toContain('  - [ ] `src/index.md`');
  });

  it('renders a flat list when configured', () => {
    const body = renderBody(template, groupByLocale(files), state, {
      collapseThreshold: 30,
      fileListStyle: 'flat',
    });
    expect(body).not.toContain('- [ ] `.vitepress/`');
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

  it('replaces each language placeholder in place', () => {
    const multi = [
      { sharedPath: 'a.md', locale: 'en', status: 'missing' as const },
      { sharedPath: 'b.md', locale: 'en', status: 'missing' as const },
      { sharedPath: 'c.md', locale: 'ja', status: 'missing' as const },
    ];
    const scattered = `${STATE}\n\n## 日本語\n\n{{files_ja}}\n\n---\n\n## English\n\n{{files_en}}`;
    const body = renderBody(scattered, groupByLocale(multi), state, options);
    const jaSlot = body.slice(body.indexOf('## 日本語'), body.indexOf('---'));
    const enSlot = body.slice(body.indexOf('## English'));
    expect(jaSlot).toContain('`c.md`');
    expect(jaSlot).not.toContain('`a.md`');
    expect(enSlot).toContain('`a.md`');
    expect(enSlot).toContain('`b.md`');
    expect(enSlot).not.toContain('`c.md`');
  });

  it('keeps placeholders for locales with nothing to translate (or typos)', () => {
    const body = renderBody(`${STATE}\n\n{{files_fr}}`, groupByLocale(files), state, options);
    expect(body).toContain('{{files_fr}}');
  });

  it('does not expand placeholders inside HTML comments', () => {
    const body = renderBody(
      `${STATE}\n\n<!-- 示例：{{files_ja}} -->\n\n{{files}}`,
      groupByLocale(files),
      state,
      options,
    );
    expect(body).toContain('<!-- 示例：{{files_ja}} -->');
  });

  it('throws when the state markers are missing', () => {
    expect(() => renderBody('{{files}}', groupByLocale(files), state, options)).toThrow(
      'LUNARIA-CLAIM:STATE',
    );
  });

  it('throws when no file placeholder is present', () => {
    expect(() => renderBody(STATE, groupByLocale(files), state, options)).toThrow(
      '{{files}} or a {{files_<lang>}}',
    );
  });
});

describe('parseViewCheckboxes', () => {
  it('parses checkbox states with locale context from headings', () => {
    const body = `### 🌐 ja

- \`manual/\`
  - [x] \`src/manual/client/canvas.md\` — @alice · 2026-09-01
- [ ] \`src/index.md\`

### 🌐 en

- [x] \`src/en/foo.md\`

标题下面这段没有新标题，按"最近的上方标题"归入 en：
- [ ] \`src/orphan.md\``;
    expect(parseViewCheckboxes(body)).toEqual([
      { locale: 'ja', sharedPath: 'src/manual/client/canvas.md', checked: true },
      { locale: 'ja', sharedPath: 'src/index.md', checked: false },
      { locale: 'en', sharedPath: 'src/en/foo.md', checked: true },
      { locale: 'en', sharedPath: 'src/orphan.md', checked: false },
    ]);
  });
});

describe('render boundaries', () => {
  it('does not wrap when file count equals the threshold', () => {
    const body = renderBody(template, groupByLocale(files), state, {
      collapseThreshold: 4,
      fileListStyle: 'tree',
    });
    expect(body).not.toContain('<details>');
  });

  it('keeps placeholders inside comments untouched for applyPlaceholders too', () => {
    const out = applyPlaceholders('<!-- {{ttl_days}} -->\n{{ttl_days}}', { ttl_days: '15' });
    expect(out).toBe('<!-- {{ttl_days}} -->\n15');
  });

  it('treats case-mismatched placeholders as missing (throws)', () => {
    expect(() =>
      renderBody(`${STATE}\n\n{{Files_Ja}}`, groupByLocale(files), state, options),
    ).toThrow('{{files}} or a {{files_<lang>}} placeholder');
  });
});

describe('parseViewCheckboxes edges', () => {
  it('parses deep indentation, uppercase marks and details-wrapped lines', () => {
    const body = `<details><summary>展开</summary>

### 🌐 ja

        - [X] \`src/deep/a.md\`
      - [x] \`src/deep/b.md\`
  - [ ] \`src/root.md\`
</details>`;
    expect(parseViewCheckboxes(body)).toEqual([
      { locale: 'ja', sharedPath: 'src/deep/a.md', checked: true },
      { locale: 'ja', sharedPath: 'src/deep/b.md', checked: true },
      { locale: 'ja', sharedPath: 'src/root.md', checked: false },
    ]);
  });
});

describe('renderBody links', () => {
  const linkedFiles = [
    {
      sharedPath: 'src/missing.md',
      locale: 'ja',
      status: 'missing' as const,
      localizationPath: 'src/ja/missing.md',
      sourceUrl: 'https://github.com/o/r/blob/main/src/zh/missing.md',
      sourceHistoryUrl: 'https://github.com/o/r/commits/main/src/zh/missing.md',
    },
    {
      sharedPath: 'src/stale.md',
      locale: 'ja',
      status: 'outdated' as const,
      localizationPath: 'src/ja/stale.md',
      sourceUrl: 'https://github.com/o/r/blob/main/src/zh/stale.md',
      sourceHistoryUrl: 'https://github.com/o/r/commits/main/src/zh/stale.md',
    },
  ];
  const linkedOptions = {
    collapseThreshold: 30,
    fileListStyle: 'flat' as const,
    repoUrl: 'https://github.com/o/r',
    branch: 'main',
  };

  it('links unclaimed files to source and history, with a Create file link for missing ones', () => {
    const body = renderBody(
      `${STATE}\n\n{{files}}`,
      groupByLocale(linkedFiles),
      { version: 1, files: linkedFiles, claims: [] },
      linkedOptions,
    );
    expect(body).toContain(
      '[`src/ja/missing.md`](https://github.com/o/r/new/main?filename=src/ja/missing.md)',
    );
    expect(body).toContain(
      '[Create file](https://github.com/o/r/new/main?filename=src/ja/missing.md)',
    );
    expect(body).toContain('[`src/ja/stale.md`](https://github.com/o/r/edit/main/src/ja/stale.md)');
    expect(body).toContain('[source](https://github.com/o/r/blob/main/src/zh/missing.md)');
    expect(body).toContain('[history](https://github.com/o/r/commits/main/src/zh/missing.md)');
    expect(body).not.toContain('Create file)`');
  });

  it('keeps claimed lines compact but path still clickable', () => {
    const body = renderBody(
      `${STATE}\n\n{{files}}`,
      groupByLocale(linkedFiles),
      {
        version: 1,
        files: linkedFiles,
        claims: [
          {
            path: 'src/missing.md',
            locale: 'ja',
            user: 'alice',
            claimedAt: '2026-09-01T00:00:00Z',
            commentId: 1,
            commentUrl: 'https://example.com/1',
          },
        ],
      },
      linkedOptions,
    );
    expect(body).toContain(
      '[`src/ja/missing.md`](https://github.com/o/r/new/main?filename=src/ja/missing.md) — @alice · 2026-09-01',
    );
    expect(body).not.toContain('[source](https://github.com/o/r/blob/main/src/zh/missing.md)');
  });
});

describe('done rows', () => {
  it('renders completed files as checked without a claimer, with an edit link', () => {
    const doneFile = {
      sharedPath: 'src/done.md',
      locale: 'ja',
      status: 'done' as const,
      localizationPath: 'src/ja/done.md',
      sourceUrl: 'https://github.com/o/r/blob/main/src/zh/done.md',
    };
    const body = renderBody(
      `${STATE}\n\n{{files}}`,
      groupByLocale([doneFile]),
      { version: 1, files: [doneFile], claims: [] },
      {
        collapseThreshold: 30,
        fileListStyle: 'flat',
        repoUrl: 'https://github.com/o/r',
        branch: 'main',
      },
    );
    expect(body).toContain(
      '- [x] [`src/ja/done.md`](https://github.com/o/r/edit/main/src/ja/done.md)',
    );
    expect(body).not.toContain(' — @');
  });
});

describe('rendered body updates (issue #2 regression)', () => {
  const newFiles = [
    { sharedPath: 'src/index.md', locale: 'ja', status: 'missing' as const },
    { sharedPath: 'src/manual/canvas.md', locale: 'ja', status: 'missing' as const },
  ];

  it('overlays regions in place and preserves text outside the markers', () => {
    const legacyBody = [
      '手写头部',
      '',
      '<!-- LUNARIA-CLAIM:FILES -->',
      '- [ ] `src/old.md`',
      '',
      '<!-- LUNARIA-CLAIM:STATE v1 -->',
      '{"version":1,"files":[],"claims":[]}',
      '<!-- /LUNARIA-CLAIM:STATE -->',
      '<!-- /LUNARIA-CLAIM:FILES -->',
      '',
      '手写尾部',
    ].join('\n');
    const out = renderBody(
      legacyBody,
      groupByLocale(newFiles),
      {
        version: 1,
        files: newFiles,
        claims: [],
      },
      { collapseThreshold: 30, fileListStyle: 'flat' },
    );
    expect(out).toContain('手写头部');
    expect(out).toContain('手写尾部');
    expect(out).not.toContain('src/old.md');
    expect(out).toContain('- [ ] `src/index.md`');
    expect(out).toContain('- [ ] `src/manual/canvas.md`');
    // 状态块换成了注释包裹的新格式
    expect(out).toContain('<!-- LUNARIA-CLAIM:STATE v1 -->\n<!--\n');
  });

  it('recomposeBody falls back to the template when the body cannot be overlaid', () => {
    const body = `${STATE}`; // 只有状态区，无占位符也无 FILES 标记
    const template = `${STATE}\n\nmarker\n{{files}}\n/marker`;
    const out = recomposeBody(
      body,
      template,
      groupByLocale(newFiles),
      { version: 1, files: newFiles, claims: [] },
      { ttl_days: '15', dashboard_url: '' },
      { collapseThreshold: 30, fileListStyle: 'flat' },
    );
    expect(out).toContain('marker');
    expect(out).toContain('- [ ] `src/index.md`');
  });
});

describe('docs #555 layout (per-locale placeholders inside their own FILES markers)', () => {
  it('rebuilds from the template: one list per locale, hidden state, no stale duplicates', () => {
    const template = [
      '## 翻译认领',
      '',
      '### English',
      '<!-- LUNARIA-CLAIM:FILES -->',
      '{{files_en}}',
      '<!-- /LUNARIA-CLAIM:FILES -->',
      '',
      '### 日本語',
      '<!-- LUNARIA-CLAIM:FILES -->',
      '{{files_ja}}',
      '<!-- /LUNARIA-CLAIM:FILES -->',
      '',
      '<!-- LUNARIA-CLAIM:STATE v1 -->',
      '{}',
      '<!-- /LUNARIA-CLAIM:STATE -->',
    ].join('\n');
    // 模拟 v1.1 时代的陈旧渲染正文：占位符已被消费、尾部残留可见 JSON 状态块
    const staleBody = [
      '## 翻译认领',
      '',
      '### English',
      '<!-- LUNARIA-CLAIM:FILES -->',
      '- [ ] `src/agreement.md`',
      '<!-- /LUNARIA-CLAIM:FILES -->',
      '',
      '### 日本語',
      '<!-- LUNARIA-CLAIM:FILES -->',
      '- [ ] `src/callback.md`',
      '<!-- /LUNARIA-CLAIM:FILES -->',
      '',
      '<!-- LUNARIA-CLAIM:STATE v1 -->',
      '{"version":1,"files":[],"claims":[]}',
      '<!-- /LUNARIA-CLAIM:STATE -->',
      '',
      '<!-- LUNARIA-CLAIM:STATE v1 -->',
      '{"version":1,"files":[],"claims":[]}',
      '<!-- /LUNARIA-CLAIM:STATE -->',
    ].join('\n');
    const files = [
      {
        sharedPath: 'src/agreement.md',
        locale: 'en',
        status: 'missing' as const,
        localizationPath: 'src/en/agreement.md',
      },
      {
        sharedPath: 'src/callback.md',
        locale: 'ja',
        status: 'missing' as const,
        localizationPath: 'src/ja/callback.md',
      },
    ];
    const out = recomposeBody(
      staleBody,
      template,
      groupByLocale(files),
      { version: 1, files, claims: [] },
      { ttl_days: '15', dashboard_url: '' },
      { collapseThreshold: 30, fileListStyle: 'flat' },
    );
    // 每个语言恰好一个清单
    expect(out.match(/- \[ \] `[^`]+`/g)).toHaveLength(2);
    expect(out).toContain('- [ ] `src/en/agreement.md`');
    expect(out).toContain('- [ ] `src/ja/callback.md`');
    // 状态块只剩一套（open 标记唯一），JSON 包裹在注释内（正文隐藏、字符串存在）
    expect(out.match(/LUNARIA-CLAIM:STATE v1 -->/g)).toHaveLength(1);
    expect(out).toContain('<!--\n{"version":');
    expect(out).not.toContain('-->{"version":');
  });
});
