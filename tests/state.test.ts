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

describe('state block version guard', () => {
  it('rejects an unknown state version', () => {
    const body =
      '<!-- LUNARIA-CLAIM:STATE v2 -->\n{"version":2,"files":[],"claims":[]}\n<!-- /LUNARIA-CLAIM:STATE -->';
    expect(parseState(body)).toBeNull();
  });

  it('rejects structurally wrong state', () => {
    const body =
      '<!-- LUNARIA-CLAIM:STATE v1 -->\n{"version":1,"files":"nope","claims":[]}\n<!-- /LUNARIA-CLAIM:STATE -->';
    expect(parseState(body)).toBeNull();
  });
});
