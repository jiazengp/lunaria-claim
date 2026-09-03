import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaimConfigSchema, loadConfig, parseInputs, repoFromEnv } from '../src/config.js';

const DEFAULT_CONFIG = ClaimConfigSchema.parse({});

describe('ClaimConfigSchema', () => {
  it('applies every default when the config is empty', () => {
    expect(DEFAULT_CONFIG).toEqual({
      issue: { title: '🙋 翻译认领', label: 'lunaria-claim', perLocale: false },
      ttlDays: 15,
      strictClaimSyntax: false,
      lenientKeywords: ['认领', '领取', 'claim', '我来', '接单'],
      collapseThreshold: 30,
      fileListStyle: 'tree',
      templatePath: '.github/lunaria-claim.md',
      dashboardUrl: undefined,
      messages: {},
    });
  });

  it('merges overrides with defaults', () => {
    const config = ClaimConfigSchema.parse({ ttlDays: 7, fileListStyle: 'flat' });
    expect(config.ttlDays).toBe(7);
    expect(config.fileListStyle).toBe('flat');
    expect(config.collapseThreshold).toBe(30);
    expect(config.issue.label).toBe('lunaria-claim');
  });

  it('rejects invalid values', () => {
    expect(() => ClaimConfigSchema.parse({ ttlDays: 0 })).toThrow();
    expect(() => ClaimConfigSchema.parse({ ttlDays: 'abc' })).toThrow();
    expect(() => ClaimConfigSchema.parse({ fileListStyle: 'grid' })).toThrow();
    expect(() => ClaimConfigSchema.parse({ collapseThreshold: -1 })).toThrow();
  });
});

describe('parseInputs', () => {
  it('requires a valid mode', () => {
    expect(() => parseInputs({ mode: 'wat', token: 't' })).toThrow();
    expect(() => parseInputs({ mode: '', token: 't' })).toThrow();
    for (const mode of ['sync', 'claim', 'expire', 'link-pr']) {
      expect(parseInputs({ mode, token: 't' }).mode).toBe(mode);
    }
  });

  it('requires a token and applies defaults for the rest', () => {
    expect(() => parseInputs({ mode: 'sync', token: '' })).toThrow();
    const inputs = parseInputs({ mode: 'sync', token: 't' });
    expect(inputs.statusJsonPath).toBe('./dist/lunaria/status.json');
    expect(inputs.configPath).toBe('.github/lunaria-claim.yml');
  });
});

describe('loadConfig', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('throws when the config file is missing', () => {
    expect(() => loadConfig(join(tmpdir(), 'nope-claim.yml'))).toThrow();
  });

  it('returns defaults for an empty config file', () => {
    dir = mkdtempSync(join(tmpdir(), 'lunaria-claim-'));
    const path = join(dir, 'lunaria-claim.yml');
    writeFileSync(path, '', 'utf-8');
    expect(loadConfig(path).config.ttlDays).toBe(15);
  });

  it('marks the config as template-explicit only when templatePath is spelled out (plan 007)', () => {
    // 显式写 templatePath 键（fixture）→ 模板是布局真相源
    const explicit = loadConfig('./tests/fixtures/modes-config.yml');
    expect(explicit.templateExplicit).toBe(true);
    // 空配置走默认值 → 维持原位覆盖
    dir = mkdtempSync(join(tmpdir(), 'lunaria-claim-'));
    const path = join(dir, 'lunaria-claim.yml');
    writeFileSync(path, '{}', 'utf-8');
    const implicit = loadConfig(path);
    expect(implicit.templateExplicit).toBe(false);
    expect(implicit.config.templatePath).toBe('.github/lunaria-claim.md');
  });

  it('rejects invalid yaml', () => {
    dir = mkdtempSync(join(tmpdir(), 'lunaria-claim-'));
    const path = join(dir, 'lunaria-claim.yml');
    writeFileSync(path, 'ttlDays: [unclosed', 'utf-8');
    expect(() => loadConfig(path)).toThrow();
  });
});

describe('repoFromEnv', () => {
  const KEY = 'GITHUB_REPOSITORY';
  const saved = process.env[KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('parses owner/repo', () => {
    process.env[KEY] = 'owner/docs';
    expect(repoFromEnv()).toEqual({ owner: 'owner', repo: 'docs' });
  });

  it('throws when unset or malformed', () => {
    delete process.env[KEY];
    expect(() => repoFromEnv()).toThrow();
    process.env[KEY] = 'no-separator';
    expect(() => repoFromEnv()).toThrow();
  });
});

describe('parseInputs dry-run', () => {
  it('parses the dry-run flag', () => {
    expect(parseInputs({ mode: 'sync', token: 't', dryRun: 'true' }).dryRun).toBe(true);
    expect(parseInputs({ mode: 'sync', token: 't', dryRun: 'false' }).dryRun).toBe(false);
    expect(parseInputs({ mode: 'sync', token: 't' }).dryRun).toBe(false);
  });
});
