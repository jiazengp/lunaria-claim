import { describe, expect, it } from 'vitest';
import { groupByLocale } from '../src/model.js';
import { reconcile } from '../src/reconcile.js';

const now = new Date('2026-09-02T00:00:00Z');

const baseState = {
  version: 1 as const,
  files: [{ sharedPath: 'a', locale: 'ja', status: 'missing' as const }],
  claims: [
    {
      path: 'a',
      locale: 'ja',
      user: 'u1',
      claimedAt: '2026-08-01T00:00:00Z',
      commentId: 1,
      commentUrl: 'https://example.com/1',
    },
  ],
};

describe('reconcile', () => {
  it('keeps claims for files still on the wanted list', () => {
    const { state, changed } = reconcile(baseState, baseState.files, now);
    expect(state.claims).toEqual(baseState.claims);
    expect(changed).toBe(false);
  });

  it('releases claims as completed when the file leaves the wanted list', () => {
    const { state, changed } = reconcile(baseState, [], now);
    expect(state.claims[0]?.releaseReason).toBe('completed');
    expect(state.claims[0]?.releasedAt).toBe('2026-09-02T00:00:00.000Z');
    expect(changed).toBe(true);
  });

  it('groups desired files by locale', () => {
    const { sections } = reconcile(
      baseState,
      [...baseState.files, { sharedPath: 'b', locale: 'ko', status: 'missing' }],
      now,
    );
    expect(sections.map((section) => section.locale)).toEqual(['ja', 'ko']);
    expect(groupByLocale([])).toEqual([]);
  });
});

describe('reconcile change detection', () => {
  it('flags changes when new files appear', () => {
    const { changed } = reconcile(
      baseState,
      [...baseState.files, { sharedPath: 'c', locale: 'ko', status: 'missing' }],
      now,
    );
    expect(changed).toBe(true);
  });

  it("flags changes when a file's status shifts to outdated", () => {
    const shifted = baseState.files.map((file) => ({ ...file, status: 'outdated' as const }));
    const { changed } = reconcile(baseState, shifted, now);
    expect(changed).toBe(true);
  });

  it('a second run with a done file and no changes is not flagged as changed', () => {
    const withDone = [
      ...baseState.files,
      { sharedPath: 'b', locale: 'ja', status: 'done' as const },
    ];
    const first = reconcile({ version: 1, files: [], claims: [] }, withDone, now);
    const second = reconcile(first.state, withDone, now);
    expect(second.changed).toBe(false);
  });

  it('a claim on a file that just became done is released as completed', () => {
    const { state } = reconcile(baseState, [{ ...baseState.files[0]!, status: 'done' }], now);
    expect(state.claims[0]?.releaseReason).toBe('completed');
    expect(state.claims[0]?.releasedAt).toBeDefined();
  });
});
