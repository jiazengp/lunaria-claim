# AGENTS.md

GitHub Action (TypeScript, pure ESM, Node 24) that turns Lunaria translation status (`status.json`) into a collaborative claim board on GitHub Issues. README and code comments in this repo are written in Chinese; keep new comments and user-facing copy consistent with that.

## Commands

- `npm run ci` — the full gate: typecheck (`tsc --noEmit`, TS7 native) + lint (biome) + test (vitest) + build (tsdown). Run this before declaring any change done.
- `npm run lint` / `npm run format` — biome check / check --write.
- `npm test` — vitest run. All tests are offline: pure domain modules against fixtures in `tests/fixtures/` (including a real-world VitePress status.json used by `tests/integration.real-world.test.ts`).

## Architecture

Entry: `src/index.ts` reads action inputs → `src/modes/index.ts` builds a `ModeContext` and dispatches on `mode` (`sync` | `claim` | `expire` | `link-pr`).

Layer rules:

- Only `src/modes/` (plus `src/github.ts` and `src/index.ts`) may do I/O: Octokit, `fs`, `@actions/core`. Modes consume the `GitHubApi` interface from `src/github.ts`, never Octokit directly — add new API calls there.
- Everything else is pure domain logic and must stay I/O-free so it stays unit-testable: `model.ts` (domain types), `state.ts` (HTML-comment JSON state block), `claims.ts` (claim-comment parsing / expiry), `reconcile.ts` (status.json reconciliation), `resolve.ts` (path resolution: sharedPath / real repo path / `locale/path` shorthand), `render.ts` (issue body), `lunaria.ts` (status.json → TrackedFile), `messages.ts` (bot copy), `config.ts` (zod schemas).

Design principles (established in this repo, enforced by tests):

1. **Reconcile over events** — `sync` does a full reconciliation from status.json on every run; event modes (`claim`, `link-pr`) only make incremental updates. Any drift is corrected by the next push; don't add event-only logic that sync can't repair.
2. **Comments are the ledger, the body is a view** — claim state lives in a `<!-- LUNARIA-CLAIM:STATE v1 -->` JSON block inside the issue body; state block and visible checklist are written in one atomic body PATCH. `parseState` returns `null` on corruption and the caller decides rebuild-vs-error.
3. **Completion is decided by Lunaria** — never track "translation done" locally; status.json is the only source of truth.
4. `claimedAt` is the claim comment's creation time (not processing time) to resist workflow scheduling delays; preserve this when adding expiry logic.

## Conventions

- ESM only; relative imports must use `.js` extensions (`verbatimModuleSyntax`, `moduleResolution: Bundler`).
- strict TS with `noUncheckedIndexedAccess` — index access returns `T | undefined`.
- Biome: 2-space indent, 100 line width, single quotes.
- All bot replies go through `message()` in `src/messages.ts` (`DEFAULT_MESSAGES` + `{placeholder}` vars) so users can override copy via the `messages` config key. New replies need a key there plus coverage in `tests/messages.test.ts`.
- New user-configurable values belong in `ClaimConfigSchema` (zod, `src/config.ts`) and must be documented in `docs/quick-start.md` (config reference section) and `examples/lunaria-claim.yml`.
- Domain model changes (e.g. new `Claim` fields) must keep `TrackerState` version 1 parsing tolerant; bump the state-block version only with a migration story.

## Gotchas

- `dist/` is a build artifact but **must be committed** — JS Actions require it (see `.gitignore` comment). After changing `src/`, run `npm run build` and include `dist/` in the commit.
- `main.cjs` is a CJS shim that dynamic-imports `dist/index.mjs` because the Actions runner loads the action main as CJS. Don't remove it until the runner supports ESM natively.
- Node >= 24 required everywhere: `engines` in package.json, `using: node24` in `action.yml`, and CI runs Node 24.

## Docs to read first

- `README.md` — 门面：定位、两步接入、认领协议简述。
- `docs/quick-start.md` — 面向用户的接入指南：配置参考、action inputs、FAQ。
