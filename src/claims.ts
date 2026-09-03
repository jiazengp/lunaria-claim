import type { ClaimConfig } from './config.js';
import { message } from './messages.js';
import {
  activeClaims,
  type Claim,
  fileKey,
  type RawComment,
  type ReleaseReason,
  type TrackedFile,
  type TrackerState,
} from './model.js';
import { parseViewCheckboxes, type ViewCheckbox } from './render.js';
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
 * 按认领评论 id 释放其全部活跃认领（评论编辑/删除的账本语义）；返回被释放的认领。
 * 已经被释放的认领（releasedAt 已置）不在此列，重复调用自然返回空。
 */
export function releaseClaimsByCommentId(
  state: TrackerState,
  commentId: number,
  now: Date,
  reason: ReleaseReason,
): Claim[] {
  const released: Claim[] = [];
  for (const claim of activeClaims(state)) {
    if (claim.commentId !== commentId) continue;
    claim.releasedAt = now.toISOString();
    claim.releaseReason = reason;
    released.push(claim);
  }
  return released;
}

/** 判断用：目录行算子树时，前缀也接受展示路径（localizationPath）形态 */
function claimMatchesPrefix(claim: Claim, state: TrackerState, prefix: string): boolean {
  const file = state.files.find(
    (candidate) => candidate.locale === claim.locale && candidate.sharedPath === claim.path,
  );
  return claim.path.startsWith(prefix) || file?.localizationPath?.startsWith(prefix) === true;
}

/**
 * 视图条目（文件行或目录行）对应的活跃认领：
 * - 文件行：locale+路径精确匹配（sharedPath 或 localizationPath 形态），无 locale 时按路径兜底；
 * - 目录行：子树（sharedPath/展示路径前缀）对应的认领，子树全部被认领才算数
 *   （Fix D 守卫：部分认领的子树目录行本就没勾选，不该被当成释放信号）。
 */
export function viewEntryClaims(state: TrackerState, entry: ViewCheckbox): Claim[] {
  const active = activeClaims(state);
  const prefix = entry.sharedPath;
  if (prefix.endsWith('/')) {
    const subtree = state.files.filter(
      (candidate) =>
        (entry.locale ? candidate.locale === entry.locale : true) &&
        (candidate.sharedPath.startsWith(prefix) ||
          candidate.localizationPath?.startsWith(prefix) === true),
    );
    // state.files 覆盖不到该前缀时保持旧语义（仅构造认领的测试形态），按认领前缀直接返回
    const fullyClaimed =
      subtree.length === 0 ||
      subtree.every((file) =>
        active.some(
          (claim) => fileKey(claim.locale, claim.path) === fileKey(file.locale, file.sharedPath),
        ),
      );
    if (!fullyClaimed) return [];
    return active.filter(
      (claim) =>
        (entry.locale ? claim.locale === entry.locale : true) &&
        claimMatchesPrefix(claim, state, prefix),
    );
  }
  return active.filter((claim) => {
    const file = state.files.find(
      (candidate) => candidate.locale === claim.locale && candidate.sharedPath === claim.path,
    );
    const keys = [fileKey(claim.locale, claim.path)];
    if (file?.localizationPath) keys.push(fileKey(claim.locale, file.localizationPath));
    if (entry.locale) return keys.includes(fileKey(entry.locale, entry.sharedPath));
    return claim.path === entry.sharedPath || file?.localizationPath === entry.sharedPath;
  });
}

/** 按视图条目释放认领（勾选行不动作；目录行带全认领守卫）；返回被释放的认领 */
export function releaseClaimForViewEntry(
  state: TrackerState,
  entry: ViewCheckbox,
  now: Date,
): Claim[] {
  if (entry.checked) return [];
  const released: Claim[] = [];
  for (const claim of viewEntryClaims(state, entry)) {
    claim.releasedAt = now.toISOString();
    claim.releaseReason = 'manual';
    released.push(claim);
  }
  return released;
}

/**
 * 管理员手动编辑兼容：把可见清单里的"取消勾选 / 整行删除"反写回状态，按手动释放处理。
 * 读 body 时如果连一个语言区块都没解析出来，放弃本次对账（避免误释放）。
 */
export function applyViewEdits(state: TrackerState, body: string, now: Date): number {
  const view = parseViewCheckboxes(body);
  if (view.length === 0) return 0;
  // 展示路径可能是 sharedPath 或目标语言文件路径，两条键都收；重复行以最后一行为准（历史语义）
  const exact = new Map<string, ViewCheckbox>();
  const loose = new Map<string, ViewCheckbox>();
  for (const entry of view) {
    if (entry.sharedPath.endsWith('/')) continue;
    if (entry.locale) exact.set(fileKey(entry.locale, entry.sharedPath), entry);
    else loose.set(entry.sharedPath, entry);
  }
  // 认领侧：对应行存在且勾选（文件行）才保留；行缺失或未勾选 = 手动释放
  const kept = new Set<Claim>();
  for (const entry of [...exact.values(), ...loose.values()]) {
    if (!entry.checked) continue;
    for (const claim of viewEntryClaims(state, entry)) kept.add(claim);
  }
  const released = new Set<Claim>();
  for (const claim of activeClaims(state)) {
    if (kept.has(claim)) continue;
    claim.releasedAt = now.toISOString();
    claim.releaseReason = 'manual';
    released.add(claim);
  }
  // 目录行取消勾选 = 释放该目录下的全部认领（子树全认领守卫见 viewEntryClaims）
  for (const entry of view) {
    if (!entry.sharedPath.endsWith('/')) continue;
    for (const claim of releaseClaimForViewEntry(state, entry, now)) released.add(claim);
  }
  return released.size;
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
