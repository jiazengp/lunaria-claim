import { fileKey, type TrackedFile, type TrackerState } from './model.js';

export interface ResolutionFailure {
  token: string;
  reason: 'unknown' | 'ambiguous';
  candidates: string[];
}

export interface Resolution {
  resolved: TrackedFile[];
  failures: ResolutionFailure[];
}

/**
 * 把用户输入的路径 token 解析为清单条目。接受三种写法：
 * sharedPath（清单展示的写法）、仓库真实路径（含语言目录）、`语言/路径` 简写。
 */
export function resolveTargets(tokens: readonly string[], state: TrackerState): Resolution {
  const resolved = new Map<string, TrackedFile>();
  const failures: ResolutionFailure[] = [];
  for (const raw of tokens) {
    const token = normalizeToken(raw);
    const candidates = scopeByLocale(token, matchFiles(token, state.files));
    const first = candidates[0];
    if (candidates.length === 1 && first) {
      resolved.set(fileKey(first.locale, first.sharedPath), first);
    } else if (candidates.length === 0) {
      failures.push({ token, reason: 'unknown', candidates: [] });
    } else {
      failures.push({
        token,
        reason: 'ambiguous',
        candidates: candidates.slice(0, 3).map((file) => `${file.sharedPath}（${file.locale}）`),
      });
    }
  }
  return { resolved: [...resolved.values()], failures };
}

function normalizeToken(token: string): string {
  return token.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function matchFiles(token: string, files: readonly TrackedFile[]): TrackedFile[] {
  const matches = new Map<string, TrackedFile>();
  const add = (file: TrackedFile) => matches.set(fileKey(file.locale, file.sharedPath), file);
  const tokenStem = token.replace(/\.[^.]+$/, '');
  for (const file of files) {
    if (file.sharedPath === token || file.sharedPath.replace(/\.[^.]+$/, '') === tokenStem) {
      add(file);
      continue;
    }
    if (file.localizationPath === token || file.localizationPath?.endsWith(`/${token}`)) {
      add(file);
    }
  }
  if (matches.size === 0) {
    for (const file of files) {
      if (token.endsWith(`/${file.sharedPath}`)) add(file);
    }
  }
  return [...matches.values()];
}

/** token 里显式包含语言段（如 `en/foo.md`）时用它消歧 */
function scopeByLocale(token: string, candidates: TrackedFile[]): TrackedFile[] {
  if (candidates.length <= 1) return candidates;
  const segments = new Set(token.split('/'));
  const scoped = candidates.filter((file) => segments.has(file.locale));
  return scoped.length > 0 ? scoped : candidates;
}
