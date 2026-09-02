import { describe, expect, it } from 'vitest';
import { ClaimConfigSchema } from '../src/config.js';
import { DEFAULT_MESSAGES, message } from '../src/messages.js';

const config = ClaimConfigSchema.parse({ messages: { duplicate: '自定义 {path}' } });

describe('message', () => {
  it('uses consumer overrides first', () => {
    expect(message(config, 'duplicate', { path: 'a.md' })).toBe('自定义 a.md');
  });

  it('falls back to defaults with variable substitution', () => {
    const text = message(config, 'expired', {
      user: 'alice',
      path: 'a.md',
      locale: 'ja',
      ttlDays: '15',
    });
    expect(text).toContain('@alice');
    expect(text).toContain('`a.md`');
    expect(text).toContain('15 天');
  });

  it('leaves unmatched variables intact', () => {
    expect(DEFAULT_MESSAGES.duplicate).toContain('{claimer}');
  });
});
