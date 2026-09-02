import type { FileListStyle } from './config.js';
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

export interface RenderOptions {
  collapseThreshold: number;
  fileListStyle: FileListStyle;
}

export function renderOptions(config: {
  collapseThreshold: number;
  fileListStyle: FileListStyle;
}): RenderOptions {
  return { collapseThreshold: config.collapseThreshold, fileListStyle: config.fileListStyle };
}

export function applyPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => vars[key] ?? match);
}

/** 用 state + 清单重渲染 body 中 bot 专属的 FILES 区块，其余内容原样保留 */
export function renderBody(
  body: string,
  sections: LocaleSection[],
  state: TrackerState,
  options: RenderOptions,
): string {
  const region = renderFilesRegion(sections, state, options);
  if (!FILES_REGION_RE.test(body)) {
    throw new Error('body is missing the LUNARIA-CLAIM:FILES region markers');
  }
  return body.replace(FILES_REGION_RE, () => region);
}

export function renderFilesRegion(
  sections: LocaleSection[],
  state: TrackerState,
  options: RenderOptions,
): string {
  const claimsByFile = new Map(
    activeClaims(state).map((claim) => [fileKey(claim.locale, claim.path), claim]),
  );
  const view = sections
    .filter((section) => section.files.length > 0)
    .map((section) => renderSection(section, claimsByFile, options))
    .join('\n\n');
  return `${FILES_OPEN}\n${view}\n\n${serializeState(state)}\n${FILES_CLOSE}`;
}

function renderSection(
  section: LocaleSection,
  claimsByFile: Map<string, Claim>,
  options: RenderOptions,
): string {
  const lines: string[] = [];
  if (options.fileListStyle === 'tree') {
    renderTree(buildTree(section.files), 0, lines, claimsByFile);
  } else {
    for (const file of section.files) lines.push(renderFileLine(file, claimsByFile));
  }
  const heading = `### 🌐 ${section.locale}`;
  if (section.files.length > options.collapseThreshold) {
    return `${heading}\n\n<details><summary>共 ${section.files.length} 个文件待处理（点击展开）</summary>\n\n${lines.join('\n')}\n\n</details>`;
  }
  return `${heading}\n\n${lines.join('\n')}`;
}

interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: TrackedFile[];
}

function buildTree(files: TrackedFile[]): TreeNode {
  const root: TreeNode = { name: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.sharedPath.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!;
      const child = node.dirs.get(segment) ?? { name: segment, dirs: new Map(), files: [] };
      node.dirs.set(segment, child);
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

/** 目录在前、文件在后，各自按路径排序；叶子始终输出完整 sharedPath，方便整条复制认领 */
function renderTree(
  node: TreeNode,
  depth: number,
  lines: string[],
  claimsByFile: Map<string, Claim>,
): void {
  const pad = '  '.repeat(depth);
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.sharedPath.localeCompare(b.sharedPath));
  for (const dir of dirs) {
    lines.push(`${pad}- \`${dir.name}/\``);
    renderTree(dir, depth + 1, lines, claimsByFile);
  }
  for (const file of files) {
    lines.push(`${pad}${renderFileLine(file, claimsByFile)}`);
  }
}

function renderFileLine(file: TrackedFile, claimsByFile: Map<string, Claim>): string {
  const claim = claimsByFile.get(fileKey(file.locale, file.sharedPath));
  const checked = claim ? 'x' : ' ';
  const owner = claim
    ? ` — @${claim.user} · ${claim.claimedAt.slice(0, 10)}${claim.prUrl ? ` · [PR](${claim.prUrl})` : ''}`
    : '';
  return `- [${checked}] \`${file.sharedPath}\`${STATUS_BADGE[file.status]}${owner}`;
}
