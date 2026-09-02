import { activeClaims, type Claim, fileKey, type TrackerState } from './model.js';
import type { ResolutionEntry } from './resolve.js';
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
        .replace(/[`'"]+$/, '')
        .replace(/[.,;，。]+$/, ''),
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
