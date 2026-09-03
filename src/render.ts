import type { FileListStyle } from './config.js';
import {
  activeClaims,
  type Claim,
  FILES_CLOSE,
  FILES_OPEN,
  fileKey,
  type LocaleSection,
  STATE_CLOSE,
  STATE_OPEN,
  type TrackedFile,
  type TrackerState,
} from './model.js';
import { serializeState } from './state.js';
import { escapeRegExp } from './utils.js';

const STATE_REGION_RE = new RegExp(
  `${escapeRegExp(STATE_OPEN)}\\n[\\s\\S]*?\\n${escapeRegExp(STATE_CLOSE)}`,
);

/** 默认模板的 FILES 标记区（含标记行整体） */
const FILES_REGION_RE = new RegExp(
  `${escapeRegExp(FILES_OPEN)}[\\s\\S]*?${escapeRegExp(FILES_CLOSE)}`,
);

/** {{files}} 或 {{files_<lang>}}，lang 为 lunaria 配置里的语言代码（如 ja、zh-CN） */
const FILES_PLACEHOLDER_RE = /\{\{\s*files(?:_([A-Za-z0-9-]+))?\s*\}\}/g;

/** 模板里是否存在按语言分区占位符（{{files_<lang>}}） */
const PER_LOCALE_PLACEHOLDER_RE = /\{\{\s*files_[A-Za-z0-9-]+\s*\}\}/;

export interface RenderOptions {
  collapseThreshold: number;
  fileListStyle: FileListStyle;
  /** 仓库主页地址（如 https://github.com/owner/repo），提供后路径/链接才渲染 */
  repoUrl?: string;
  /** 认领文件所在的分支；缺省时从 sourceUrl 推断，再兜底 main */
  branch?: string;
}

export function renderOptions(
  config: { collapseThreshold: number; fileListStyle: FileListStyle },
  repo?: { owner: string; repo: string },
  files?: readonly TrackedFile[],
): RenderOptions {
  return {
    collapseThreshold: config.collapseThreshold,
    fileListStyle: config.fileListStyle,
    repoUrl: repo ? `https://github.com/${repo.owner}/${repo.repo}` : undefined,
    branch: files ? resolveBranch(files) : 'main',
  };
}

/** 列表展示的路径：目标语言文件（localizationPath）优先，缺省退到 sharedPath */
export function displayPath(file: TrackedFile): string {
  return file.localizationPath ?? file.sharedPath;
}

/** 从 sourceUrl（.../blob/<branch>/...）推断默认分支 */
export function resolveBranch(files: readonly TrackedFile[]): string {
  for (const file of files) {
    const match = /\/blob\/([^/]+)\//.exec(file.sourceUrl ?? '');
    if (match?.[1]) return match[1];
  }
  return 'main';
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
  // 非全局克隆：/g 的 lastIndex 会跨调用残留，造成误判
  const re = new RegExp(pattern.source);
  const commentRe = /<!--[\s\S]*?-->/g;
  let cursor = 0;
  for (const comment of source.matchAll(commentRe)) {
    const start = comment.index ?? 0;
    if (re.test(source.slice(cursor, start))) return true;
    cursor = start + comment[0].length;
  }
  return re.test(source.slice(cursor));
}

/**
 * 用 state + 清单重渲染 body：
 * - `<!-- LUNARIA-CLAIM:STATE v1 -->` 状态块整体替换（JSON 在注释里，正文不可见）；
 * - `{{files}}` 渲染所有语言的清单，`{{files_<lang>}}` 渲染单个语言（可散置、可插入任意文字）；
 * 语言标题由模板书写（占位符周围），bot 不渲染标题。
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
  if (!hasOutsideComments(body, FILES_PLACEHOLDER_RE)) {
    // 已渲染的正文（占位符已被消费）：原位覆盖 FILES 标记区与 STATE 区，保留标记区外的手写内容
    if (!FILES_REGION_RE.test(body)) {
      throw new Error(
        'body is missing {{files}} or a {{files_<lang>}} placeholder ' +
          '(placeholders inside HTML comments are examples, never expanded)',
      );
    }
    const overlay = `${FILES_OPEN}\n${all}\n\n${serializeState(state)}\n${FILES_CLOSE}`;
    return body
      .replace(FILES_REGION_RE, () => overlay)
      .replace(STATE_REGION_RE, () => serializeState(state));
  }
  return replaceOutsideHtmlComments(body, FILES_PLACEHOLDER_RE, (match, locale?: string) => {
    if (!locale) return all;
    // 该语言暂无待翻译文件或语言代码拼错时，占位符原样保留，便于发现
    return byLocale.get(locale) ?? match;
  }).replace(STATE_REGION_RE, () => serializeState(state));
}

/** 模板含按语言分区占位符（{{files_<lang>}}）时，布局以模板为准整体重建 */
export function perLocaleTemplate(template: string): boolean {
  return PER_LOCALE_PLACEHOLDER_RE.test(template);
}

/** 以模板为唯一真相整体重建正文（自定义模板与多占位符模板共用） */
export function rebuildFromTemplate(
  template: string,
  sections: LocaleSection[],
  state: TrackerState,
  vars: Record<string, string>,
  options: RenderOptions,
): string {
  return applyPlaceholders(renderBody(template, sections, state, options), vars);
}

/**
 * 更新已有 issue 的统一入口：优先在原正文上原位覆盖（保留用户手写内容）；
 * 正文已不可用（无占位符也无标记区，如多占位符模板）时回退到按模板整体重建。
 */
export function recomposeBody(
  body: string,
  template: string,
  sections: LocaleSection[],
  state: TrackerState,
  vars: Record<string, string>,
  options: RenderOptions,
): string {
  // 多占位符（按语言分区）模板：布局以模板为准整体重建——正文里的旧分区无法可靠映射
  if (perLocaleTemplate(template)) {
    return rebuildFromTemplate(template, sections, state, vars, options);
  }
  try {
    return applyPlaceholders(renderBody(body, sections, state, options), vars);
  } catch {
    return applyPlaceholders(renderBody(template, sections, state, options), vars);
  }
}

export interface ViewCheckbox {
  locale: string;
  sharedPath: string;
  checked: boolean;
}

/**
 * 从 body 的可见清单解析勾选状态（文件行与目录行都算）。
 * 语言上下文取最近的上方 `### 🌐 <lang>` 标题；没有任何标题时 locale 记空，
 * 由调用方（applyViewEdits）按路径兜底匹配。
 */
export function parseViewCheckboxes(body: string): ViewCheckbox[] {
  const HEADING_RE = /^### 🌐 ([A-Za-z0-9-]+)$/;
  // 链接形态 `- [ ] [`path`](url)` 与纯反引号形态都算；path 取自反引号内容
  const CHECKBOX_RE = /^ {0,10}- \[([ xX])\] \[?`([^`]+)`/;
  const entries: ViewCheckbox[] = [];
  let locale = '';
  for (const line of body.split('\n')) {
    const heading = HEADING_RE.exec(line.trimEnd());
    if (heading?.[1]) {
      locale = heading[1];
      continue;
    }
    const checkbox = CHECKBOX_RE.exec(line);
    if (!checkbox?.[1] || !checkbox[2]) continue;
    entries.push({ locale, sharedPath: checkbox[2], checked: checkbox[1] !== ' ' });
  }
  return entries;
}

/** 区块不渲染语言标题：标题属于模板排版（占位符周围由用户书写） */
function renderSection(
  section: LocaleSection,
  claimsByFile: Map<string, Claim>,
  options: RenderOptions,
): string {
  const lines: string[] = [];
  if (options.fileListStyle === 'tree') {
    renderTree(buildTree(section.files), 0, '', lines, claimsByFile, options);
  } else {
    for (const file of section.files) lines.push(renderFileLine(file, claimsByFile, options));
  }
  if (section.files.length > options.collapseThreshold) {
    return `<details><summary>共 ${section.files.length} 个文件待处理（点击展开）</summary>\n\n${lines.join('\n')}\n\n</details>`;
  }
  return lines.join('\n');
}

interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: TrackedFile[];
}

function buildTree(files: TrackedFile[]): TreeNode {
  const root: TreeNode = { name: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = displayPath(file).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      // parts 的末段是文件名，循环只走到倒数第二段，索引必然存在
      const segment = parts[i]!;
      const child = node.dirs.get(segment) ?? { name: segment, dirs: new Map(), files: [] };
      node.dirs.set(segment, child);
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

/** 目录在前、文件在后，各自按路径排序；目录行可勾选（子树全部认领即打勾），叶子始终输出完整 sharedPath */
function renderTree(
  node: TreeNode,
  depth: number,
  dirPath: string,
  lines: string[],
  claimsByFile: Map<string, Claim>,
  options: RenderOptions,
): void {
  const pad = '  '.repeat(depth);
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.sharedPath.localeCompare(b.sharedPath));
  for (const dir of dirs) {
    const subtree = collectFiles(dir);
    const allClaimed = subtree.every((file) =>
      claimsByFile.has(fileKey(file.locale, file.sharedPath)),
    );
    const full = dirPath ? `${dirPath}/${dir.name}` : dir.name;
    const label = options.repoUrl
      ? `[\`${dir.name}/\`](${options.repoUrl}/tree/${options.branch ?? 'main'}/${full})`
      : `\`${dir.name}/\``;
    lines.push(`${pad}- [${allClaimed ? 'x' : ' '}] ${label}`);
    renderTree(dir, depth + 1, full, lines, claimsByFile, options);
  }
  for (const file of files) {
    lines.push(`${pad}${renderFileLine(file, claimsByFile, options)}`);
  }
}

function collectFiles(node: TreeNode): TrackedFile[] {
  return [...node.files, ...[...node.dirs.values()].flatMap(collectFiles)];
}

function renderFileLine(
  file: TrackedFile,
  claimsByFile: Map<string, Claim>,
  options: RenderOptions,
): string {
  const claim = claimsByFile.get(fileKey(file.locale, file.sharedPath));
  const checked = claim || file.status === 'done' ? 'x' : ' ';
  const repoUrl = options.repoUrl ?? '';
  const branch = options.branch ?? 'main';
  const actionUrl =
    repoUrl && file.localizationPath
      ? file.status === 'missing'
        ? // GitHub 编辑器的规范深链：路径放在 filename 查询参数里（与编辑器自身生成的链接一致）
          `${repoUrl}/new/${branch}?filename=${file.localizationPath}`
        : `${repoUrl}/edit/${branch}/${file.localizationPath}`
      : '';
  const shown = displayPath(file);
  const pathText = actionUrl ? `[\`${shown}\`](${actionUrl})` : `\`${shown}\``;
  let tail = '';
  if (claim) {
    tail = ` — @${claim.user} · ${claim.claimedAt.slice(0, 10)}${claim.prUrl ? ` · [PR](${claim.prUrl})` : ''}`;
  } else if (file.status !== 'done') {
    // 未认领的待翻译行才附参考链接；已完成的行保持干净
    const refs: string[] = [];
    if (file.status === 'missing' && actionUrl) refs.push(`[Create file](${actionUrl})`);
    if (repoUrl && file.sourceUrl) refs.push(`[source](${file.sourceUrl})`);
    if (repoUrl && file.sourceHistoryUrl) refs.push(`[history](${file.sourceHistoryUrl})`);
    if (refs.length > 0) tail = ` · ${refs.join(' · ')}`;
  }
  return `- [${checked}] ${pathText}${tail}`;
}
