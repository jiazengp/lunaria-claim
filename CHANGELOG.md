# 更新日志

本项目的重要变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

## [1.2.1] - 2026-09-03

### 修复

- **#555 类多占位符模板的更新正确性**：模板里每个 `{{files_<lang>}}` 各自包 FILES 标记区时，更新改为以模板整体重建（此前只覆盖第一组区域，引发重复列表与残留可见 JSON）；区域正则去 `/g` 防 lastIndex 污染
- **重复运行崩溃（#2）**：后续 sync 及 claim / expire / link-pr 更新在此前会把已渲染正文当模板、占位符校验失败。现在默认模板在标记区内原位覆盖（标记区外的手写内容保留），正文无法覆盖时回退按模板整体重建

## [1.2.0] - 2026-09-03

### 优化

- 清单不再渲染 `### 🌐 语言代码` 标题：标题属于模板排版（占位符周围由用户书写）；正文没有任何语言标题时，手动编辑的视图解析按路径兜底匹配（跨语言同路径一并处理）
- 已完成翻译（Lunaria 判定 up-to-date）的文件保留在清单中自动打勾、不可认领；清单仅派生自 status.json，Lunaria `ignore` 排除项在下一次 sync 自动移出清单
- 清单目录行带 checkbox：子树全部认领时打勾；管理员取消勾选目录 = 释放该目录下所有认领
- 状态块 JSON 改为 HTML 注释包裹，正文渲染不可见（Raw 视图可见）；旧格式自动兼容迁移
- 未认领清单行提供可点击路径（缺失 → Create file 页、过期 → 编辑页），并附 `[source]` 原文链接与 `[history]` 原文变更历史链接；目录行为仓库目录链接
- 移除过期文件的 ⚠️ 徽标：过期即未勾选、按待认领处理

## [1.1.1] - 2026-09-03

### 修复

- **发布阻断修复**：`dist/index.mjs` 此前把 `@actions/core` / `yaml` / `zod` / `@octokit/action` 当 external 未捆绑，而 Actions runner 只拿仓库内容、不安装依赖，导致 `@v1` 在真实 runner 上 `ERR_MODULE_NOT_FOUND`。现已通过 tsdown `noExternal` 捆绑全部直接依赖，并新增 runner 冒烟测试（`npm run smoke`，模拟无 node_modules 的 runner 加载入口）纳入 CI，从流程上防止复发

## [1.1.0] - 2026-09-03

### 新增

- sync 支持 `dry-run`：渲染预览到 Step Summary，不写入任何内容，便于改模板后先验证
- 四个模式结束时写 GitHub Step Summary（改了哪几行、哪个 issue、因为什么）
- sync 输出 `issue-url`，站点页面可引用真实认领 issue
- 认领状态块损坏时自动自愈：从认领评论回放重建并留言说明
- `status.json not found` 报错提示检查 `lunaria.config.json` 的 `outDir`
- bot 系统消息（Step Summary、自愈留言、报错）统一英文；`messages` 默认文案精简为单句并保持中文

## [1.0.0] - 2026-09-03

### 新增

- 翻译认领看板核心：基于 Lunaria `status.json` 自动创建/对账认领 issue（`sync`）；评论认领与表情回应（`claim`）；PR 自动关联与关闭未合并自动释放（`link-pr`）；超期自动释放并提醒（`expire`）
- 树状文件清单：默认按目录嵌套展示（`fileListStyle: tree`），可切回平铺（`flat`）
- 目录认领：`/claim 目录/` 一次认领目录下所有未认领文件；已被他人认领的自动跳过并聚合提示
- 多种路径写法：清单完整路径、仓库真实路径、`语言/路径` 简写、裸文件名，歧义时列出候选
- 单文件超期天数可配置（`ttlDays`，默认 15 天），超期判定基于认领评论时间戳
- 超长清单自动折叠（`collapseThreshold`）
- 宽松认领模式：评论含意图词（`lenientKeywords` 可配）+ 清单路径即可认领
- bot 文案全部可配置（`messages`：`duplicate` / `unknown_file` / `ambiguous` / `expired` / `pr_closed` / `dir_skipped`）
- 认领状态自足存储：issue body 内 HTML 注释状态块，评论即账本
- 模板支持按语言独立占位符（`{{files_ja}}` 等），多语言区块可自由排版；`{{files}}` 兼容保留
- 模板文件位置可在配置里指定（`templatePath`，默认 `.github/lunaria-claim.md`）
- 兼容管理员手动编辑：在 issue 里取消勾选或删除某行，会将该认领按手动释放处理，bot 更新时去掉 @引用并恢复未认领；正文手写内容不会被覆盖

### 文档

- 接入指南 [docs/quick-start.md](docs/quick-start.md)（含 Lunaria 配置、灰度上线、配置参考、FAQ）
- 可直接复制的接入样例（examples：workflow、配置、issue 模板）
- [README.md](README.md)：项目定位、两步接入、认领协议

### 技术栈

- TypeScript（原生编译器）类型检查 + tsdown 构建（ESM / node24 产物）+ vitest 测试 + biome 检查
- 入口 `main.cjs`（Actions runner 的 CJS 兼容壳，动态导入 `dist/index.mjs`）