import {
  activeClaims,
  type Claim,
  FILES_CLOSE,
  FILES_OPEN,
  type FileStatusKind,
  fileKey,
  type LocaleSection,
  type TrackedFile,
  type TrackerState,
} from './model.js';
import { serializeState } from './state.js';
import { escapeRegExp } from './utils.js';

const STATUS_BADGE: Record<FileStatusKind, string> = {
  missing: '',
  outdated: ' ⚠️ 源文件已更新，需要重新翻译',
  done: '',
};

const FILES_REGION_RE = new RegExp(
  `${escapeRegExp(FILES_OPEN)}[\\s\\S]*?${escapeRegExp(FILES_CLOSE)}`,
);

export function applyPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => vars[key] ?? match);
}

/** 用 state + 清单重渲染 body 中 bot 专属的 FILES 区块，其余内容原样保留 */
export function renderBody(
  body: string,
  sections: LocaleSection[],
  state: TrackerState,
  collapseThreshold: number,
): string {
  const region = renderFilesRegion(sections, state, collapseThreshold);
  if (!FILES_REGION_RE.test(body)) {
    throw new Error('body is missing the LUNARIA-CLAIM:FILES region markers');
  }
  return body.replace(FILES_REGION_RE, () => region);
}

export function renderFilesRegion(
  sections: LocaleSection[],
  state: TrackerState,
  collapseThreshold: number,
): string {
  const claimsByFile = new Map(
    activeClaims(state).map((claim) => [fileKey(claim.locale, claim.path), claim]),
  );
  const view = sections
    .filter((section) => section.files.length > 0)
    .map((section) => renderSection(section, claimsByFile, collapseThreshold))
    .join('\n\n');
  return `${FILES_OPEN}\n${view}\n\n${serializeState(state)}\n${FILES_CLOSE}`;
}

function renderSection(
  section: LocaleSection,
  claimsByFile: Map<string, Claim>,
  collapseThreshold: number,
): string {
  const lines = section.files.map((file) => renderFileLine(file, claimsByFile));
  const heading = `### 🌐 ${section.locale}`;
  if (lines.length > collapseThreshold) {
    return `${heading}\n\n<details><summary>共 ${lines.length} 个文件待处理（点击展开）</summary>\n\n${lines.join('\n')}\n\n</details>`;
  }
  return `${heading}\n\n${lines.join('\n')}`;
}

function renderFileLine(file: TrackedFile, claimsByFile: Map<string, Claim>): string {
  const claim = claimsByFile.get(fileKey(file.locale, file.sharedPath));
  const checked = claim ? 'x' : ' ';
  const owner = claim
    ? ` — @${claim.user} · ${claim.claimedAt.slice(0, 10)}${claim.prUrl ? ` · [PR](${claim.prUrl})` : ''}`
    : '';
  return `- [${checked}] \`${file.sharedPath}\`${STATUS_BADGE[file.status]}${owner}`;
}
