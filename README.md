# lunaria-claim

[![CI](https://github.com/jiazengp/lunaria-claim/actions/workflows/ci.yml/badge.svg)](https://github.com/jiazengp/lunaria-claim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

lunaria-claim 支持把 [Lunaria](https://lunaria.dev) 的翻译状态变成 GitHub Issue 里的认领看板：清单自动对账，评论就能认领，超期没提交 PR 会自动释放并提醒。

Lunaria 负责告诉你哪些文件还没翻译，lunaria-claim 负责让这些文件能被人认领着翻完。装上之后，认领 issue 长这样：

```markdown
### 🌐 ja

- [ ] [`manual/`](https://github.com/your-org/your-docs/tree/main/src/manual)
  - [x] [`src/manual/canvas.md`](https://github.com/your-org/your-docs/edit/main/src/ja/manual/canvas.md) — @alice · 2026-09-01
- [ ] [`src/guide.md`](https://github.com/your-org/your-docs/new/main?filename=src/ja/guide.md) · [source](https://github.com/your-org/your-docs/blob/main/src/zh/guide.md) · [history](https://github.com/your-org/your-docs/commits/main/src/zh/guide.md)
```

## 接入

把 [examples/workflows](examples/workflows) 里的两个 workflow、[examples/lunaria-claim.yml](examples/lunaria-claim.yml) 和 [examples/lunaria-claim.template.md](examples/lunaria-claim.template.md) 拷进文档仓库，手动跑一次 sync，认领 issue 就建好了。workflow 里已经引用好了 `jiazengp/lunaria-claim@v1`，拷完就能用。

更完整的步骤、配置项和常见问题，写在 [docs/quick-start.md](docs/quick-start.md)。

## 认领

贡献者在 issue 下评论 `/claim 文件路径` 认领，用 `/release 路径` 放弃。目录也可以一次认领：`/claim src/manual/` 会把目录下未被认领的文件全部认领，已被他人认领的自动跳过。提交的 PR 包含认领的文件，bot 自动关联并冻结超期计时；超过 `ttlDays`（默认 15 天）还没提交 PR，认领会自动释放并提醒。编辑或删除认领评论会先释放该评论产生的认领（删除静默、编辑按新内容重放）；管理员在 issue 正文里勾选/取消勾选也能对账——取消勾选 = 手动释放并给原认领评论打 👎 reaction，勾选未认领行 = 以编辑者为认领人。

## Roadmap

- 按语言拆分子 issue（`issue.perLocale`，配置已预留）

## 开发

本地跑 `npm run ci` 就是一次完整检查（typecheck / lint / test / build）。技术栈是 TypeScript（原生编译器）+ tsdown（ESM / node24 产物）+ vitest；`main.cjs` 是 Actions runner 的 CJS 兼容入口，别动它。发布：把含 `dist/` 的版本提交后，`git tag v1 && git push origin v1`。

## License

[MIT](LICENSE)
