export const STATE_OPEN = '<!-- LUNARIA-CLAIM:STATE v1 -->';
export const STATE_CLOSE = '<!-- /LUNARIA-CLAIM:STATE -->';
export const FILES_OPEN = '<!-- LUNARIA-CLAIM:FILES -->';
export const FILES_CLOSE = '<!-- /LUNARIA-CLAIM:FILES -->';

export type FileStatusKind = 'missing' | 'outdated' | 'done';

export type ReleaseReason = 'expired' | 'voluntary' | 'pr-closed' | 'completed';

export interface TrackedFile {
  /** Lunaria 的跨语言共享标识，例如 `manual/client/canvas` */
  sharedPath: string;
  locale: string;
  status: FileStatusKind;
  /** 翻译文件的实际仓库路径（status.json 提供时才有，用于 PR 关联匹配） */
  localizationPath?: string;
}

export interface Claim {
  path: string;
  locale: string;
  user: string;
  /** 认领评论的创建时间而非处理时间，抗 workflow 调度延迟 */
  claimedAt: string;
  commentId: number;
  commentUrl: string;
  prUrl?: string;
  releasedAt?: string;
  releaseReason?: ReleaseReason;
}

export interface TrackerState {
  version: 1;
  files: TrackedFile[];
  claims: Claim[];
}

export interface LocaleSection {
  locale: string;
  files: TrackedFile[];
}

export function fileKey(locale: string, sharedPath: string): string {
  return `${locale}::${sharedPath}`;
}

export function activeClaims(state: TrackerState): Claim[] {
  return state.claims.filter((claim) => !claim.releasedAt);
}

export function groupByLocale(files: TrackedFile[]): LocaleSection[] {
  const map = new Map<string, TrackedFile[]>();
  for (const file of files) {
    const list = map.get(file.locale) ?? [];
    list.push(file);
    map.set(file.locale, list);
  }
  return [...map.entries()]
    .map(([locale, sectionFiles]) => ({ locale, files: sectionFiles }))
    .sort((a, b) => a.locale.localeCompare(b.locale));
}
