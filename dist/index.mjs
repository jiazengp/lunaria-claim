import * as core from "@actions/core";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { Octokit } from "@octokit/action";
//#region src/config.ts
const ModeSchema = z.enum([
	"sync",
	"claim",
	"expire",
	"link-pr"
]);
const FileListStyleSchema = z.enum(["tree", "flat"]);
const ClaimConfigSchema = z.object({
	issue: z.object({
		title: z.string().default("🙋 翻译认领"),
		label: z.string().default("lunaria-claim"),
		/** true 时按语言拆分子 issue（M5），默认单 issue + 超长折叠 */
		perLocale: z.boolean().default(false)
	}).default({
		title: "🙋 翻译认领",
		label: "lunaria-claim",
		perLocale: false
	}),
	/** 认领后未提交 PR 的最长保留天数 */
	ttlDays: z.number().int().positive().default(15),
	/** true 时只接受 /claim 命令；false 时评论含清单内完整路径也算认领 */
	strictClaimSyntax: z.boolean().default(false),
	/** 宽松模式下判定认领意图的关键词 */
	lenientKeywords: z.array(z.string()).default([
		"认领",
		"领取",
		"claim",
		"我来",
		"接单"
	]),
	/** 单语言区块超过该条数后用 <details> 折叠 */
	collapseThreshold: z.number().int().positive().default(30),
	/** 清单展示：tree 按目录嵌套，flat 平铺 */
	fileListStyle: FileListStyleSchema.default("tree"),
	/** issue body 模板文件位置，默认 .github/lunaria-claim.md */
	templatePath: z.string().default(".github/lunaria-claim.md"),
	dashboardUrl: z.string().optional(),
	messages: z.record(z.string(), z.string()).default({})
});
function parseInputs(raw) {
	const token = raw.token || process.env.GITHUB_TOKEN || "";
	if (!token) throw new Error("token is required (action input `token` or env GITHUB_TOKEN)");
	return {
		mode: ModeSchema.parse(raw.mode),
		token,
		statusJsonPath: raw.statusJson || "./dist/lunaria/status.json",
		configPath: raw.configPath || ".github/lunaria-claim.yml",
		dryRun: raw.dryRun === "true"
	};
}
function loadConfig(path) {
	const raw = parse(readFileSync(path, "utf-8"));
	return ClaimConfigSchema.parse(raw ?? {});
}
function repoFromEnv() {
	const full = process.env.GITHUB_REPOSITORY;
	if (!full?.includes("/")) throw new Error("GITHUB_REPOSITORY env is not set (are you running inside a workflow?)");
	const [owner, repo] = full.split("/");
	if (!owner || !repo) throw new Error(`invalid GITHUB_REPOSITORY: ${full}`);
	return {
		owner,
		repo
	};
}
//#endregion
//#region src/github.ts
function createGitHubApi(token, repo) {
	const octokit = new Octokit({ auth: token });
	const { owner, repo: repoName } = repo;
	return {
		async findTrackerIssue(label) {
			const first = (await octokit.paginate(octokit.rest.issues.listForRepo, {
				owner,
				repo: repoName,
				labels: label,
				state: "open",
				per_page: 100
			}))[0];
			return first ? {
				number: first.number,
				title: first.title,
				body: first.body ?? null
			} : null;
		},
		async createIssue({ title, body, labels }) {
			const { data } = await octokit.rest.issues.create({
				owner,
				repo: repoName,
				title,
				body,
				labels
			});
			return data.number;
		},
		async updateIssueBody(issueNumber, body) {
			await octokit.rest.issues.update({
				owner,
				repo: repoName,
				issue_number: issueNumber,
				body
			});
		},
		async getComment(commentId) {
			const { data } = await octokit.rest.issues.getComment({
				owner,
				repo: repoName,
				comment_id: commentId
			});
			return {
				body: data.body ?? "",
				user: data.user?.login ?? "",
				createdAt: data.created_at,
				htmlUrl: data.html_url
			};
		},
		async listComments(issueNumber) {
			return (await octokit.paginate(octokit.rest.issues.listComments, {
				owner,
				repo: repoName,
				issue_number: issueNumber,
				per_page: 100
			})).map((comment) => ({
				id: comment.id,
				user: comment.user?.login ?? "",
				createdAt: comment.created_at,
				htmlUrl: comment.html_url,
				body: comment.body ?? ""
			}));
		},
		async reactToComment(commentId, content) {
			await octokit.rest.reactions.createForIssueComment({
				owner,
				repo: repoName,
				comment_id: commentId,
				content
			}).catch((error) => {
				if (typeof error === "object" && error !== null && "status" in error && error.status === 422) return;
				throw error;
			});
		},
		async addComment(issueNumber, body) {
			await octokit.rest.issues.createComment({
				owner,
				repo: repoName,
				issue_number: issueNumber,
				body
			});
		},
		async listPullRequestFiles(prNumber) {
			return (await octokit.paginate(octokit.rest.pulls.listFiles, {
				owner,
				repo: repoName,
				pull_number: prNumber,
				per_page: 100
			})).map((file) => file.filename);
		}
	};
}
//#endregion
//#region src/messages.ts
const DEFAULT_MESSAGES = {
	duplicate: "👀 `{path}`（{locale}）已被 @{claimer} 认领，请选择清单里其他未认领的文件。",
	unknown_file: "❓ 清单里没有找到 `{token}`（可能已完成翻译），请从清单中复制完整文件路径后重试。",
	ambiguous: "❓ `{token}` 匹配到多个文件：{candidates}。请使用完整路径，或在前面注明语言，例如 `en/{token}`。",
	expired: "⏰ @{user} 认领的 `{path}`（{locale}）已超过 {ttlDays} 天未提交 PR，已自动释放回待认领清单，欢迎之后重新认领。",
	pr_closed: "↩️ @{user} 的 PR 已关闭且未合并，以下认领已释放回清单：{paths}",
	dir_skipped: "📚 `{dir}` 认领了 {claimed} 个文件；另有 {skippedCount} 个已被他人认领，自动跳过：{skipped}"
};
function message(config, key, vars = {}) {
	return (config.messages[key] ?? DEFAULT_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
}
//#endregion
//#region src/model.ts
const STATE_OPEN = "<!-- LUNARIA-CLAIM:STATE v1 -->";
const STATE_CLOSE = "<!-- /LUNARIA-CLAIM:STATE -->";
function fileKey(locale, sharedPath) {
	return `${locale}::${sharedPath}`;
}
function activeClaims(state) {
	return state.claims.filter((claim) => !claim.releasedAt);
}
function groupByLocale(files) {
	const map = /* @__PURE__ */ new Map();
	for (const file of files) {
		const list = map.get(file.locale) ?? [];
		list.push(file);
		map.set(file.locale, list);
	}
	return [...map.entries()].map(([locale, sectionFiles]) => ({
		locale,
		files: sectionFiles
	})).sort((a, b) => a.locale.localeCompare(b.locale));
}
//#endregion
//#region src/utils.ts
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/state.ts
const STATE_BLOCK_RE = new RegExp(`${escapeRegExp(STATE_OPEN)}\\n([\\s\\S]*?)\\n${escapeRegExp(STATE_CLOSE)}`);
function serializeState(state) {
	return `${STATE_OPEN}\n${JSON.stringify(state)}\n${STATE_CLOSE}`;
}
/** 状态块损坏时返回 null，由调用方决定走模板重建或报错 */
function parseState(body) {
	const match = STATE_BLOCK_RE.exec(body);
	if (!match?.[1]) return null;
	try {
		const parsed = JSON.parse(match[1]);
		return isTrackerState(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function isTrackerState(value) {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value;
	return candidate.version === 1 && Array.isArray(candidate.files) && Array.isArray(candidate.claims);
}
//#endregion
//#region src/render.ts
const STATUS_BADGE = {
	missing: "",
	outdated: " ⚠️ 源文件已更新，需要重新翻译",
	done: ""
};
const STATE_REGION_RE = new RegExp(`${escapeRegExp(STATE_OPEN)}\\n[\\s\\S]*?\\n${escapeRegExp(STATE_CLOSE)}`);
/** {{files}} 或 {{files_<lang>}}，lang 为 lunaria 配置里的语言代码（如 ja、zh-CN） */
const FILES_PLACEHOLDER_RE = /\{\{\s*files(?:_([A-Za-z0-9-]+))?\s*\}\}/g;
function renderOptions(config) {
	return {
		collapseThreshold: config.collapseThreshold,
		fileListStyle: config.fileListStyle
	};
}
function applyPlaceholders(template, vars) {
	return replaceOutsideHtmlComments(template, /\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => vars[key] ?? match);
}
/** 只替换 HTML 注释之外的占位符——注释里的 `{{...}}` 是给人看的示例，不该被展开 */
function replaceOutsideHtmlComments(source, pattern, replacer) {
	const commentRe = /<!--[\s\S]*?-->/g;
	let out = "";
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
function hasOutsideComments(source, pattern) {
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
function renderBody(body, sections, state, options) {
	if (!STATE_REGION_RE.test(body)) throw new Error("body is missing the LUNARIA-CLAIM:STATE markers");
	if (!hasOutsideComments(body, FILES_PLACEHOLDER_RE)) throw new Error("body is missing {{files}} or a {{files_<lang>}} placeholder");
	const claimsByFile = new Map(activeClaims(state).map((claim) => [fileKey(claim.locale, claim.path), claim]));
	const byLocale = new Map(sections.map((section) => [section.locale, renderSection(section, claimsByFile, options)]));
	const all = sections.filter((section) => section.files.length > 0).map((section) => byLocale.get(section.locale) ?? "").join("\n\n");
	return replaceOutsideHtmlComments(body, FILES_PLACEHOLDER_RE, (match, locale) => {
		if (!locale) return all;
		return byLocale.get(locale) ?? match;
	}).replace(STATE_REGION_RE, () => serializeState(state));
}
/** 从 body 的可见清单解析勾选状态；语言上下文取最近的上方 `### 🌐 <lang>` 标题 */
function parseViewCheckboxes(body) {
	const HEADING_RE = /^### 🌐 ([A-Za-z0-9-]+)$/;
	const CHECKBOX_RE = /^ {0,10}- \[([ xX])\] `([^`]+)`/;
	const entries = [];
	let locale = null;
	for (const line of body.split("\n")) {
		const heading = HEADING_RE.exec(line.trimEnd());
		if (heading?.[1]) {
			locale = heading[1];
			continue;
		}
		if (!locale) continue;
		const checkbox = CHECKBOX_RE.exec(line);
		if (!checkbox?.[1] || !checkbox[2]) continue;
		entries.push({
			locale,
			sharedPath: checkbox[2],
			checked: checkbox[1] !== " "
		});
	}
	return entries;
}
function renderSection(section, claimsByFile, options) {
	const lines = [];
	if (options.fileListStyle === "tree") renderTree(buildTree(section.files), 0, lines, claimsByFile);
	else for (const file of section.files) lines.push(renderFileLine(file, claimsByFile));
	const heading = `### 🌐 ${section.locale}`;
	if (section.files.length > options.collapseThreshold) return `${heading}\n\n<details><summary>共 ${section.files.length} 个文件待处理（点击展开）</summary>\n\n${lines.join("\n")}\n\n</details>`;
	return `${heading}\n\n${lines.join("\n")}`;
}
function buildTree(files) {
	const root = {
		name: "",
		dirs: /* @__PURE__ */ new Map(),
		files: []
	};
	for (const file of files) {
		const parts = file.sharedPath.split("/");
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const segment = parts[i];
			const child = node.dirs.get(segment) ?? {
				name: segment,
				dirs: /* @__PURE__ */ new Map(),
				files: []
			};
			node.dirs.set(segment, child);
			node = child;
		}
		node.files.push(file);
	}
	return root;
}
/** 目录在前、文件在后，各自按路径排序；叶子始终输出完整 sharedPath，方便整条复制认领 */
function renderTree(node, depth, lines, claimsByFile) {
	const pad = "  ".repeat(depth);
	const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
	const files = [...node.files].sort((a, b) => a.sharedPath.localeCompare(b.sharedPath));
	for (const dir of dirs) {
		lines.push(`${pad}- \`${dir.name}/\``);
		renderTree(dir, depth + 1, lines, claimsByFile);
	}
	for (const file of files) lines.push(`${pad}${renderFileLine(file, claimsByFile)}`);
}
function renderFileLine(file, claimsByFile) {
	const claim = claimsByFile.get(fileKey(file.locale, file.sharedPath));
	const checked = claim ? "x" : " ";
	const owner = claim ? ` — @${claim.user} · ${claim.claimedAt.slice(0, 10)}${claim.prUrl ? ` · [PR](${claim.prUrl})` : ""}` : "";
	return `- [${checked}] \`${file.sharedPath}\`${STATUS_BADGE[file.status]}${owner}`;
}
//#endregion
//#region src/resolve.ts
/**
* 把用户输入的路径 token 解析为清单条目（单个文件或整个目录）。接受：
* sharedPath、仓库真实路径（含语言目录）、`语言/路径` 简写、目录前缀（含尾部斜杠）、裸文件名。
*/
function resolveTargets(tokens, state) {
	const entries = [];
	const failures = [];
	for (const raw of tokens) {
		const token = normalizeToken(raw);
		const candidates = scopeByLocale(token, matchFiles(token, state.files));
		if (candidates.length === 0) failures.push({
			token,
			reason: "unknown",
			candidates: []
		});
		else if (isDirToken(token, candidates)) entries.push({
			token,
			kind: "dir",
			files: candidates
		});
		else {
			const first = candidates[0];
			if (candidates.length === 1 && first) entries.push({
				token,
				kind: "file",
				files: [first]
			});
			else failures.push({
				token,
				reason: "ambiguous",
				candidates: candidates.slice(0, 3).map((file) => `${file.sharedPath}（${file.locale}）`)
			});
		}
	}
	return {
		entries,
		failures
	};
}
function normalizeToken(token) {
	return token.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}
function matchFiles(token, files) {
	const matches = /* @__PURE__ */ new Map();
	const add = (file) => matches.set(fileKey(file.locale, file.sharedPath), file);
	const tokenStem = token.replace(/\.[^.]+$/, "");
	for (const file of files) {
		if (file.sharedPath === token || file.sharedPath.replace(/\.[^.]+$/, "") === tokenStem) {
			add(file);
			continue;
		}
		if (file.localizationPath === token || file.localizationPath?.endsWith(`/${token}`)) add(file);
	}
	if (matches.size === 0) {
		for (const file of files) if (token.endsWith(`/${file.sharedPath}`)) add(file);
	}
	for (const file of files) if (file.sharedPath.startsWith(`${token}/`)) add(file);
	for (const file of files) if (file.localizationPath?.startsWith(`${token}/`)) add(file);
	if (!token.includes("/")) {
		for (const file of files) if (file.sharedPath.slice(file.sharedPath.lastIndexOf("/") + 1) === token) add(file);
	}
	return [...matches.values()];
}
/** token 对全部候选都是目录前缀时视为目录认领（否则视为歧义的文件匹配） */
function isDirToken(token, candidates) {
	return candidates.every((file) => file.sharedPath.startsWith(`${token}/`) || file.localizationPath?.startsWith(`${token}/`));
}
/** token 里显式包含语言段（如 `en/foo.md`）时用它消歧 */
function scopeByLocale(token, candidates) {
	if (candidates.length <= 1) return candidates;
	const segments = new Set(token.split("/"));
	const scoped = candidates.filter((file) => segments.has(file.locale));
	return scoped.length > 0 ? scoped : candidates;
}
//#endregion
//#region src/claims.ts
/**
* 把解析出的条目应用到状态：单文件认领一条，目录认领展开为其下所有文件。
* 已被他人认领的跳过（目录级返回聚合信息），自己已认领的幂等视为成功。
*/
function applyClaimEntries(state, entries, user, claimedAt, commentId, commentUrl) {
	let created = 0;
	const skipped = [];
	for (const entry of entries) for (const file of entry.files) {
		const key = fileKey(file.locale, file.sharedPath);
		const existing = activeClaims(state).find((claim) => fileKey(claim.locale, claim.path) === key);
		if (existing && existing.user !== user) {
			skipped.push({
				path: file.sharedPath,
				locale: file.locale,
				claimer: existing.user,
				dir: entry.kind === "dir" ? entry.token : void 0
			});
			continue;
		}
		if (!existing) {
			state.claims.push({
				path: file.sharedPath,
				locale: file.locale,
				user,
				claimedAt,
				commentId,
				commentUrl
			});
			created++;
		}
	}
	return {
		created,
		skipped
	};
}
const CLAIM_RE = /^\/claim\s+(.+)$/i;
const RELEASE_RE = /^\/(?:release|give-up)\s+(.+)$/i;
/** 每行一条命令，未匹配的行忽略 */
function parseClaimComment(body) {
	const commands = [];
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		const claim = CLAIM_RE.exec(line);
		if (claim?.[1]) {
			const paths = splitPaths(claim[1]);
			if (paths.length > 0) commands.push({
				kind: "claim",
				paths
			});
			continue;
		}
		const release = RELEASE_RE.exec(line);
		if (release?.[1]) {
			const paths = splitPaths(release[1]);
			if (paths.length > 0) commands.push({
				kind: "release",
				paths
			});
		}
	}
	return commands;
}
function splitPaths(fragment) {
	return fragment.split(/\s+/).map((token) => token.replace(/^\[`(.+?)`\]\(.+?\)$/, "$1").replace(/^\[(.+?)\]\(.+?\)$/, "$1").replace(/^[`'"]+/, "").replace(/[`'".,;，。]+$/, "")).filter((token) => token.length > 0 && !token.startsWith("<"));
}
/** 宽松模式：从自由文本中找出清单里出现过的文件路径 */
function extractKnownPaths(text, known) {
	return known.filter((path) => new RegExp(`(?<![\\w/.-])${escapeRegExp(path)}(?![\\w/.-])`).test(text));
}
function hasIntent(body, keywords) {
	const lower = body.toLowerCase();
	return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}
function findExpiredClaims(state, now, ttlDays) {
	const ttlMs = ttlDays * 24 * 60 * 60 * 1e3;
	return activeClaims(state).filter((claim) => !claim.prUrl && now.getTime() - Date.parse(claim.claimedAt) > ttlMs);
}
/**
* 管理员手动编辑兼容：把可见清单里的"取消勾选 / 整行删除"反写回状态，按手动释放处理。
* 读 body 时如果连一个语言区块都没解析出来，放弃本次对账（避免误释放）。
*/
function applyViewEdits(state, body, now) {
	const view = parseViewCheckboxes(body);
	if (view.length === 0) return 0;
	const byKey = new Map(view.map((entry) => [fileKey(entry.locale, entry.sharedPath), entry]));
	let released = 0;
	for (const claim of activeClaims(state)) {
		if (byKey.get(fileKey(claim.locale, claim.path))?.checked) continue;
		claim.releasedAt = now.toISOString();
		claim.releaseReason = "manual";
		released++;
	}
	return released;
}
/**
* 状态块损坏时的尽力自愈：按时间顺序回放评论里的 /claim、/release 命令，
* 重建活跃认领。返回值为空时调用方应放弃（评论里没有任何可识别的认领）。
*/
function rebuildClaimsFromComments(comments, files, config) {
	const skippedBot = comments.filter((comment) => comment.user.endsWith("[bot]")).length;
	const pending = /* @__PURE__ */ new Map();
	const known = files.map((file) => file.sharedPath);
	for (const comment of comments) {
		if (comment.user.endsWith("[bot]")) continue;
		const commands = parseClaimComment(comment.body);
		const claimTokens = commands.filter((c) => c.kind === "claim").flatMap((c) => c.paths);
		const releaseTokens = commands.filter((c) => c.kind === "release").flatMap((c) => c.paths);
		if (claimTokens.length === 0 && !config.strictClaimSyntax && hasIntent(comment.body, config.lenientKeywords)) claimTokens.push(...extractKnownPaths(comment.body, known));
		const { entries } = resolveTargets(claimTokens, {
			version: 1,
			files: [...files],
			claims: []
		});
		for (const entry of entries) for (const file of entry.files) {
			const key = `${comment.user}::${fileKey(file.locale, file.sharedPath)}`;
			if (!pending.has(key)) pending.set(key, {
				user: comment.user,
				claimedAt: comment.createdAt,
				commentId: comment.id,
				commentUrl: comment.htmlUrl,
				path: file.sharedPath,
				locale: file.locale
			});
		}
		const releases = resolveTargets(releaseTokens, {
			version: 1,
			files: [...files],
			claims: []
		});
		for (const entry of releases.entries) for (const file of entry.files) pending.delete(`${comment.user}::${fileKey(file.locale, file.sharedPath)}`);
	}
	return {
		claims: [...pending.values()].map((value) => ({ ...value })),
		skippedBot
	};
}
/** 把解析/应用结果编排成对认领评论的回复：目录级跳过聚合、单文件跳过逐条、失败映射 */
function composeClaimReplies(input) {
	const { entries, failures, skipped, config } = input;
	const replies = [];
	for (const failure of failures) replies.push(failure.reason === "ambiguous" ? message(config, "ambiguous", {
		token: failure.token,
		candidates: failure.candidates.join("、")
	}) : message(config, "unknown_file", { token: failure.token }));
	const dirSkips = /* @__PURE__ */ new Map();
	for (const item of skipped) if (item.dir) {
		const list = dirSkips.get(item.dir) ?? [];
		list.push(item);
		dirSkips.set(item.dir, list);
	} else replies.push(message(config, "duplicate", {
		path: item.path,
		locale: item.locale,
		claimer: item.claimer
	}));
	for (const entry of entries) {
		if (entry.kind !== "dir") continue;
		const list = dirSkips.get(entry.token);
		if (!list) continue;
		const shown = list.slice(0, 3).map((skip) => `\`${skip.path}\`（@${skip.claimer}）`).join("、");
		const more = list.length > 3 ? ` 等 ${list.length} 个` : "";
		replies.push(message(config, "dir_skipped", {
			dir: entry.token,
			claimed: String(entry.files.length - list.length),
			skippedCount: String(list.length),
			skipped: shown + more
		}));
	}
	return replies;
}
//#endregion
//#region src/event.ts
function readEventPayload() {
	const path = process.env.GITHUB_EVENT_PATH;
	if (!path) throw new Error("GITHUB_EVENT_PATH is not set (are you running inside a workflow?)");
	return JSON.parse(readFileSync(path, "utf-8"));
}
//#endregion
//#region src/modes/claim.ts
async function runClaim(ctx) {
	const event = readEventPayload();
	const user = event.comment.user.login;
	if (user.endsWith("[bot]")) {
		core.info("bot comment, skipping");
		return;
	}
	const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
	if (!issue?.body || issue.number !== event.issue.number) {
		core.info("comment is not on the tracker issue, skipping");
		return;
	}
	const state = parseState(issue.body);
	if (!state) throw new Error(`tracker issue #${issue.number} has no readable state block`);
	const releasedByView = applyViewEdits(state, issue.body, ctx.now);
	if (releasedByView > 0) core.info(`manual view edits released ${releasedByView} claim(s) before claim processing`);
	const body = event.comment.body;
	const commands = parseClaimComment(body);
	const claimTokens = commands.filter((c) => c.kind === "claim").flatMap((c) => c.paths);
	const releaseTokens = commands.filter((c) => c.kind === "release").flatMap((c) => c.paths);
	const lenientTokens = claimTokens.length === 0 && !ctx.config.strictClaimSyntax && hasIntent(body, ctx.config.lenientKeywords) ? lenientTargets(body, state) : [];
	if (claimTokens.length === 0 && releaseTokens.length === 0 && lenientTokens.length === 0) {
		core.info("no claim/release intent found, treating as a normal comment");
		return;
	}
	const before = JSON.stringify(state.claims);
	const replies = [];
	let claimedAny = false;
	let releasedAny = false;
	const { entries, failures } = resolveTargets([...claimTokens, ...lenientTokens], state);
	const application = applyClaimEntries(state, entries, user, event.comment.created_at, event.comment.id, event.comment.html_url);
	claimedAny = application.created > 0;
	replies.push(...composeClaimReplies({
		entries,
		failures,
		skipped: application.skipped,
		config: ctx.config
	}));
	for (const token of releaseTokens) {
		const release = resolveTargets([token], state);
		for (const failure of release.failures) replies.push(message(ctx.config, "unknown_file", { token: failure.token }));
		for (const entry of release.entries) for (const file of entry.files) {
			const own = activeClaims(state).find((claim) => claim.user === user && fileKey(claim.locale, claim.path) === fileKey(file.locale, file.sharedPath));
			if (own) {
				own.releasedAt = ctx.now.toISOString();
				own.releaseReason = "voluntary";
				releasedAny = true;
			}
		}
	}
	const changed = before !== JSON.stringify(state.claims);
	if (changed) {
		const updated = renderBody(issue.body, groupByLocale(state.files), state, renderOptions(ctx.config));
		await ctx.api.updateIssueBody(issue.number, updated);
	}
	if (claimedAny) await ctx.api.reactToComment(event.comment.id, "rocket");
	else if (releasedAny) await ctx.api.reactToComment(event.comment.id, "eyes");
	if (replies.length > 0) {
		await ctx.api.addComment(issue.number, replies.join("\n\n"));
		await ctx.api.reactToComment(event.comment.id, "confused");
	}
	core.info(`claim processing done: ${entries.length} entry(ies), ${failures.length} failed, changed=${changed}`);
	await writeStepSummary([
		`**🤖 认领处理（issue #${event.issue.number}）**`,
		`- 认领：${application.created} 条；跳过 ${application.skipped.length} 条冲突；失败 ${failures.length} 条`,
		releasedAny ? `- 主动放弃：${releaseTokens.length} 个目标` : null,
		replies.length > 0 ? `- 回复：${replies.length} 条提示评论` : null,
		changed ? "- body 已更新" : "- body 无变化"
	].filter((line) => line !== null).join("\n"));
}
/** 宽松模式：先对齐清单里出现的完整 sharedPath，再看目录前缀（如 `src/manual/`） */
function lenientTargets(body, state) {
	const known = new Set(state.files.map((file) => file.sharedPath));
	for (const file of state.files) {
		const parts = file.sharedPath.split("/");
		for (let i = 1; i < parts.length; i++) known.add(`${parts.slice(0, i).join("/")}/`);
	}
	return extractKnownPaths(body, [...known]);
}
//#endregion
//#region src/modes/expire.ts
async function runExpire(ctx) {
	const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
	if (!issue?.body) {
		core.info("no tracker issue found, nothing to sweep");
		return;
	}
	const state = parseState(issue.body);
	if (!state) throw new Error(`tracker issue #${issue.number} has no readable state block`);
	const releasedByView = applyViewEdits(state, issue.body, ctx.now);
	if (releasedByView > 0) core.info(`manual view edits released ${releasedByView} claim(s) before expiry sweep`);
	const expired = findExpiredClaims(state, ctx.now, ctx.config.ttlDays);
	if (expired.length === 0) {
		core.info("no expired claims");
		return;
	}
	for (const claim of expired) {
		claim.releasedAt = ctx.now.toISOString();
		claim.releaseReason = "expired";
		await ctx.api.addComment(issue.number, message(ctx.config, "expired", {
			user: claim.user,
			path: claim.path,
			locale: claim.locale,
			ttlDays: String(ctx.config.ttlDays)
		}));
	}
	const body = renderBody(issue.body, groupByLocale(state.files), state, renderOptions(ctx.config));
	await ctx.api.updateIssueBody(issue.number, body);
	core.info(`released ${expired.length} expired claim(s) on issue #${issue.number}`);
	await writeStepSummary(`**⏰ 超期清扫（issue #${issue.number}）**

- 释放：${expired.length} 条超期认领
- 已发提醒评论：${expired.length} 条
`);
}
//#endregion
//#region src/modes/link-pr.ts
async function runLinkPr(ctx) {
	const event = readEventPayload();
	const pr = event.pull_request;
	const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
	if (!issue?.body) {
		core.info("no tracker issue found, nothing to link");
		return;
	}
	const state = parseState(issue.body);
	if (!state) throw new Error(`tracker issue #${issue.number} has no readable state block`);
	const releasedByView = applyViewEdits(state, issue.body, ctx.now);
	if (releasedByView > 0) core.info(`manual view edits released ${releasedByView} claim(s) before PR linking`);
	if (event.action === "closed") {
		await handleClosed(ctx, issue.number, issue.body, state, pr);
		return;
	}
	const changedFiles = new Set(await ctx.api.listPullRequestFiles(pr.number));
	const linked = [];
	for (const claim of activeClaims(state)) {
		if (claim.prUrl || claim.user !== pr.user.login) continue;
		const file = state.files.find((candidate) => fileKey(candidate.locale, candidate.sharedPath) === fileKey(claim.locale, claim.path));
		if (changedFiles.has(claim.path) || file?.localizationPath && changedFiles.has(file.localizationPath)) {
			claim.prUrl = pr.html_url;
			linked.push(`\`${claim.path}\`（${claim.locale}）`);
		}
	}
	if (linked.length === 0) {
		core.info(`PR #${pr.number} does not match any active claim`);
		return;
	}
	const updated = renderBody(issue.body, groupByLocale(state.files), state, renderOptions(ctx.config));
	await ctx.api.updateIssueBody(issue.number, updated);
	core.info(`linked PR #${pr.number} to ${linked.length} claim(s), expiry frozen`);
	await writeStepSummary(`**🔗 PR 关联（PR #${pr.number}）**

- 已关联 ${linked.length} 条认领，过期计时已冻结，
- body 已更新。`);
}
async function handleClosed(ctx, issueNumber, body, state, pr) {
	if (pr.merged) {
		core.info(`PR #${pr.number} merged; sync will settle the list`);
		return;
	}
	const released = [];
	for (const claim of activeClaims(state)) if (claim.prUrl === pr.html_url) {
		claim.releasedAt = ctx.now.toISOString();
		claim.releaseReason = "pr-closed";
		released.push(`\`${claim.path}\`（${claim.locale}）`);
	}
	if (released.length === 0) {
		core.info("no claims linked to this PR");
		return;
	}
	const updated = renderBody(body, groupByLocale(state.files), state, renderOptions(ctx.config));
	await ctx.api.updateIssueBody(issueNumber, updated);
	await ctx.api.addComment(issueNumber, message(ctx.config, "pr_closed", {
		user: pr.user.login,
		paths: released.join("、")
	}));
	core.info(`released ${released.length} claim(s) after PR #${pr.number} closed unmerged`);
	await writeStepSummary(`**↩️ PR 关闭未合并（PR #${pr.number}）**

- 释放 ${released.length} 条认领并回复提醒。`);
}
//#endregion
//#region src/lunaria.ts
function readLunariaStatus(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}
/** done 不进认领清单：翻译完成与否完全以 Lunaria 为准，由 sync 对账移出 */
function toTrackedFiles(status, locales) {
	const files = [];
	for (const item of status) for (const locale of locales) {
		const loc = item.localizations[locale];
		if (!loc) continue;
		const derived = item.sourceFile.path.includes(`/${item.sourceFile.lang}/`) ? item.sourceFile.path.replace(`/${item.sourceFile.lang}/`, `/${locale}/`) : void 0;
		const localizationPath = !loc.isMissing && loc.path ? loc.path : derived;
		if (loc.isMissing) files.push({
			sharedPath: item.sharedPath,
			locale,
			status: "missing",
			localizationPath
		});
		else if (loc.isOutdated) files.push({
			sharedPath: item.sharedPath,
			locale,
			status: "outdated",
			localizationPath
		});
	}
	return files;
}
//#endregion
//#region src/reconcile.ts
/** sync 对账：以 lunaria status.json 派生的清单为准收敛 files 与 claims */
function reconcile(current, desiredFiles, now) {
	const desiredKeys = new Set(desiredFiles.map((file) => fileKey(file.locale, file.sharedPath)));
	const claims = current.claims.map((claim) => {
		if (claim.releasedAt || desiredKeys.has(fileKey(claim.locale, claim.path))) return claim;
		return {
			...claim,
			releasedAt: now.toISOString(),
			releaseReason: "completed"
		};
	});
	const state = {
		version: 1,
		files: desiredFiles,
		claims
	};
	const changed = JSON.stringify({
		files: current.files,
		claims: current.claims
	}) !== JSON.stringify({
		files: desiredFiles,
		claims
	});
	return {
		state,
		sections: groupByLocale(desiredFiles),
		changed
	};
}
//#endregion
//#region src/modes/sync.ts
async function runSync(ctx) {
	const { statusJsonPath, dryRun } = ctx.inputs;
	if (!existsSync(statusJsonPath)) throw new Error(`status.json not found at ${statusJsonPath} — check the \`outDir\` in lunaria.config.json; status.json lives under your outDir (the default './dist/lunaria/status.json' is only an example).`);
	const template = readFileSync(ctx.config.templatePath, "utf-8");
	const status = readLunariaStatus(statusJsonPath);
	const desiredFiles = toTrackedFiles(status, [...new Set(status.flatMap((item) => Object.keys(item.localizations)))]);
	core.info(`lunaria status: ${status.length} shared paths, ${desiredFiles.length} entries needing translation`);
	const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
	let current;
	let baseBody;
	let rebuiltClaims = 0;
	if (!issue) {
		current = {
			version: 1,
			files: desiredFiles,
			claims: []
		};
		baseBody = template;
	} else {
		baseBody = issue.body ?? template;
		const parsed = parseState(baseBody);
		if (parsed) current = parsed;
		else {
			current = await rebuildTrackerState(ctx, issue.number, desiredFiles);
			rebuiltClaims = current.claims.length;
		}
	}
	const releasedByView = applyViewEdits(current, baseBody, ctx.now);
	const { state, sections, changed } = reconcile(current, desiredFiles, ctx.now);
	const rendered = applyPlaceholders(renderBody(baseBody, sections, state, renderOptions(ctx.config)), {
		ttl_days: String(ctx.config.ttlDays),
		dashboard_url: ctx.config.dashboardUrl ?? ""
	});
	if (dryRun) {
		await writeSyncSummary(ctx, state, rendered, {
			preview: true,
			issueNumber: issue?.number ?? null,
			rebuiltClaims,
			releasedByView
		});
		return;
	}
	if (!issue) {
		const number = await ctx.api.createIssue({
			title: ctx.config.issue.title,
			body: rendered,
			labels: [ctx.config.issue.label]
		});
		core.setOutput("issue-url", `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/issues/${number}`);
		await writeSyncSummary(ctx, state, rendered, {
			preview: false,
			issueNumber: number,
			rebuiltClaims,
			releasedByView
		});
		return;
	}
	if (!changed && rebuiltClaims === 0) {
		core.info(`tracker issue #${issue.number} is up to date`);
		core.setOutput("issue-url", `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/issues/${issue.number}`);
		return;
	}
	await ctx.api.updateIssueBody(issue.number, rendered);
	core.setOutput("issue-url", `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/issues/${issue.number}`);
	await writeSyncSummary(ctx, state, rendered, {
		preview: false,
		issueNumber: issue.number,
		rebuiltClaims,
		releasedByView
	});
}
/** 状态块损坏时的自愈：从认领评论回放重建，并告知 contributors 重建结果 */
async function rebuildTrackerState(ctx, issueNumber, files) {
	core.warning(`tracker issue #${issueNumber} state block is unreadable — rebuilding from claim comments`);
	const { claims, skippedBot } = rebuildClaimsFromComments(await ctx.api.listComments(issueNumber), files, ctx.config);
	await ctx.api.addComment(issueNumber, `♻️ 认领状态块已损坏，已从认领评论重建 ${claims.length} 条活跃认领` + (skippedBot > 0 ? `（忽略 ${skippedBot} 条 bot 评论）` : "") + "。如有遗漏请重新认领。");
	return {
		version: 1,
		files,
		claims
	};
}
async function writeSyncSummary(ctx, state, rendered, info) {
	let body = `**${info.preview ? "🔍 模板预览（dry-run，未写入任何内容）" : "🤖 认领看板已更新"}**\n\n`;
	if (info.preview) {
		body += "```markdown\n";
		body += rendered.length > 12e3 ? `${rendered.slice(0, 12e3)}\n…（预览截断）` : rendered;
		body += "\n```\n\n";
	} else {
		body += `- 认领 issue：${info.issueNumber ?? "（未找到）"}\n`;
		body += `- 待翻译条目：${state.files.length}\n`;
	}
	const notes = [];
	if (info.releasedByView > 0) notes.push(`管理员手动取消勾选 ${info.releasedByView} 条，已释放`);
	if (info.rebuiltClaims > 0) notes.push(`状态块损坏，已自愈重建 ${info.rebuiltClaims} 条认领`);
	if (notes.length > 0) body += `- ${notes.join("；")}\n`;
	await writeStepSummary(body);
}
//#endregion
//#region src/modes/index.ts
/** 写入 GitHub Step Summary；环境不支持时降级为日志，不失败 */
async function writeStepSummary(content) {
	try {
		await core.summary.addRaw(content).write();
	} catch (error) {
		core.warning(`step summary unavailable: ${String(error)}`);
	}
}
async function runMode(inputs) {
	const repo = repoFromEnv();
	const ctx = {
		inputs,
		config: loadConfig(inputs.configPath),
		api: createGitHubApi(inputs.token, repo),
		repo,
		now: /* @__PURE__ */ new Date()
	};
	switch (inputs.mode) {
		case "sync": return runSync(ctx);
		case "claim": return runClaim(ctx);
		case "expire": return runExpire(ctx);
		case "link-pr": return runLinkPr(ctx);
	}
}
//#endregion
//#region src/index.ts
async function main() {
	await runMode(parseInputs({
		mode: core.getInput("mode", { required: true }),
		token: core.getInput("token"),
		statusJson: core.getInput("status-json"),
		configPath: core.getInput("config-path"),
		dryRun: core.getBooleanInput("dry-run") ? "true" : "false"
	}));
}
main().catch((error) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
//#endregion
export {};

//# sourceMappingURL=index.mjs.map