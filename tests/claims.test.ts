import { describe, expect, it } from 'vitest';
import {
  applyClaimEntries,
  applyViewEdits,
  composeClaimReplies,
  extractKnownPaths,
  findExpiredClaims,
  parseClaimComment,
  rebuildClaimsFromComments,
  releaseClaimForViewEntry,
  releaseClaimsByCommentId,
} from '../src/claims.js';
import { ClaimConfigSchema } from '../src/config.js';
import type { TrackedFile, TrackerState } from '../src/model.js';

describe('parseClaimComment', () => {
  it('parses a single claim command', () => {
    expect(parseClaimComment('/claim src/ja/index.md')).toEqual([
      { kind: 'claim', paths: ['src/ja/index.md'] },
    ]);
  });

  it('parses multiple paths on one command', () => {
    expect(parseClaimComment('/claim src/ja/a.md src/ja/b.md')).toEqual([
      { kind: 'claim', paths: ['src/ja/a.md', 'src/ja/b.md'] },
    ]);
  });

  it('strips backticks and markdown link wrappers', () => {
    expect(parseClaimComment('/claim `src/ja/a.md` [src/ja/b.md](https://example.com)')).toEqual([
      { kind: 'claim', paths: ['src/ja/a.md', 'src/ja/b.md'] },
    ]);
  });

  it('supports /release and /give-up', () => {
    expect(parseClaimComment('/release src/ja/a.md')).toEqual([
      { kind: 'release', paths: ['src/ja/a.md'] },
    ]);
    expect(parseClaimComment('/give-up src/ja/a.md')).toEqual([
      { kind: 'release', paths: ['src/ja/a.md'] },
    ]);
  });

  it('ignores plain prose and unknown slash commands', () => {
    expect(parseClaimComment('我想认领这个文件，谢谢！\n/claimbot hello')).toEqual([]);
  });
});

describe('extractKnownPaths', () => {
  it('matches only whole known paths inside free text', () => {
    const known = ['src/ja/index.md', 'src/ja/manual/client.md'];
    expect(
      extractKnownPaths('我想认领 src/ja/index.md 和 src/ja/manual/client.md 谢谢', known),
    ).toEqual(known);
    expect(extractKnownPaths('src/ja/index.md.part 这种不算', known)).toEqual([]);
  });
});

describe('findExpiredClaims', () => {
  const now = new Date('2026-09-02T00:00:00Z');
  const state: TrackerState = {
    version: 1,
    files: [],
    claims: [
      {
        path: 'a',
        locale: 'ja',
        user: 'u1',
        claimedAt: '2026-08-10T00:00:00Z',
        commentId: 1,
        commentUrl: 'https://example.com/1',
      },
      {
        path: 'b',
        locale: 'ja',
        user: 'u2',
        claimedAt: '2026-08-30T00:00:00Z',
        commentId: 2,
        commentUrl: 'https://example.com/2',
      },
      {
        path: 'c',
        locale: 'ja',
        user: 'u3',
        claimedAt: '2026-08-01T00:00:00Z',
        commentId: 3,
        commentUrl: 'https://example.com/3',
        prUrl: 'https://github.com/o/r/pull/1',
      },
      {
        path: 'd',
        locale: 'ja',
        user: 'u4',
        claimedAt: '2026-08-01T00:00:00Z',
        commentId: 4,
        commentUrl: 'https://example.com/4',
        releasedAt: '2026-08-02T00:00:00Z',
      },
    ],
  };

  it('releases only overdue claims without an open PR', () => {
    expect(findExpiredClaims(state, now, 15).map((claim) => claim.path)).toEqual(['a']);
  });
});

describe('applyClaimEntries', () => {
  const files = [
    { sharedPath: 'src/manual/a.md', locale: 'ja', status: 'missing' as const },
    { sharedPath: 'src/manual/b.md', locale: 'ja', status: 'missing' as const },
  ];

  const dirEntry = {
    token: 'src/manual',
    kind: 'dir' as const,
    files,
  };

  it('claims every unclaimed file in a directory and skips others claims', () => {
    const state: TrackerState = {
      version: 1,
      files,
      claims: [
        {
          path: 'src/manual/a.md',
          locale: 'ja',
          user: 'bob',
          claimedAt: '2026-09-01T00:00:00Z',
          commentId: 1,
          commentUrl: 'https://example.com/1',
        },
      ],
    };
    const application = applyClaimEntries(
      state,
      [dirEntry],
      'alice',
      '2026-09-02T00:00:00Z',
      2,
      'https://example.com/2',
    );
    expect(application.created).toBe(1);
    expect(application.skipped).toEqual([
      { path: 'src/manual/a.md', locale: 'ja', claimer: 'bob', dir: 'src/manual' },
    ]);
    // bob 的认领未被触碰，b.md 以 alice 身份独立入账
    expect(state.claims).toHaveLength(2);
    expect(state.claims[0]?.user).toBe('bob');
    expect(state.claims[1]).toMatchObject({ user: 'alice', path: 'src/manual/b.md' });
  });

  it('is idempotent for claims already held by the same user', () => {
    const state: TrackerState = {
      version: 1,
      files,
      claims: [
        {
          path: 'src/manual/a.md',
          locale: 'ja',
          user: 'alice',
          claimedAt: '2026-09-01T00:00:00Z',
          commentId: 1,
          commentUrl: 'https://example.com/1',
        },
      ],
    };
    const application = applyClaimEntries(
      state,
      [dirEntry],
      'alice',
      '2026-09-02T00:00:00Z',
      2,
      'https://example.com/2',
    );
    expect(application.created).toBe(1); // 只有 b.md 是新的
    expect(application.skipped).toEqual([]);
    expect(state.claims).toHaveLength(2);
  });
});

const makeClaim = () => ({
  path: 'src/manual/a.md',
  locale: 'ja',
  user: 'alice',
  claimedAt: '2026-09-01T00:00:00Z',
  commentId: 1,
  commentUrl: 'https://example.com/1',
});

describe('releaseClaimsByCommentId', () => {
  const now = new Date('2026-09-03T00:00:00Z');
  const claim = (id: number, path: string) => ({
    path,
    locale: 'ja',
    user: `u${id}`,
    claimedAt: '2026-09-01T00:00:00Z',
    commentId: id,
    commentUrl: `https://example.com/${id}`,
  });

  it('releases every active claim of the comment with the given reason, leaving others alone', () => {
    const state: TrackerState = {
      version: 1,
      files: [],
      claims: [claim(1, 'a.md'), claim(1, 'b.md'), claim(2, 'c.md')],
    };
    const released = releaseClaimsByCommentId(state, 1, now, 'voluntary');
    expect(released.map((item) => item.path)).toEqual(['a.md', 'b.md']);
    expect(state.claims[0]).toMatchObject({
      releasedAt: '2026-09-03T00:00:00.000Z',
      releaseReason: 'voluntary',
    });
    expect(state.claims[1]).toMatchObject({ releaseReason: 'voluntary' });
    expect(state.claims[2]?.releasedAt).toBeUndefined();
  });

  it('returns empty for already-released or foreign claims', () => {
    const state: TrackerState = {
      version: 1,
      files: [],
      claims: [{ ...claim(1, 'a.md'), releasedAt: '2026-09-02T00:00:00Z' }],
    };
    expect(releaseClaimsByCommentId(state, 1, now, 'voluntary')).toEqual([]);
    expect(releaseClaimsByCommentId(state, 99, now, 'voluntary')).toEqual([]);
  });
});

describe('releaseClaimForViewEntry', () => {
  const now = new Date('2026-09-03T00:00:00Z');

  it('releases the claim matching a file row exactly (ja::src/manual/a.md)', () => {
    const state: TrackerState = { version: 1, files: [], claims: [makeClaim()] };
    const released = releaseClaimForViewEntry(
      state,
      { locale: 'ja', sharedPath: 'src/manual/a.md', checked: false },
      now,
    );
    expect(released).toHaveLength(1);
    expect(state.claims[0]).toMatchObject({
      releasedAt: '2026-09-03T00:00:00.000Z',
      releaseReason: 'manual',
    });
  });

  it('does nothing for a checked row', () => {
    const state: TrackerState = { version: 1, files: [], claims: [makeClaim()] };
    expect(
      releaseClaimForViewEntry(
        state,
        { locale: 'ja', sharedPath: 'src/manual/a.md', checked: true },
        now,
      ),
    ).toEqual([]);
    expect(state.claims[0]?.releasedAt).toBeUndefined();
  });

  it('releases the whole subtree for an unchecked directory row only when fully claimed', () => {
    const files = [
      { sharedPath: 'src/manual/a.md', locale: 'ja', status: 'missing' as const },
      { sharedPath: 'src/manual/b.md', locale: 'ja', status: 'missing' as const },
    ];
    // 部分认领子树：Fix D 守卫 → 目录行不是有效释放信号
    const partial: TrackerState = {
      version: 1,
      files,
      claims: [{ ...makeClaim(), path: 'src/manual/a.md' }],
    };
    expect(
      releaseClaimForViewEntry(
        partial,
        { locale: 'ja', sharedPath: 'src/manual/', checked: false },
        now,
      ),
    ).toEqual([]);
    expect(partial.claims[0]?.releasedAt).toBeUndefined();
    // 全认领子树：取消勾选目录行 = 释放全部
    const full: TrackerState = {
      version: 1,
      files,
      claims: [
        { ...makeClaim(), path: 'src/manual/a.md' },
        { ...makeClaim(), path: 'src/manual/b.md' },
      ],
    };
    const released = releaseClaimForViewEntry(
      full,
      { locale: 'ja', sharedPath: 'src/manual/', checked: false },
      now,
    );
    expect(released.map((claim) => claim.path)).toEqual(['src/manual/a.md', 'src/manual/b.md']);
  });
});

describe('applyViewEdits', () => {
  const now = new Date('2026-09-02T00:00:00Z');

  it('releases claims whose line was unchecked', () => {
    const state: TrackerState = { version: 1, files: [], claims: [makeClaim()] };
    const body = '### 🌐 ja\n\n- [ ] `src/manual/a.md`';
    expect(applyViewEdits(state, body, now)).toBe(1);
    expect(state.claims[0]?.releaseReason).toBe('manual');
    expect(state.claims[0]?.releasedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('keeps claims whose line is still checked', () => {
    const state: TrackerState = { version: 1, files: [], claims: [makeClaim()] };
    const body = '### 🌐 ja\n\n- [x] `src/manual/a.md`';
    expect(applyViewEdits(state, body, now)).toBe(0);
    expect(state.claims[0]?.releasedAt).toBeUndefined();
  });

  it('releases claims whose line was deleted entirely', () => {
    const state: TrackerState = { version: 1, files: [], claims: [makeClaim()] };
    const body = '### 🌐 ja\n\n- [ ] `src/index.md`';
    expect(applyViewEdits(state, body, now)).toBe(1);
    expect(state.claims[0]?.releaseReason).toBe('manual');
  });

  it('releases a claim whose linked row was unchecked (production shape)', () => {
    const state: TrackerState = {
      version: 1,
      files: [],
      claims: [{ ...makeClaim(), path: 'src/ja/a.md' }],
    };
    const body = '### 🌐 ja\n\n- [ ] [`src/ja/a.md`](https://github.com/o/r/edit/main/src/ja/a.md)';
    expect(applyViewEdits(state, body, now)).toBe(1);
    expect(state.claims[0]?.releaseReason).toBe('manual');
  });
});

describe('parseClaimComment boundaries', () => {
  it('only honors commands at the start of a line', () => {
    expect(parseClaimComment('我想认领 /claim src/ja/a.md')).toEqual([]);
    expect(parseClaimComment('  /claim src/ja/a.md')).toEqual([
      { kind: 'claim', paths: ['src/ja/a.md'] },
    ]);
  });

  it('is case-insensitive and strips trailing punctuation and quotes', () => {
    expect(parseClaimComment('/CLAIM src/ja/a.md')).toEqual([
      { kind: 'claim', paths: ['src/ja/a.md'] },
    ]);
    expect(parseClaimComment("/claim 'src/ja/a.md'。 src/ja/b.md，")).toEqual([
      { kind: 'claim', paths: ['src/ja/a.md', 'src/ja/b.md'] },
    ]);
  });
});

describe('extractKnownPaths special characters', () => {
  it('matches paths containing regex metacharacters like brackets', () => {
    const known = ['src/blog/[path].md', 'src/plain.md'];
    expect(extractKnownPaths('我认领 src/blog/[path].md', known)).toEqual(['src/blog/[path].md']);
  });
});

describe('findExpiredClaims boundary', () => {
  it('does not expire a claim at exactly the TTL', () => {
    const state: TrackerState = {
      version: 1,
      files: [],
      claims: [
        {
          path: 'a',
          locale: 'ja',
          user: 'u1',
          claimedAt: '2026-08-18T00:00:00Z', // 2026-09-02 的整 15 天前
          commentId: 1,
          commentUrl: 'https://example.com/1',
        },
      ],
    };
    const now = new Date('2026-09-02T00:00:00Z');
    expect(findExpiredClaims(state, now, 15)).toEqual([]);
  });
});

describe('composeClaimReplies', () => {
  const config = ClaimConfigSchema.parse({});
  const file = { sharedPath: 'src/a.md', locale: 'ja', status: 'missing' as const };

  it('maps failures to ambiguous/unknown replies', () => {
    const replies = composeClaimReplies({
      entries: [],
      failures: [
        { token: 'x', reason: 'unknown', candidates: [] },
        { token: 'y', reason: 'ambiguous', candidates: ['src/a.md（ja）', 'src/b.md（en）'] },
      ],
      skipped: [],
      config,
    });
    expect(replies[0]).toContain('x');
    expect(replies[1]).toContain('y');
    expect(replies[1]).toContain('src/a.md（ja）');
  });

  it('keeps single-file duplicates as individual replies', () => {
    const replies = composeClaimReplies({
      entries: [],
      failures: [],
      skipped: [{ path: 'src/a.md', locale: 'ja', claimer: 'bob', dir: undefined }],
      config,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('@bob');
    expect(replies[0]).toContain('src/a.md');
  });

  it('aggregates directory skips with claimed count', () => {
    const files = [{ ...file }, { ...file }, { ...file }, { ...file }, { ...file }];
    const replies = composeClaimReplies({
      entries: [{ token: 'src/manual', kind: 'dir', files }],
      failures: [],
      skipped: [
        { path: 'src/a.md', locale: 'ja', claimer: 'bob', dir: 'src/manual' },
        { path: 'src/b.md', locale: 'ja', claimer: 'carol', dir: 'src/manual' },
      ],
      config,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('src/manual');
    expect(replies[0]).toContain('认领 3 个文件');
    expect(replies[0]).toContain('@bob');
    expect(replies[0]).toContain('@carol');
    expect(replies[0]).not.toContain('等 ');
  });

  it('truncates long directory skip lists with 等 N 个', () => {
    const files = [{ ...file }, { ...file }, { ...file }, { ...file }];
    const skipped = [0, 1, 2, 3].map((i) => ({
      path: `src/${i}.md`,
      locale: 'ja',
      claimer: `u${i}`,
      dir: 'src/manual',
    }));
    const replies = composeClaimReplies({
      entries: [{ token: 'src/manual', kind: 'dir', files }],
      failures: [],
      skipped,
      config,
    });
    expect(replies[0]).toContain('等 4 个');
    expect(replies[0]).toContain('认领 0 个文件');
  });
});

describe('applyViewEdits cross-locale', () => {
  it('scopes lines to their language heading — a ja claim escaped by an en line is released', () => {
    const state: TrackerState = {
      version: 1,
      files: [],
      claims: [makeClaim()], // ja::src/manual/a.md
    };
    const body = '### 🌐 en\n\n- [x] `src/manual/a.md`';
    expect(applyViewEdits(state, body, new Date('2026-09-02T00:00:00Z'))).toBe(1);
    expect(state.claims[0]?.releaseReason).toBe('manual');
  });
});

describe('rebuildClaimsFromComments', () => {
  const config = ClaimConfigSchema.parse({});
  const files: TrackedFile[] = [
    { sharedPath: 'src/index.md', locale: 'en', status: 'missing' },
    { sharedPath: 'src/index.md', locale: 'ja', status: 'missing' },
    { sharedPath: 'src/blog/faq.md', locale: 'ja', status: 'missing' },
  ];
  const comment = (id: number, user: string, body: string, createdAt = '2026-09-01T00:00:00Z') => ({
    id,
    user,
    createdAt,
    htmlUrl: `https://example.com/${id}`,
    body,
  });

  it('reconstructs an active claim with author and timestamps', () => {
    const { claims, skippedBot } = rebuildClaimsFromComments(
      [comment(5, 'alice', '/claim src/blog/faq.md')],
      files,
      config,
    );
    expect(skippedBot).toBe(0);
    expect(claims).toEqual([
      {
        path: 'src/blog/faq.md',
        locale: 'ja',
        user: 'alice',
        claimedAt: '2026-09-01T00:00:00Z',
        commentId: 5,
        commentUrl: 'https://example.com/5',
      },
    ]);
  });

  it('ignores bot comments and counts them', () => {
    const { claims, skippedBot } = rebuildClaimsFromComments(
      [comment(1, 'github-actions[bot]', '/claim src/blog/faq.md')],
      files,
      config,
    );
    expect(claims).toEqual([]);
    expect(skippedBot).toBe(1);
  });

  it('applies a later release command in comment order', () => {
    const { claims } = rebuildClaimsFromComments(
      [
        comment(1, 'alice', '/claim src/blog/faq.md'),
        comment(2, 'alice', '/release src/blog/faq.md', '2026-09-02T00:00:00Z'),
      ],
      files,
      config,
    );
    expect(claims).toEqual([]);
  });

  it('keeps a claim when the release predates it', () => {
    const { claims } = rebuildClaimsFromComments(
      [
        comment(1, 'alice', '/release src/blog/faq.md', '2026-08-30T00:00:00Z'),
        comment(2, 'alice', '/claim src/blog/faq.md', '2026-09-01T00:00:00Z'),
      ],
      files,
      config,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.commentId).toBe(2);
  });

  it('expands directory commands', () => {
    const { claims } = rebuildClaimsFromComments(
      [comment(1, 'alice', '/claim src/blog')],
      files,
      config,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.path).toBe('src/blog/faq.md');
  });

  it('skips ambiguous paths that span locales', () => {
    const { claims } = rebuildClaimsFromComments(
      [comment(1, 'alice', '/claim src/index.md')],
      files,
      config,
    );
    expect(claims).toEqual([]);
  });

  it('reconstructs lenient-mode claims only when intent words are present', () => {
    const freeText = '我来认领 src/blog/faq.md';
    const lenient = rebuildClaimsFromComments([comment(1, 'alice', freeText)], files, config);
    expect(lenient.claims).toHaveLength(1);

    const strict = rebuildClaimsFromComments([comment(1, 'alice', freeText)], files, {
      ...config,
      strictClaimSyntax: true,
    });
    expect(strict.claims).toEqual([]);
  });
});

describe('rebuildClaimsFromComments directory release', () => {
  it('a directory release cancels every claim expanded under it', () => {
    const files: TrackedFile[] = [
      { sharedPath: 'src/blog/a.md', locale: 'ja', status: 'missing' },
      { sharedPath: 'src/blog/b.md', locale: 'ja', status: 'missing' },
    ];
    const comment = (id: number, user: string, body: string, createdAt: string) => ({
      id,
      user,
      createdAt,
      htmlUrl: `https://example.com/${id}`,
      body,
    });
    const { claims } = rebuildClaimsFromComments(
      [
        comment(1, 'alice', '/claim src/blog', '2026-09-01T00:00:00Z'),
        comment(2, 'alice', '/release src/blog', '2026-09-02T00:00:00Z'),
      ],
      files,
      ClaimConfigSchema.parse({}),
    );
    expect(claims).toEqual([]);
  });
});

describe('applyViewEdits directory line', () => {
  it('releases every claim under an unchecked directory', () => {
    const state: TrackerState = {
      version: 1,
      files: [
        { sharedPath: 'src/manual/a.md', locale: 'ja', status: 'missing' },
        { sharedPath: 'src/manual/b.md', locale: 'ja', status: 'missing' },
      ],
      claims: [
        { ...makeClaim(), path: 'src/manual/a.md' },
        { ...makeClaim(), path: 'src/manual/b.md' },
        { ...makeClaim(), path: 'src/other.md' },
      ],
    };
    const body =
      '### 🌐 ja\n\n- [ ] `src/manual/`\n- [x] `src/manual/a.md`\n- [x] `src/manual/b.md`\n- [x] `src/other.md`';
    expect(applyViewEdits(state, body, new Date('2026-09-02T00:00:00Z'))).toBe(2);
    expect(state.claims.filter((claim) => claim.releaseReason === 'manual')).toHaveLength(2);
    expect(state.claims[2]?.releaseReason).toBeUndefined();
  });

  it('an unchecked dir row is ignored while the subtree is only partially claimed', () => {
    const state: TrackerState = {
      version: 1,
      files: [
        { sharedPath: 'src/manual/a.md', locale: 'ja', status: 'missing' },
        { sharedPath: 'src/manual/b.md', locale: 'ja', status: 'missing' },
      ],
      claims: [{ ...makeClaim(), path: 'src/manual/a.md' }],
    };
    const body =
      '### 🌐 ja\n\n- [ ] `src/manual/`\n- [x] `src/manual/a.md`\n- [ ] `src/manual/b.md`';
    expect(applyViewEdits(state, body, new Date('2026-09-02T00:00:00Z'))).toBe(0);
    expect(state.claims[0]?.releaseReason).toBeUndefined();
  });

  it('a nested dir row (full path rebuilt from indentation) releases its subtree claim (plan 007)', () => {
    const state: TrackerState = {
      version: 1,
      files: [
        {
          sharedPath: 'src/ja/a.md',
          locale: 'ja',
          status: 'missing',
          localizationPath: 'src/ja/a.md',
        },
        {
          sharedPath: 'src/ko/b.md',
          locale: 'ko',
          status: 'missing',
          localizationPath: 'src/ko/b.md',
        },
      ],
      claims: [{ ...makeClaim(), path: 'src/ja/a.md' }],
    };
    const body = `- [ ] \`src/\`
  - [ ] \`ja/\`
    - [x] \`src/ja/a.md\`
  - [ ] \`ko/\`
    - [ ] \`src/ko/b.md\``;
    // `ja/` 行重建为 `src/ja/`：子树全认领 → 取消勾选释放 ja 认领；
    // `src/` 行的子树含未认领的 ko 文件（未全认领）→ 忽略；`src/ko/` 无认领 → 忽略
    expect(applyViewEdits(state, body, new Date('2026-09-02T00:00:00Z'))).toBe(1);
    expect(state.claims[0]).toMatchObject({ releaseReason: 'manual' });
  });
});

describe('applyViewEdits heading-less template', () => {
  it('falls back to path-only matching across locales', () => {
    const state: TrackerState = {
      version: 1,
      files: [],
      claims: [
        { ...makeClaim(), locale: 'en' },
        { ...makeClaim(), locale: 'ja' },
        { ...makeClaim(), path: 'src/other.md' },
      ],
    };
    const body = '- [ ] `src/manual/a.md`\n- [x] `src/other.md`';
    expect(applyViewEdits(state, body, new Date('2026-09-02T00:00:00Z'))).toBe(2);
    expect(state.claims.filter((claim) => claim.releaseReason === 'manual')).toHaveLength(2);
  });
});
