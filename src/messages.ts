import type { ClaimConfig } from './config.js';

export const DEFAULT_MESSAGES: Record<string, string> = {
  duplicate: '👀 `{path}`（{locale}）已被 @{claimer} 认领，请选择清单里其他未认领的文件。',
  unknown_file: '❓ 清单里没有找到 `{token}`（可能已完成翻译），请从清单中复制完整文件路径后重试。',
  ambiguous:
    '❓ `{token}` 匹配到多个文件：{candidates}。请使用完整路径，或在前面注明语言，例如 `en/{token}`。',
  expired:
    '⏰ @{user} 认领的 `{path}`（{locale}）已超过 {ttlDays} 天未提交 PR，已自动释放回待认领清单，欢迎之后重新认领。',
  pr_closed: '↩️ @{user} 的 PR 已关闭且未合并，以下认领已释放回清单：{paths}',
  dir_skipped:
    '📚 `{dir}` 认领了 {claimed} 个文件；另有 {skippedCount} 个已被他人认领，自动跳过：{skipped}',
};

export function message(
  config: ClaimConfig,
  key: string,
  vars: Record<string, string> = {},
): string {
  const template = config.messages[key] ?? DEFAULT_MESSAGES[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
