import { fileKey, type TrackedFile, type TrackerState } from './model.js';

export interface ResolutionFailure {
  token: string;
  reason: 'unknown' | 'ambiguous';
  candidates: string[];
}

export interface ResolutionEntry {
  token: string;
  /** dir = token 是目录前缀，files 是展开后的清单条目 */
  kind: 'file' | 'dir';
  files: TrackedFile[];
}

export interface Resolution {
  entries: ResolutionEntry[];
  failures: ResolutionFailure[];
}

/**
 * 把用户输入的路径 token 解析为清单条目（单个文件或整个目录）。接受：
 * sharedPath、仓库真实路径（含语言目录）、`语言/路径` 简写、目录前缀（含尾部斜杠）、裸文件名。
 */
export function resolveTargets(tokens: readonly string[], state: TrackerState): Resolution {
  const entries: ResolutionEntry[] = [];
  const failures: ResolutionFailure[] = [];
  for (const raw of tokens) {
    const token = normalizeToken(raw);
    const candidates = scopeByLocale(token, matchFiles(token, state.files));
    if (candidates.length === 0) {
      failures.push({ token, reason: 'unknown', candidates: [] });
    } else if (isDirToken(token, candidates)) {
      entries.push({ token, kind: 'dir', files: candidates });
    } else {
      const first = candidates[0];
      if (candidates.length === 1 && first) {
        entries.push({ token, kind: 'file', files: [first] });
      } else {
        failures.push({
          token,
          reason: 'ambiguous',
          candidates: candidates.slice(0, 3).map((file) => `${file.sharedPath}（${file.locale}）`),
        });
      }
    }
  }
  return { entries, failures };
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
  // 目录前缀：先按 sharedPath，再按仓库真实路径（含语言目录）
  for (const file of files) {
    if (file.sharedPath.startsWith(`${token}/`)) add(file);
  }
  for (const file of files) {
    if (file.localizationPath?.startsWith(`${token}/`)) add(file);
  }
  // 裸文件名（leaf 简写）：无目录的 token 按 sharedPath 的 basename 匹配，重名时交给歧义处理
  if (!token.includes('/')) {
    for (const file of files) {
      if (file.sharedPath.slice(file.sharedPath.lastIndexOf('/') + 1) === token) add(file);
    }
  }
  return [...matches.values()];
}

/** token 对全部候选都是目录前缀时视为目录认领（否则视为歧义的文件匹配） */
function isDirToken(token: string, candidates: TrackedFile[]): boolean {
  return candidates.every(
    (file) =>
      file.sharedPath.startsWith(`${token}/`) || file.localizationPath?.startsWith(`${token}/`),
  );
}

/** token 里显式包含语言段（如 `en/foo.md`）时用它消歧 */
function scopeByLocale(token: string, candidates: TrackedFile[]): TrackedFile[] {
  if (candidates.length <= 1) return candidates;
  const segments = new Set(token.split('/'));
  const scoped = candidates.filter((file) => segments.has(file.locale));
  return scoped.length > 0 ? scoped : candidates;
}
