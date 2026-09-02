import type { ClaimConfig } from './config.js';
import { message } from './messages.js';
import { activeClaims, type Claim, fileKey, type TrackedFile, type TrackerState } from './model.js';
import { parseViewCheckboxes } from './render.js';
import { type ResolutionEntry, type ResolutionFailure, resolveTargets } from './resolve.js';
import { escapeRegExp } from './utils.js';

export type ClaimCommand =
  | { kind: 'claim'; paths: string[] }
  | { kind: 'release'; paths: string[] };

export interface SkippedClaim {
  path: string;
  locale: string;
  claimer: string;
  /** 所属目录认领的 token；目录级跳过用于聚合提示 */
  dir: string | undefined;
}

export interface ClaimApplication {
  created: number;
  skipped: SkippedClaim[];
}

/**
 * 把解析出的条目应用到状态：单文件认领一条，目录认领展开为其下所有文件。
 * 已被他人认领的跳过（目录级返回聚合信息），自己已认领的幂等视为成功。
 */
export function applyClaimEntries(
  state: TrackerState,
  entries: readonly ResolutionEntry[],
  user: string,
  claimedAt: string,
  commentId: number,
  commentUrl: string,
): ClaimApplication {
  let created = 0;
  const skipped: SkippedClaim[] = [];
  for (const entry of entries) {
    for (const file of entry.files) {
      const key = fileKey(file.locale, file.sharedPath);
      const existing = activeClaims(state).find(
        (claim) => fileKey(claim.locale, claim.path) === key,
      );
      if (existing && existing.user !== user) {
        skipped.push({
          path: file.sharedPath,
          locale: file.locale,
          claimer: existing.user,
          dir: entry.kind === 'dir' ? entry.token : undefined,
        });
        continue;
      }
      if (!existing) {
        state.claims.push({
          path: file.sharedPath,
          locale: file.locale,
          user,
          claimedAt,
          commentId,
          commentUrl,
        });
        created++;
      }
    }
  }
  return { created, skipped };
}

const CLAIM_RE = /^\/claim\s+(.+)$/i;
const RELEASE_RE = /^\/(?:release|give-up)\s+(.+)$/i;

/** 每行一条命令，未匹配的行忽略 */
export function parseClaimComment(body: string): ClaimCommand[] {
  const commands: ClaimCommand[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const claim = CLAIM_RE.exec(line);
    if (claim?.[1]) {
      const paths = splitPaths(claim[1]);
      if (paths.length > 0) commands.push({ kind: 'claim', paths });
      continue;
    }
    const release = RELEASE_RE.exec(line);
    if (release?.[1]) {
      const paths = splitPaths(release[1]);
      if (paths.length > 0) commands.push({ kind: 'release', paths });
    }
  }
  return commands;
}

function splitPaths(fragment: string): string[] {
  return fragment
    .split(/\s+/)
    .map((token) =>
      token
        .replace(/^\[`(.+?)`\]\(.+?\)$/, '$1')
        .replace(/^\[(.+?)\]\(.+?\)$/, '$1')
        .replace(/^[`'"]+/, '')
        // 组合剥离尾部引号与标点：`'a.md'。` → `a.md`
        .replace(/[`'".,;，。]+$/, ''),
    )
    .filter((token) => token.length > 0 && !token.startsWith('<'));
}

/** 宽松模式：从自由文本中找出清单里出现过的文件路径 */
export function extractKnownPaths(text: string, known: readonly string[]): string[] {
  return known.filter((path) =>
    new RegExp(`(?<![\\w/.-])${escapeRegExp(path)}(?![\\w/.-])`).test(text),
  );
}

export function hasIntent(body: string, keywords: readonly string[]): boolean {
  const lower = body.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function findExpiredClaims(state: TrackerState, now: Date, ttlDays: number): Claim[] {
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  return activeClaims(state).filter(
    (claim) => !claim.prUrl && now.getTime() - Date.parse(claim.claimedAt) > ttlMs,
  );
}

/**
 * 管理员手动编辑兼容：把可见清单里的"取消勾选 / 整行删除"反写回状态，按手动释放处理。
 * 读 body 时如果连一个语言区块都没解析出来，放弃本次对账（避免误释放）。
 */
export function applyViewEdits(state: TrackerState, body: string, now: Date): number {
  const view = parseViewCheckboxes(body);
  if (view.length === 0) return 0;
  const byKey = new Map(
    view.map((entry) => [fileKey(entry.locale, entry.sharedPath), entry] as const),
  );
  let released = 0;
  for (const claim of activeClaims(state)) {
    const entry = byKey.get(fileKey(claim.locale, claim.path));
    if (entry?.checked) continue;
    claim.releasedAt = now.toISOString();
    claim.releaseReason = 'manual';
    released++;
  }
  return released;
}

export interface RawComment {
  id: number;
  user: string;
  createdAt: string;
  htmlUrl: string;
  body: string;
}

/**
 * 状态块损坏时的尽力自愈：按时间顺序回放评论里的 /claim、/release 命令，
 * 重建活跃认领。返回值为空时调用方应放弃（评论里没有任何可识别的认领）。
 */
export function rebuildClaimsFromComments(
  comments: readonly RawComment[],
  files: readonly TrackedFile[],
  config: Pick<ClaimConfig, 'strictClaimSyntax' | 'lenientKeywords'>,
): { claims: Claim[]; skippedBot: number } {
  const skippedBot = comments.filter((comment) => comment.user.endsWith('[bot]')).length;
  const pending = new Map<
    string,
    {
      user: string;
      claimedAt: string;
      commentId: number;
      commentUrl: string;
      path: string;
      locale: string;
    }
  >();
  const known = files.map((file) => file.sharedPath);
  for (const comment of comments) {
    if (comment.user.endsWith('[bot]')) continue;
    const commands = parseClaimComment(comment.body);
    const claimTokens = commands.filter((c) => c.kind === 'claim').flatMap((c) => c.paths);
    const releaseTokens = commands.filter((c) => c.kind === 'release').flatMap((c) => c.paths);
    if (
      claimTokens.length === 0 &&
      !config.strictClaimSyntax &&
      hasIntent(comment.body, config.lenientKeywords)
    ) {
      claimTokens.push(...extractKnownPaths(comment.body, known));
    }
    const { entries } = resolveTargets(claimTokens, { version: 1, files: [...files], claims: [] });
    for (const entry of entries) {
      for (const file of entry.files) {
        const key = `${comment.user}::${fileKey(file.locale, file.sharedPath)}`;
        if (!pending.has(key)) {
          pending.set(key, {
            user: comment.user,
            claimedAt: comment.createdAt,
            commentId: comment.id,
            commentUrl: comment.htmlUrl,
            path: file.sharedPath,
            locale: file.locale,
          });
        }
      }
    }
    const releases = resolveTargets(releaseTokens, { version: 1, files: [...files], claims: [] });
    for (const entry of releases.entries) {
      for (const file of entry.files) {
        pending.delete(`${comment.user}::${fileKey(file.locale, file.sharedPath)}`);
      }
    }
  }
  const claims: Claim[] = [...pending.values()].map((value) => ({ ...value }));
  return { claims, skippedBot };
}

export interface ComposeRepliesInput {
  entries: readonly ResolutionEntry[];
  failures: readonly ResolutionFailure[];
  skipped: readonly SkippedClaim[];
  config: ClaimConfig;
}

/** 把解析/应用结果编排成对认领评论的回复：目录级跳过聚合、单文件跳过逐条、失败映射 */
export function composeClaimReplies(input: ComposeRepliesInput): string[] {
  const { entries, failures, skipped, config } = input;
  const replies: string[] = [];
  for (const failure of failures) {
    replies.push(
      failure.reason === 'ambiguous'
        ? message(config, 'ambiguous', {
            token: failure.token,
            candidates: failure.candidates.join('、'),
          })
        : message(config, 'unknown_file', { token: failure.token }),
    );
  }
  const dirSkips = new Map<string, SkippedClaim[]>();
  for (const item of skipped) {
    if (item.dir) {
      const list = dirSkips.get(item.dir) ?? [];
      list.push(item);
      dirSkips.set(item.dir, list);
    } else {
      replies.push(
        message(config, 'duplicate', {
          path: item.path,
          locale: item.locale,
          claimer: item.claimer,
        }),
      );
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    const list = dirSkips.get(entry.token);
    if (!list) continue;
    const shown = list
      .slice(0, 3)
      .map((skip) => `\`${skip.path}\`（@${skip.claimer}）`)
      .join('、');
    const more = list.length > 3 ? ` 等 ${list.length} 个` : '';
    replies.push(
      message(config, 'dir_skipped', {
        dir: entry.token,
        claimed: String(entry.files.length - list.length),
        skippedCount: String(list.length),
        skipped: shown + more,
      }),
    );
  }
  return replies;
}
