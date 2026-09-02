import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toTrackedFiles } from '../src/lunaria.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/status.json', import.meta.url)), 'utf-8'),
) as Parameters<typeof toTrackedFiles>[0];

describe('toTrackedFiles', () => {
  it('derives missing/outdated entries and drops done ones', () => {
    const files = toTrackedFiles(fixture, ['ja', 'ko']);
    expect(files).toEqual([
      { sharedPath: 'index', locale: 'ja', status: 'missing', localizationPath: 'src/ja/index.md' },
      {
        sharedPath: 'download-client',
        locale: 'ja',
        status: 'outdated',
        localizationPath: 'src/ja/download-client.md',
      },
      {
        sharedPath: 'download-client',
        locale: 'ko',
        status: 'missing',
        localizationPath: 'src/ko/download-client.md',
      },
    ]);
  });
});
