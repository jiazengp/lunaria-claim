import type { FileListStyle } from './config.js';
import {
  activeClaims,
  type Claim,
  type FileStatusKind,
  fileKey,
  type LocaleSection,
  STATE_CLOSE,
  STATE_OPEN,
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

const STATE_REGION_RE = new RegExp(
  `${escapeRegExp(STATE_OPEN)}\\n[\\s\\S]*?\\n${escapeRegExp(STATE_CLOSE)}`,
);

/** {{files}} 或 {{files_<lang>}}，lang 为 lunaria 配置里的语言代码（如 ja、zh-CN） */
const FILES_PLACEHOLDER_RE = /\{\{\s*files(?:_([A-Za-z0-9-]+))?\s*\}\}/g;

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
  return replaceOutsideHtmlComments(
    template,
    /\{\{\s*([a-z_]+)\s*\}\}/gi,
    (match, key: string) => vars[key] ?? match,
  );
}

/** 只替换 HTML 注释之外的占位符——注释里的 `{{...}}` 是给人看的示例，不该被展开 */
function replaceOutsideHtmlComments(
  source: string,
  pattern: RegExp,
  replacer: (...args: string[]) => string,
): string {
  const commentRe = /<!--[\s\S]*?-->/g;
  let out = '';
  let cursor = 0;
  for (const comment of source.matchAll(commentRe)) {
    const start = comment.index ?? 0;
    out += source.slice(cursor, start).replace(pattern, replacer);
    out += comment[0];
    cursor = start + comment[0].length;
  }
  out += source.slice(cursor).replace(pattern, replacer);
  return out;
}

function hasOutsideComments(source: string, pattern: RegExp): boolean {
  const commentRe = /<!--[\s\S]*?-->/g;
  let cursor = 0;
  for (const comment of source.matchAll(commentRe)) {
    const start = comment.index ?? 0;
    if (pattern.test(source.slice(cursor, start))) return true;
    cursor = start + comment[0].length;
  }
  return pattern.test(source.slice(cursor));
}

/**
 * 用 state + 清单重渲染 body：
 * - `<!-- LUNARIA-CLAIM:STATE v1 -->` 状态块整体替换；
 * - `{{files}}` 渲染所有语言的清单，`{{files_<lang>}}` 渲染单个语言（可散置、可插入任意文字）；
 * 其余内容原样保留。
 */
export function renderBody(
  body: string,
  sections: LocaleSection[],
  state: TrackerState,
  options: RenderOptions,
): string {
  if (!STATE_REGION_RE.test(body)) {
    throw new Error('body is missing the LUNARIA-CLAIM:STATE markers');
  }
  if (!hasOutsideComments(body, FILES_PLACEHOLDER_RE)) {
    throw new Error('body is missing {{files}} or a {{files_<lang>}} placeholder');
  }
  const claimsByFile = new Map(
    activeClaims(state).map((claim) => [fileKey(claim.locale, claim.path), claim]),
  );
  const byLocale = new Map(
    sections.map((section) => [section.locale, renderSection(section, claimsByFile, options)]),
  );
  const all = sections
    .filter((section) => section.files.length > 0)
    .map((section) => byLocale.get(section.locale) ?? '')
    .join('\n\n');
  return replaceOutsideHtmlComments(body, FILES_PLACEHOLDER_RE, (match, locale?: string) => {
    if (!locale) return all;
    // 该语言暂无待翻译文件或语言代码拼错时，占位符原样保留，便于发现
    return byLocale.get(locale) ?? match;
  }).replace(STATE_REGION_RE, () => serializeState(state));
}

export interface ViewCheckbox {
  locale: string;
  sharedPath: string;
  checked: boolean;
}

/** 从 body 的可见清单解析勾选状态；语言上下文取最近的上方 `### 🌐 <lang>` 标题 */
export function parseViewCheckboxes(body: string): ViewCheckbox[] {
  const HEADING_RE = /^### 🌐 ([A-Za-z0-9-]+)$/;
  const CHECKBOX_RE = /^ {0,10}- \[([ xX])\] `([^`]+)`/;
  const entries: ViewCheckbox[] = [];
  let locale: string | null = null;
  for (const line of body.split('\n')) {
    const heading = HEADING_RE.exec(line.trimEnd());
    if (heading?.[1]) {
      locale = heading[1];
      continue;
    }
    if (!locale) continue;
    const checkbox = CHECKBOX_RE.exec(line);
    if (!checkbox?.[1] || !checkbox[2]) continue;
    entries.push({ locale, sharedPath: checkbox[2], checked: checkbox[1] !== ' ' });
  }
  return entries;
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
