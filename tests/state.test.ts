import { describe, expect, it } from 'vitest';
import { parseState, serializeState } from '../src/state.js';

const state = {
  version: 1 as const,
  files: [{ sharedPath: 'a', locale: 'ja', status: 'missing' as const }],
  claims: [],
};

describe('state block', () => {
  it('round-trips through serialize/parse inside a full issue body', () => {
    const body = `intro\n\n${serializeState(state)}\n\nfooter`;
    expect(parseState(body)).toEqual(state);
  });

  it('returns null for corrupted blocks', () => {
    expect(
      parseState('<!-- LUNARIA-CLAIM:STATE v1 -->\nnot json\n<!-- /LUNARIA-CLAIM:STATE -->'),
    ).toBeNull();
  });

  it('returns null when the block is absent', () => {
    expect(parseState('plain body without state')).toBeNull();
  });
});
