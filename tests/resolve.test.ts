import { describe, expect, it } from 'vitest';
import { fileKey, type TrackedFile, type TrackerState } from '../src/model.js';
import { resolveTargets } from '../src/resolve.js';

const files: TrackedFile[] = [
  {
    sharedPath: 'src/index.md',
    locale: 'en',
    status: 'missing',
    localizationPath: 'src/en/index.md',
  },
  {
    sharedPath: 'src/index.md',
    locale: 'ja',
    status: 'missing',
    localizationPath: 'src/ja/index.md',
  },
  {
    sharedPath: 'src/blog/index.md',
    locale: 'en',
    status: 'missing',
    localizationPath: 'src/en/blog/index.md',
  },
  {
    sharedPath: 'src/manual/canvas.md',
    locale: 'ja',
    status: 'outdated',
    localizationPath: 'src/ja/manual/canvas.md',
  },
];
const state: TrackerState = { version: 1, files, claims: [] };

describe('resolveTargets', () => {
  it('resolves a repo path with locale directory', () => {
    const { entries, failures } = resolveTargets(['src/en/index.md'], state);
    expect(failures).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('file');
    const first = entries[0]?.files[0];
    expect(first && fileKey(first.locale, first.sharedPath)).toBe('en::src/index.md');
  });

  it('resolves a locale-prefixed shorthand', () => {
    const { entries, failures } = resolveTargets(['ja/index.md'], state);
    expect(failures).toEqual([]);
    expect(entries[0]?.files[0]?.locale).toBe('ja');
  });

  it('reports ambiguity when a sharedPath spans locales without scoping', () => {
    const { entries, failures } = resolveTargets(['src/index.md'], state);
    expect(entries).toHaveLength(0);
    expect(failures).toEqual([
      {
        token: 'src/index.md',
        reason: 'ambiguous',
        candidates: ['src/index.md（en）', 'src/index.md（ja）'],
      },
    ]);
  });

  it('resolves a unique sharedPath directly', () => {
    const { entries, failures } = resolveTargets(['src/manual/canvas.md'], state);
    expect(failures).toEqual([]);
    expect(entries[0]?.files[0]?.locale).toBe('ja');
  });

  it('normalizes leading ./ and slashes', () => {
    const { entries } = resolveTargets(['./src/ja/index.md'], state);
    expect(entries[0]?.files[0]?.locale).toBe('ja');
  });

  it('resolves a bare file name when unique', () => {
    const { entries, failures } = resolveTargets(['canvas.md'], state);
    expect(failures).toEqual([]);
    expect(entries[0]?.files[0]?.sharedPath).toBe('src/manual/canvas.md');
  });

  it('reports ambiguity for a bare name that exists in multiple locales', () => {
    const { entries, failures } = resolveTargets(['index.md'], state);
    expect(entries).toHaveLength(0);
    expect(failures[0]?.reason).toBe('ambiguous');
    expect(failures[0]?.candidates).toEqual([
      'src/index.md（en）',
      'src/index.md（ja）',
      'src/blog/index.md（en）',
    ]);
  });

  it('reports unknown files', () => {
    const { failures } = resolveTargets(['src/fr/index.md'], state);
    expect(failures).toEqual([{ token: 'src/fr/index.md', reason: 'unknown', candidates: [] }]);
  });

  it('resolves repeated tokens to the same file (claim application is idempotent)', () => {
    const { entries } = resolveTargets(['src/ja/index.md', 'ja/index.md'], state);
    const targets = entries.flatMap((entry) =>
      entry.files.map((file) => fileKey(file.locale, file.sharedPath)),
    );
    expect(targets).toEqual(['ja::src/index.md', 'ja::src/index.md']);
  });

  describe('directory claims', () => {
    it('expands a directory token to the files below it', () => {
      const { entries, failures } = resolveTargets(['src/blog'], state);
      expect(failures).toEqual([]);
      expect(entries).toEqual([{ token: 'src/blog', kind: 'dir', files: [files[2]!] }]);
    });

    it('accepts a trailing slash', () => {
      const { entries } = resolveTargets(['src/manual/'], state);
      expect(entries[0]?.kind).toBe('dir');
      expect(entries[0]?.files[0]?.sharedPath).toBe('src/manual/canvas.md');
    });

    it('spans locales when files of several locales live under the dir', () => {
      const { entries } = resolveTargets(['src'], state);
      expect(entries[0]?.kind).toBe('dir');
      expect(entries[0]?.files).toHaveLength(4);
    });

    it('scopes by the locale segment in the real-path form', () => {
      const { entries } = resolveTargets(['src/ja/manual'], state);
      expect(entries[0]?.kind).toBe('dir');
      expect(entries[0]?.files.map((file) => file.locale)).toEqual(['ja']);
    });

    it('reports unknown for a non-existent directory', () => {
      const { entries, failures } = resolveTargets(['src/nope'], state);
      expect(entries).toHaveLength(0);
      expect(failures[0]?.reason).toBe('unknown');
    });
  });
});

describe('file vs directory collision', () => {
  it('reports ambiguity when a token matches both an exact file and a dir prefix', () => {
    const colliding: TrackedFile[] = [
      ...files,
      { sharedPath: 'src/blog', locale: 'en', status: 'missing' },
    ];
    const stateWithCollision: TrackerState = { version: 1, files: colliding, claims: [] };
    const { entries, failures } = resolveTargets(['src/blog'], stateWithCollision);
    expect(entries).toHaveLength(0);
    expect(failures[0]?.reason).toBe('ambiguous');
  });
});
