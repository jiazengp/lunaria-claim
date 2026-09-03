# 快速上手

这一页带你完成 lunaria-claim 的接入：添加 workflow、配置看板、首次运行验证，以及贡献者如何认领文件。按照步骤走，大约十分钟就能跑起来。

## 它是怎么工作的

先看整体流程：

1. 文档仓库的 workflow 里先跑 `lunaria build`，产出一份 `status.json`——它描述哪些翻译缺失、哪些已过期、哪些已完成；
2. `sync` 模式（push 时触发）读取 `status.json`，创建或对账认领 issue，清单上的每一行就是一次认领；
3. 贡献者在该 issue 下评论认领，`claim` 模式更新清单并回复；
4. `expire`（每天定时，默认 UTC 21:00）清扫超期认领，`link-pr`（PR 事件）把 PR 关联到认领。

最终的认领 issue 长这样：

```markdown
### 🌐 ja

- [ ] [`manual/`](https://github.com/your-org/your-docs/tree/main/src/manual)
  - [x] [`src/manual/canvas.md`](https://github.com/your-org/your-docs/edit/main/src/ja/manual/canvas.md) — @alice · 2026-09-01
- [ ] [`src/guide.md`](https://github.com/your-org/your-docs/new/main/src/ja/guide.md) · [source](https://github.com/your-org/your-docs/blob/main/src/zh/guide.md) · [history](https://github.com/your-org/your-docs/commits/main/src/zh/guide.md)
```

认领状态存在 issue body 的 HTML 注释状态块里，不依赖事件顺序：

> [!NOTE]
> `sync` 每次以 `status.json` 全量对账，`claim` / `link-pr` 只做增量修改；事件处理丢失时，下一次 push 会全量修正。翻译是否完成同样以 `status.json` 为准。

## 前置条件

文档仓库需要已经配置好 Lunaria：有 `lunaria.config.json`，本地能跑 `npx lunaria build`。还没配置的话，先按 [Lunaria 文档](https://lunaria.dev/getting-started/) 配置，最小配置大致如下：

```jsonc
{
  // 源语言
  "defaultLocale": { "label": "简体中文", "lang": "zh" },
  // 目标语言，对应清单里的区块；占位符里的语言代码就是这里的 lang
  "locales": [
    { "label": "English", "lang": "en" },
    { "label": "日本語", "lang": "ja" }
  ],
  // status.json 的输出位置
  "outDir": "./dist/lunaria"
}
```

## 第 1 步：发布 Action 仓库（只有想自建 fork 版才需要）

直接用官方 `jiazengp/lunaria-claim@v1` 的话，跳过本步，从第 2 步开始。lunaria-claim 是 JS Action，fork 后要发布到你的 GitHub 才能被 workflow 引用：

1. 推到 GitHub（`dist/` 已随仓库提交，无需构建）；
2. 打好 tag：`git tag v1 && git push origin v1`；
3. 把第 2 步 workflow 里的引用改成 `你的用户名/lunaria-claim@v1`。

> [!TIP]
> 改了 `src/` 之后，记得本地跑 `npm run ci`、把新的 `dist/` 一起提交、再更新 tag——发布版运行的是 `dist/`，不是 `src/`。

## 第 2 步：添加 workflow

把 [examples/workflows/sync.yml](examples/workflows/sync.yml) 和 [examples/workflows/claim-bot.yml](examples/workflows/claim-bot.yml) 拷到 `.github/workflows/`：

- `sync.yml`：push 后读取 status.json 对账，也支持手动运行；
- `claim-bot.yml`：三个 job 按事件自动路由——issue 评论走 `claim`，PR 事件走 `link-pr`，每天定时走 `expire`。**手动运行它 = 立即执行一次超期清扫**。

两个文件已经写好 `jiazengp/lunaria-claim@v1` 的引用，一般不用改；唯一可能要动的是 `sync.yml` 里的 `status-json`。**默认值 `./dist/lunaria/status.json` 仅为示例，必须与 `lunaria.config.json` 的 `outDir` 对应**——status.json 实际输出在 outDir 下。不确定路径的话，本地跑一次 `lunaria build` 看输出的 Output directory。

> [!NOTE]
> `claim-bot.yml` 里所有 bot 写操作共用一个并发队列（`concurrency`，`cancel-in-progress: false`），避免"读-改-写"互相覆盖。不要拆成多个 workflow 并发执行。

## 第 3 步：添加配置和模板

把 [examples/lunaria-claim.yml](examples/lunaria-claim.yml) 放到 `.github/lunaria-claim.yml`，[examples/lunaria-claim.template.md](examples/lunaria-claim.template.md) 放到 `.github/lunaria-claim.md`。

模板里有两个标记区，都**不要编辑**：`<!-- LUNARIA-CLAIM:STATE v1 -->` 状态块（必须保留），以及 `<!-- LUNARIA-CLAIM:FILES -->` 标记区（旧格式的兼容壳，可留可删）。区域之外的排版自由发挥。真正会被替换的占位符：

> [!NOTE]
> `STATE` 区是隐藏在正文里的 JSON 账本（在 issue 的 Raw 视图可见）：记录谁认领了什么、何时认领、关联了哪个 PR。你能看到的勾选清单只是它的渲染结果。**别手动编辑它**——要改认领请用 `/release` 命令，或直接在清单里取消勾选（bot 会识别为手动释放）。万一它被弄坏，sync 会自动从认领评论回放重建并留言说明；重建只保证还原评论里有明确 /claim 命令的认领，遗留问题重新认领即可。

| 占位符 | 说明 |
| --- | --- |
| `{{files_<lang>}}` | 单个语言的清单，`lang` 与 [lunaria.config.json 的 `locales[]`](https://lunaria.dev/configuration/) 里每个 `lang` 字段**完全一致**（不是 `label`；注意大小写与连字符，如 `ja`、`zh-CN`）。可在模板里任意摆放、中间插入说明文字（语言标题也由你写，如 `### 日本語`）；该语言暂无待翻译文件或代码不匹配时原样保留 |
| `{{files}}` | 所有语言的清单合并渲染（兼容旧模板的写法） |
| `{{ttl_days}}` | 配置里的 `ttlDays`，写在"认领后 X 天内提交 PR"之类的提示里 |
| `{{dashboard_url}}` | 配置里的 `dashboardUrl`，未配置时原样保留 |

## 第 4 步：首次运行与灰度上线

先灰度，再放开：

1. 把 `.github/lunaria-claim.yml` 的 `issue.label` 临时改成 `lunaria-claim-test`；
2. 手动运行一次 sync workflow，确认清单正常、认领流程畅通；
3. 改回 `lunaria-claim`，再手动运行一次 sync；
4. 之后每次 push 到 main 都会自动对账，不用再管。

> [!TIP]
> 如果之前有手工维护的认领 issue，直接归档；把原来的规则说明搬进模板标记区外面即可。

## 日常使用

贡献者在认领 issue 下评论即可认领：

```text
/claim src/zh/agreement.md    # 标准写法，空格分隔，可一次认领多个文件
/claim src/manual/            # 目录认领：目录下所有未认领的文件一次认领（tree 展示里的目录行就是完整路径，直接复制即可）
/claim zh/index.md            # 简写：语言目录 + 文件名
src/index.md 我来认领           # 宽松模式：清单中的完整路径 + 意图词
```

认领成功会收到 🚀，清单里对应文件标注 `@你 · 日期`。

路径支持三种写法，完全等价：清单里的 sharedPath（`src/index.md`）、仓库真实路径（`src/en/index.md`）、`语言/路径` 简写（`ja/index.md`）。

**目录认领**是把目录展开成文件后逐条认领：其中已被他人认领的文件自动跳过，回复里会聚合提示跳过了哪几个、是谁的；自己已认领的幂等忽略。目录下之后新增的文件不会自动归属，需要另行认领。`/release src/manual/` 同理，释放你在这个目录下的全部认领。

> [!WARNING]
> sharedPath 跨语言共有时（比如 `src/index.md` 的 en 和 ja 都缺），必须注明语言；bot 拿不准时会列出候选让你选。

其他行为：

- **放弃认领**：评论 `/release 路径` 或 `/give-up 路径`，清单恢复未认领。
- **提交 PR**：PR 作者与变更文件匹配到活跃认领时自动关联，清单追加 PR 链接，过期计时冻结。
- **PR 关闭未合并**：自动释放认领并回复提醒。
- **超期**：认领后 `ttlDays` 天内无关联 PR，自动释放，并在你认领的那条评论下提醒。
- **手动编辑兼容（单向）**：管理员在 issue 正文里取消勾选某个已认领文件（或删掉那一行），bot 下次更新时会把它当作手动释放——去掉后面的 @引用、日期和 PR 链接，恢复未认领；**取消勾选目录行 = 释放该目录下全部认领**；标记区与占位符之外的手写内容不会被覆盖。**反向不存在**：手动勾选未认领文件不会被当成认领（状态块里没有认领人信息可补，bot 下次渲染会画回未认领）。
- **清单行格式**：文件路径本身可点击——未翻译的 `missing` 指向「Create file」页、过期的是编辑页，后接 `[source]`（原文链接）与 `[history]`（原文变更历史）；目录行为仓库目录链接，子树全部认领时打勾。已认领的行保持简洁（只保留路径、@认领人、日期与 PR）。

## 配置参考

`.github/lunaria-claim.yml` 的所有字段都有默认值，只写需要覆盖的即可：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `issue.title` | `🙋 翻译认领` | 认领 issue 的标题 |
| `issue.label` | `lunaria-claim` | bot 用它定位认领 issue；改名后已有 issue 不会自动迁移 |
| `issue.perLocale` | `false` | 按语言拆分子 issue（尚未实现） |
| `ttlDays` | `15` | 认领后未提交 PR 的超期天数 |
| `strictClaimSyntax` | `false` | 为 `true` 时只接受 `/claim` 命令，忽略宽松匹配 |
| `lenientKeywords` | `认领 / 领取 / claim / 我来 / 接单` | 宽松模式下判定认领意图的关键词 |
| `collapseThreshold` | `30` | 单个语言区块超过该条数后用 `<details>` 折叠 |
| `fileListStyle` | `tree` | 清单展示：`tree` 按目录嵌套，`flat` 平铺 |
| `templatePath` | `.github/lunaria-claim.md` | issue body 模板文件的位置 |
| `dashboardUrl` | — | 填入模板的 `{{dashboard_url}}` |
| `messages` | `{}` | 覆盖 bot 文案，键见下表 |

`messages` 支持覆盖的键：

| 键 | 场景 | 可用变量 |
| --- | --- | --- |
| `duplicate` | 文件已被他人认领 | `{path}` `{locale}` `{claimer}` |
| `unknown_file` | 路径不在清单里 | `{token}` |
| `ambiguous` | 跨语言路径需要指定 | `{token}` `{candidates}` |
| `expired` | 超期释放 | `{user}` `{path}` `{locale}` `{ttlDays}` |
| `pr_closed` | PR 关闭未合并释放 | `{user}` `{paths}` |
| `dir_skipped` | 目录认领时跳过已被他人认领的文件 | `{dir}` `{claimed}` `{skippedCount}` `{skipped}` |

## Action 输入参考

| 输入 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | 必填 | `sync` / `claim` / `expire` / `link-pr` |
| `token` | `${{ github.token }}` | GitHub API 令牌 |
| `status-json` | `./dist/lunaria/status.json` | sync 模式读取的 status.json 路径（示例值，需与 outDir 对应） |
| `config-path` | `.github/lunaria-claim.yml` | 配置文件路径 |
| `dry-run` | `false` | 仅 sync：把将要写入的 body 渲染到 Step Summary 预览，**不写入任何内容**。改模板后先跑一次它验证，再正式运行 |

### Action 输出

| 输出 | 说明 |
| --- | --- |
| `issue-url` | 认领 issue 的 URL（sync 模式），站点页面可直接引用 |

## 常见问题

**报 status.json not found**

`sync.yml` 的 `status-json` 与 `lunaria.config.json` 的 `outDir` 对不上。本地跑一次 `lunaria build`，把实际输出路径填进去。

**认领了却没反应**

通常是评论不在认领 issue 上、评论者是 bot 自己，或者文件不在清单里（已完成的翻译会移出清单）。宽松模式还需要把意图词写进评论。

**定时任务从没跑过**

`schedule` 本身会有延迟，且仓库 60 天无任何活动时 GitHub 会暂停定时触发。低频仓库偶尔手动运行一次 `claim-bot` workflow 兜底即可；超期判定基于认领时间戳，与触发时间无关。

**本地 `git fetch --tags` 后 v1 还是旧版？**

`v1` 是浮动 tag（版本更新会前移）。刷新本地缓存：`git fetch --tags --force`，或直接看 [Release 页](https://github.com/jiazengp/lunaria-claim/releases) 标注的 commit sha。

**私有仓库**

需要 PAT：checkout、`lunaria build` 两步，以及 action 的 `token` 都传 `${{ secrets.PAT }}`。

**文件数量过多**

先靠 `collapseThreshold` 折叠；issue body 上限约 6.5 万字符。还不够的话，就需要按语言拆分子 issue（`issue.perLocale`，尚未实现）。