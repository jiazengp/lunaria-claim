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
    sharedPath: 'src/manual/canvas.md',
    locale: 'ja',
    status: 'outdated',
    localizationPath: 'src/ja/manual/canvas.md',
  },
];
const state: TrackerState = { version: 1, files, claims: [] };

describe('resolveTargets', () => {
  it('resolves a repo path with locale directory', () => {
    const { resolved, failures } = resolveTargets(['src/en/index.md'], state);
    expect(failures).toEqual([]);
    expect(resolved).toHaveLength(1);
    const first = resolved[0];
    expect(first && fileKey(first.locale, first.sharedPath)).toBe('en::src/index.md');
  });

  it('resolves a locale-prefixed shorthand', () => {
    const { resolved, failures } = resolveTargets(['ja/index.md'], state);
    expect(failures).toEqual([]);
    expect(resolved[0]?.locale).toBe('ja');
  });

  it('reports ambiguity when a sharedPath spans locales without scoping', () => {
    const { failures } = resolveTargets(['src/index.md'], state);
    expect(failures).toEqual([
      {
        token: 'src/index.md',
        reason: 'ambiguous',
        candidates: ['src/index.md（en）', 'src/index.md（ja）'],
      },
    ]);
  });

  it('resolves unique sharedPath directly', () => {
    const { resolved, failures } = resolveTargets(['src/manual/canvas.md'], state);
    expect(failures).toEqual([]);
    expect(resolved[0]?.locale).toBe('ja');
  });

  it('normalizes leading ./ and slashes', () => {
    const { resolved } = resolveTargets(['./src/ja/index.md'], state);
    expect(resolved[0]?.locale).toBe('ja');
  });

  it('reports unknown files', () => {
    const { failures } = resolveTargets(['src/fr/index.md'], state);
    expect(failures).toEqual([{ token: 'src/fr/index.md', reason: 'unknown', candidates: [] }]);
  });

  it('dedupes repeated tokens', () => {
    const { resolved } = resolveTargets(['src/ja/index.md', 'ja/index.md'], state);
    expect(resolved).toHaveLength(1);
  });
});
