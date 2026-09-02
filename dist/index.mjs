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
		templatePath: raw.templatePath || ".github/lunaria-claim.md"
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
//#region src/model.ts
const STATE_OPEN = "<!-- LUNARIA-CLAIM:STATE v1 -->";
const STATE_CLOSE = "<!-- /LUNARIA-CLAIM:STATE -->";
const FILES_OPEN = "<!-- LUNARIA-CLAIM:FILES -->";
const FILES_CLOSE = "<!-- /LUNARIA-CLAIM:FILES -->";
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
//#region src/claims.ts
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
	return fragment.split(/\s+/).map((token) => token.replace(/^\[`(.+?)`\]\(.+?\)$/, "$1").replace(/^\[(.+?)\]\(.+?\)$/, "$1").replace(/^[`'"]+/, "").replace(/[`'"]+$/, "").replace(/[.,;，。]+$/, "")).filter((token) => token.length > 0 && !token.startsWith("<"));
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
//#endregion
//#region src/event.ts
function readEventPayload() {
	const path = process.env.GITHUB_EVENT_PATH;
	if (!path) throw new Error("GITHUB_EVENT_PATH is not set (are you running inside a workflow?)");
	return JSON.parse(readFileSync(path, "utf-8"));
}
//#endregion
//#region src/messages.ts
const DEFAULT_MESSAGES = {
	duplicate: "👀 `{path}`（{locale}）已被 @{claimer} 认领，请选择清单里其他未认领的文件。",
	unknown_file: "❓ 清单里没有找到 `{token}`（可能已完成翻译），请从清单中复制完整文件路径后重试。",
	ambiguous: "❓ `{token}` 匹配到多个文件：{candidates}。请使用完整路径，或在前面注明语言，例如 `en/{token}`。",
	expired: "⏰ @{user} 认领的 `{path}`（{locale}）已超过 {ttlDays} 天未提交 PR，已自动释放回待认领清单，欢迎之后重新认领。",
	pr_closed: "↩️ @{user} 的 PR 已关闭且未合并，以下认领已释放回清单：{paths}"
};
function message(config, key, vars = {}) {
	return (config.messages[key] ?? DEFAULT_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
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
const FILES_REGION_RE = new RegExp(`${escapeRegExp(FILES_OPEN)}[\\s\\S]*?${escapeRegExp(FILES_CLOSE)}`);
function applyPlaceholders(template, vars) {
	return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => vars[key] ?? match);
}
/** 用 state + 清单重渲染 body 中 bot 专属的 FILES 区块，其余内容原样保留 */
function renderBody(body, sections, state, collapseThreshold) {
	const region = renderFilesRegion(sections, state, collapseThreshold);
	if (!FILES_REGION_RE.test(body)) throw new Error("body is missing the LUNARIA-CLAIM:FILES region markers");
	return body.replace(FILES_REGION_RE, () => region);
}
function renderFilesRegion(sections, state, collapseThreshold) {
	const claimsByFile = new Map(activeClaims(state).map((claim) => [fileKey(claim.locale, claim.path), claim]));
	const view = sections.filter((section) => section.files.length > 0).map((section) => renderSection(section, claimsByFile, collapseThreshold)).join("\n\n");
	return `${FILES_OPEN}\n${view}\n\n${serializeState(state)}\n${FILES_CLOSE}`;
}
function renderSection(section, claimsByFile, collapseThreshold) {
	const lines = section.files.map((file) => renderFileLine(file, claimsByFile));
	const heading = `### 🌐 ${section.locale}`;
	if (lines.length > collapseThreshold) return `${heading}\n\n<details><summary>共 ${lines.length} 个文件待处理（点击展开）</summary>\n\n${lines.join("\n")}\n\n</details>`;
	return `${heading}\n\n${lines.join("\n")}`;
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
* 把用户输入的路径 token 解析为清单条目。接受三种写法：
* sharedPath（清单展示的写法）、仓库真实路径（含语言目录）、`语言/路径` 简写。
*/
function resolveTargets(tokens, state) {
	const resolved = /* @__PURE__ */ new Map();
	const failures = [];
	for (const raw of tokens) {
		const token = normalizeToken(raw);
		const candidates = scopeByLocale(token, matchFiles(token, state.files));
		const first = candidates[0];
		if (candidates.length === 1 && first) resolved.set(fileKey(first.locale, first.sharedPath), first);
		else if (candidates.length === 0) failures.push({
			token,
			reason: "unknown",
			candidates: []
		});
		else failures.push({
			token,
			reason: "ambiguous",
			candidates: candidates.slice(0, 3).map((file) => `${file.sharedPath}（${file.locale}）`)
		});
	}
	return {
		resolved: [...resolved.values()],
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
	return [...matches.values()];
}
/** token 里显式包含语言段（如 `en/foo.md`）时用它消歧 */
function scopeByLocale(token, candidates) {
	if (candidates.length <= 1) return candidates;
	const segments = new Set(token.split("/"));
	const scoped = candidates.filter((file) => segments.has(file.locale));
	return scoped.length > 0 ? scoped : candidates;
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
	const body = event.comment.body;
	const commands = parseClaimComment(body);
	const claimTokens = commands.filter((c) => c.kind === "claim").flatMap((c) => c.paths);
	const releaseTokens = commands.filter((c) => c.kind === "release").flatMap((c) => c.paths);
	const lenientTokens = claimTokens.length === 0 && !ctx.config.strictClaimSyntax && hasIntent(body, ctx.config.lenientKeywords) ? extractKnownPaths(body, state.files.map((file) => file.sharedPath)) : [];
	if (claimTokens.length === 0 && releaseTokens.length === 0 && lenientTokens.length === 0) {
		core.info("no claim/release intent found, treating as a normal comment");
		return;
	}
	const before = JSON.stringify(state.claims);
	const replies = [];
	let claimedAny = false;
	let releasedAny = false;
	const { resolved, failures } = resolveTargets([...claimTokens, ...lenientTokens], state);
	for (const failure of failures) replies.push(failure.reason === "ambiguous" ? message(ctx.config, "ambiguous", {
		token: failure.token,
		candidates: failure.candidates.join("、")
	}) : message(ctx.config, "unknown_file", { token: failure.token }));
	for (const file of resolved) {
		const existing = activeClaims(state).find((claim) => fileKey(claim.locale, claim.path) === fileKey(file.locale, file.sharedPath));
		if (existing && existing.user !== user) {
			replies.push(message(ctx.config, "duplicate", {
				path: file.sharedPath,
				locale: file.locale,
				claimer: existing.user
			}));
			continue;
		}
		if (!existing) state.claims.push({
			path: file.sharedPath,
			locale: file.locale,
			user,
			claimedAt: event.comment.created_at,
			commentId: event.comment.id,
			commentUrl: event.comment.html_url
		});
		claimedAny = true;
	}
	for (const token of releaseTokens) {
		const release = resolveTargets([token], state);
		for (const failure of release.failures) replies.push(message(ctx.config, "unknown_file", { token: failure.token }));
		for (const file of release.resolved) {
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
		const updated = renderBody(issue.body, groupByLocale(state.files), state, ctx.config.collapseThreshold);
		await ctx.api.updateIssueBody(issue.number, updated);
	}
	if (claimedAny) await ctx.api.reactToComment(event.comment.id, "rocket");
	else if (releasedAny) await ctx.api.reactToComment(event.comment.id, "eyes");
	if (replies.length > 0) {
		await ctx.api.addComment(issue.number, replies.join("\n\n"));
		await ctx.api.reactToComment(event.comment.id, "confused");
	}
	core.info(`claim processing done: ${resolved.length} resolved, ${failures.length} failed, changed=${changed}`);
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
	const body = renderBody(issue.body, groupByLocale(state.files), state, ctx.config.collapseThreshold);
	await ctx.api.updateIssueBody(issue.number, body);
	core.info(`released ${expired.length} expired claim(s) on issue #${issue.number}`);
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
	const updated = renderBody(issue.body, groupByLocale(state.files), state, ctx.config.collapseThreshold);
	await ctx.api.updateIssueBody(issue.number, updated);
	core.info(`linked PR #${pr.number} to ${linked.length} claim(s), expiry frozen`);
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
	const updated = renderBody(body, groupByLocale(state.files), state, ctx.config.collapseThreshold);
	await ctx.api.updateIssueBody(issueNumber, updated);
	await ctx.api.addComment(issueNumber, message(ctx.config, "pr_closed", {
		user: pr.user.login,
		paths: released.join("、")
	}));
	core.info(`released ${released.length} claim(s) after PR #${pr.number} closed unmerged`);
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
	const { statusJsonPath, templatePath } = ctx.inputs;
	if (!existsSync(statusJsonPath)) throw new Error(`status.json not found at ${statusJsonPath} — run \`lunaria build\` first`);
	const template = readFileSync(templatePath, "utf-8");
	const status = readLunariaStatus(statusJsonPath);
	const desiredFiles = toTrackedFiles(status, [...new Set(status.flatMap((item) => Object.keys(item.localizations)))]);
	core.info(`lunaria status: ${status.length} shared paths, ${desiredFiles.length} entries needing translation`);
	const issue = await ctx.api.findTrackerIssue(ctx.config.issue.label);
	if (!issue) {
		const state = {
			version: 1,
			files: desiredFiles,
			claims: []
		};
		const body = applyPlaceholders(renderBody(template, groupByLocale(desiredFiles), state, ctx.config.collapseThreshold), {
			ttl_days: String(ctx.config.ttlDays),
			dashboard_url: ctx.config.dashboardUrl ?? ""
		});
		const number = await ctx.api.createIssue({
			title: ctx.config.issue.title,
			body,
			labels: [ctx.config.issue.label]
		});
		core.info(`created tracker issue #${number}`);
		return;
	}
	const current = parseState(issue.body ?? "");
	if (!current) throw new Error(`tracker issue #${issue.number} has no readable state block`);
	const { state, sections, changed } = reconcile(current, desiredFiles, ctx.now);
	if (!changed) {
		core.info(`tracker issue #${issue.number} is up to date`);
		return;
	}
	const body = renderBody(issue.body ?? template, sections, state, ctx.config.collapseThreshold);
	await ctx.api.updateIssueBody(issue.number, body);
	core.info(`updated tracker issue #${issue.number}`);
}
//#endregion
//#region src/modes/index.ts
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
		templatePath: core.getInput("template-path")
	}));
}
main().catch((error) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
//#endregion
export {};

//# sourceMappingURL=index.mjs.map