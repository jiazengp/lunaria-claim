import { readFileSync } from 'node:fs';
import type { TrackedFile } from './model.js';

/** lunaria status.json 的最小类型面，只声明我们消费的字段 */
export interface LunariaStatusItem {
  sharedPath: string;
  sourceFile: {
    path: string;
    lang: string;
    gitHostingFileURL?: string;
    gitHostingHistoryURL?: string;
  };
  localizations: Record<string, { isMissing: boolean; isOutdated?: boolean; path?: string }>;
}

export function readLunariaStatus(path: string): LunariaStatusItem[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as LunariaStatusItem[];
}

/** done 不进认领清单：翻译完成与否完全以 Lunaria 为准，由 sync 对账移出 */
export function toTrackedFiles(status: LunariaStatusItem[], locales: string[]): TrackedFile[] {
  const files: TrackedFile[] = [];
  const toUrl = (url: string | undefined): string | undefined => url?.replace(/\\/g, '/');
  const entry = (
    sharedPath: string,
    locale: string,
    status: TrackedFile['status'],
    localizationPath: string | undefined,
    sourceUrl: string | undefined,
    sourceHistoryUrl: string | undefined,
  ): TrackedFile => ({
    sharedPath,
    locale,
    status,
    ...(localizationPath ? { localizationPath } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceHistoryUrl ? { sourceHistoryUrl } : {}),
  });
  for (const item of status) {
    const sourceUrl = toUrl(item.sourceFile.gitHostingFileURL);
    const sourceHistoryUrl = toUrl(item.sourceFile.gitHostingHistoryURL);
    for (const locale of locales) {
      const loc = item.localizations[locale];
      if (!loc) continue;
      // 缺失条目在 status.json 里没有 path，按 sourceFile 的目录布局推导，仅供认领匹配
      const derived = item.sourceFile.path.includes(`/${item.sourceFile.lang}/`)
        ? item.sourceFile.path.replace(`/${item.sourceFile.lang}/`, `/${locale}/`)
        : undefined;
      const localizationPath = !loc.isMissing && loc.path ? loc.path : derived;
      if (loc.isMissing) {
        files.push(
          entry(item.sharedPath, locale, 'missing', localizationPath, sourceUrl, sourceHistoryUrl),
        );
      } else if (loc.isOutdated) {
        files.push(
          entry(item.sharedPath, locale, 'outdated', localizationPath, sourceUrl, sourceHistoryUrl),
        );
      } else {
        // 已完成（up-to-date）：保留在清单中只展示打勾，不可认领
        files.push(
          entry(item.sharedPath, locale, 'done', localizationPath, sourceUrl, sourceHistoryUrl),
        );
      }
    }
  }
  return files;
}
