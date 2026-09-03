import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActionInputs, loadConfig } from '../src/config.js';
import type { GitHubApi, IssueRef, ReactionContent } from '../src/github.js';
import type { RawComment, TrackerState } from '../src/model.js';
import { runClaim } from '../src/modes/claim.js';
import { runExpire } from '../src/modes/expire.js';
import type { ModeContext } from '../src/modes/index.js';
import { runSync } from '../src/modes/sync.js';
import { parseState, serializeState } from '../src/state.js';

const template = readFileSync(
  fileURLToPath(new URL('../examples/lunaria-claim.template.md', import.meta.url)),
  'utf-8',
);

/**
 * GitHubApi 的内存版"影子实现"：记录每次写操作，把"事件进来 → 状态变 → 恰写一次"的
 * 编排契约锁进测试（001 计划的重复写 bug 就是缺这类护栏）。
 */
class FakeApi implements GitHubApi {
  issue: { number: number; title: string; body: string | null } | null = null;
  comments: RawComment[] = [];
  created = 0;
  updates = 0;
  reactions: ReactionContent[] = [];

  async findTrackerIssue(): Promise<IssueRef | null> {
    return this.issue ? { ...this.issue } : null;
  }

  // FakeApi 固定创建 #1 号 issue，事件负载里直接引用
  async createIssue({
    title,
    body,
  }: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<number> {
    this.created++;
    this.issue = { number: 1, title, body };
    return this.issue.number;
  }

  async updateIssueBody(_issueNumber: number, body: string): Promise<void> {
    this.updates++;
    if (this.issue) this.issue.body = body;
  }

  async listComments(): Promise<RawComment[]> {
    return [...this.comments];
  }

  async reactToComment(_commentId: number, content: ReactionContent): Promise<void> {
    this.reactions.push(content);
  }

  async addComment(_issueNumber: number, body: string): Promise<void> {
    this.comments.push({
      id: 1000 + this.comments.length,
      user: 'lunaria-claim[bot]',
      createdAt: new Date().toISOString(),
      htmlUrl: '',
      body,
    });
  }

  async listPullRequestFiles(): Promise<string[]> {
    return [];
  }
}

/** 构造带固定 now 的 ModeContext；claim/expire 用例通过 inputs.mode 切换模式 */
function makeCtx(
  api: FakeApi,
  inputs: Partial<ActionInputs> = {},
  now = new Date('2026-09-02T00:00:00Z'),
): ModeContext {
  return {
    inputs: {
      mode: 'sync' as const,
      token: 't',
      statusJsonPath: './tests/fixtures/status.json',
      configPath: './tests/fixtures/modes-config.yml',
      dryRun: false,
      ...inputs,
    },
    config: loadConfig('./tests/fixtures/modes-config.yml'),
    api,
    repo: { owner: 'o', repo: 'r' },
    now,
  };
}

/** 事件负载写入临时文件，模拟 GITHUB_EVENT_PATH 指向的 JSON */
function writeEvent(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'lunaria-claim-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

/**
 * fixtures/status.json 的派生清单（lunaria 配置 locales 为 ja/ko）：
 * - index：ja missing（推导路径 src/ja/index.md）、ko done
 * - download-client：ja outdated（src/ja/download-client.md）、ko missing（src/ko/download-client.md）
 * 可认领条目共 3 个；`index` 是唯一不会歧义的 sharedPath（done 行不参与路径匹配，
 * 只有 ja 侧落空，ko 侧已完成自然被排除）。
 */

describe('mode orchestration (fake GitHubApi)', () => {
  beforeEach(() => {
    // 让 core.summary 正常落盘，不降级成 warning；summary 要求文件已存在（access 校验），先 touch
    const summaryPath = join(tmpdir(), 'summary.md');
    writeFileSync(summaryPath, '');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('sync', () => {
    it('first sync creates the issue with a parseable state block', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api));
      expect(api.created).toBe(1);
      expect(api.updates).toBe(0);
      const state = parseState(api.issue?.body ?? '');
      expect(state).not.toBeNull();
      // 渲染出的清单：未认领行与 fixture 里的真实条目
      expect(api.issue?.body ?? '').toContain('- [ ]');
      expect(api.issue?.body ?? '').toContain('src/ja/index.md');
      expect(api.issue?.body ?? '').toContain('src/ko/download-client.md');
    });

    it('second sync with unchanged status is a no-op (regression for plan 001)', async () => {
      const api = new FakeApi();
      const ctx = makeCtx(api);
      await runSync(ctx);
      const bodyAfterFirst = api.issue?.body;
      await runSync(ctx);
      expect(api.created).toBe(1);
      expect(api.updates).toBe(0);
      expect(api.issue?.body).toBe(bodyAfterFirst);
    });

    it('dry-run sync creates nothing', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api, { dryRun: true }));
      expect(api.created).toBe(0);
      expect(api.updates).toBe(0);
      expect(api.issue).toBeNull();
    });

    it('corrupted state block triggers self-heal rebuild', async () => {
      const api = new FakeApi();
      const ctx = makeCtx(api);
      await runSync(ctx);
      // 状态块换成不可解析的正文（其余保留模板原文），模拟被手改坏
      if (api.issue) api.issue.body = template.replace('{}', 'not json');
      // 一条真实认领评论（用户非 bot、路径取 fixture 里的 index → 唯一匹配 index/ja）
      api.comments.push({
        id: 1,
        user: 'alice',
        createdAt: '2026-09-01T00:00:00Z',
        htmlUrl: 'https://example.com/1',
        body: '/claim index',
      });
      await runSync(ctx);
      // 重建通知 + 状态块被修复 + 认领从评论回放回来
      expect(api.comments.some((comment) => comment.body.startsWith('♻️'))).toBe(true);
      expect(api.updates).toBe(1);
      const state = parseState(api.issue?.body ?? '');
      expect(state).not.toBeNull();
      expect(state?.claims).toHaveLength(1);
      expect(state?.claims[0]).toMatchObject({ user: 'alice', path: 'index', locale: 'ja' });
    });
  });

  describe('claim', () => {
    it('claim comment creates a claim, updates the body once, reacts rocket', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api));
      vi.stubEnv(
        'GITHUB_EVENT_PATH',
        writeEvent({
          comment: {
            id: 1,
            body: '/claim index',
            user: { login: 'alice' },
            html_url: 'https://example.com/1',
            created_at: '2026-09-02T00:00:00Z',
          },
          // FakeApi.createIssue 固定创建 #1
          issue: { number: 1 },
        }),
      );
      await runClaim(makeCtx(api, { mode: 'claim' }));
      expect(api.updates).toBe(1);
      expect(api.reactions).toEqual(['rocket']);
      // 认领成功不回复
      expect(api.comments).toHaveLength(0);
      const state = parseState(api.issue?.body ?? '');
      expect(state).not.toBeNull();
      expect(state?.claims.find((claim) => claim.user === 'alice')).toMatchObject({
        path: 'index',
        locale: 'ja',
      });
    });

    it('bot comment is skipped silently', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api));
      vi.stubEnv(
        'GITHUB_EVENT_PATH',
        writeEvent({
          comment: {
            id: 2,
            body: '/claim index',
            user: { login: 'github-actions[bot]' },
            html_url: 'https://example.com/2',
            created_at: '2026-09-02T00:00:00Z',
          },
          issue: { number: 1 },
        }),
      );
      await runClaim(makeCtx(api, { mode: 'claim' }));
      expect(api.updates).toBe(0);
      expect(api.reactions).toHaveLength(0);
      expect(api.comments).toHaveLength(0);
    });

    it('lenient free-text claim with known path expands', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api));
      // 宽松认领（不带 /claim）：本 fixture 的 sharedPath 只有无目录段的 index /
      // download-client 两个值，lenientTargets 只从 sharedPath 展开目录前缀（真实仓库目录
      // src/ja/ 等不在候选集里），而裸词 download-client 会命中 ja/ko 两个语言被判歧义——
      // 因此 index 是唯一可宽松认领的路径，命中 1 个未认领条目（index/ja；index/ko 已完成）。
      vi.stubEnv(
        'GITHUB_EVENT_PATH',
        writeEvent({
          comment: {
            id: 3,
            body: '我来认领 index',
            user: { login: 'alice' },
            html_url: 'https://example.com/3',
            created_at: '2026-09-02T00:00:00Z',
          },
          issue: { number: 1 },
        }),
      );
      await runClaim(makeCtx(api, { mode: 'claim' }));
      expect(api.updates).toBe(1);
      const state = parseState(api.issue?.body ?? '');
      expect(state).not.toBeNull();
      expect(state?.claims).toHaveLength(1);
      expect(state?.claims[0]).toMatchObject({ user: 'alice', path: 'index', locale: 'ja' });
    });
  });

  describe('expire', () => {
    it('expired claim is released with a reminder comment and body update', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api));
      const state = parseState(api.issue?.body ?? '');
      expect(state).not.toBeNull();
      // 60 天前（2026-08-02）的活跃认领，远超默认 ttlDays=15
      const expiredState: TrackerState = {
        version: 1,
        files: state?.files ?? [],
        claims: [
          {
            path: 'download-client',
            locale: 'ja',
            user: 'bob',
            claimedAt: '2026-08-02T00:00:00Z',
            commentId: 42,
            commentUrl: 'https://example.com/42',
          },
        ],
      };
      if (api.issue?.body && state) {
        api.issue.body = api.issue.body.replace(
          serializeState(state),
          serializeState(expiredState),
        );
      }
      await runExpire(makeCtx(api, { mode: 'expire' }, new Date('2026-10-01T00:00:00Z')));
      expect(api.updates).toBe(1);
      expect(api.comments).toHaveLength(1);
      expect(api.comments[0]?.body).toContain('⏰');
      const claim = parseState(api.issue?.body ?? '')?.claims[0];
      expect(claim?.releasedAt).toBe('2026-10-01T00:00:00.000Z');
      expect(claim?.releaseReason).toBe('expired');
    });

    it('no expired claims means no writes', async () => {
      const api = new FakeApi();
      await runSync(makeCtx(api));
      const state = parseState(api.issue?.body ?? '');
      expect(state).not.toBeNull();
      // 5 天前的认领（2026-08-28），未到期
      const freshState: TrackerState = {
        version: 1,
        files: state?.files ?? [],
        claims: [
          {
            path: 'download-client',
            locale: 'ja',
            user: 'bob',
            claimedAt: '2026-08-28T00:00:00Z',
            commentId: 43,
            commentUrl: 'https://example.com/43',
          },
        ],
      };
      if (api.issue?.body && state) {
        api.issue.body = api.issue.body.replace(serializeState(state), serializeState(freshState));
      }
      await runExpire(makeCtx(api, { mode: 'expire' }));
      expect(api.updates).toBe(0);
      expect(api.comments).toHaveLength(0);
      // 认领原样保留（未被释放）
      expect(parseState(api.issue?.body ?? '')?.claims[0]?.releasedAt).toBeUndefined();
    });
  });
});
