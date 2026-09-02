import { describe, expect, it } from 'vitest';
import { extractKnownPaths, findExpiredClaims, parseClaimComment } from '../src/claims.js';
import type { TrackerState } from '../src/model.js';

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
