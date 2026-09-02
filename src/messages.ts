import type { ClaimConfig } from './config.js';

export const DEFAULT_MESSAGES: Record<string, string> = {
  duplicate: '👀 `{path}`（{locale}）已被 @{claimer} 认领，请换一个文件。',
  unknown_file: '❓ 清单里没有 `{token}`（或已翻译完成）。请从清单复制完整路径后重试。',
  ambiguous:
    '❓ `{token}` 匹配到多个文件：{candidates}。请用完整路径或加语言前缀，如 `en/{token}`。',
  expired:
    '⏰ @{user} 认领的 `{path}`（{locale}）已超过 {ttlDays} 天未提交 PR，已自动释放，欢迎重新认领。',
  pr_closed: '↩️ @{user} 的 PR 已关闭未合并，已释放：{paths}',
  dir_skipped: '📚 `{dir}` 认领 {claimed} 个文件；{skippedCount} 个已被认领，自动跳过：{skipped}',
};

export function message(
  config: ClaimConfig,
  key: string,
  vars: Record<string, string> = {},
): string {
  const template = config.messages[key] ?? DEFAULT_MESSAGES[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
