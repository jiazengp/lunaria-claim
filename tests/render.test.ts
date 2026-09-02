import { describe, expect, it } from 'vitest';
import { groupByLocale, type TrackerState } from '../src/model.js';
import { applyPlaceholders, parseViewCheckboxes, renderBody } from '../src/render.js';

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
    expect(body).toContain('- `.vitepress/`');
    expect(body).toContain('  - [ ] `.vitepress/theme.ts`');
    expect(body).toContain('- `src/`');
    expect(body).toContain('  - `manual/`');
    expect(body).toContain('    - `client/`');
    expect(body).toContain('      - [x] `src/manual/client/canvas.md` — @alice · 2026-09-01');
    expect(body).toContain('  - [ ] `src/index.md`');
  });

  it('renders a flat list when configured', () => {
    const body = renderBody(template, groupByLocale(files), state, {
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
