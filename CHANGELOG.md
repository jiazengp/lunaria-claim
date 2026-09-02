# 更新日志

本项目的重要变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。项目尚未发布正式版本（远端无 tag），以下内容均属未发布。

## [Unreleased]

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

### 文档

- 接入指南 [docs/quick-start.md](docs/quick-start.md)（含 Lunaria 配置、灰度上线、配置参考、FAQ）
- 可直接复制的接入样例（examples：workflow、配置、issue 模板）
- [README.md](README.md)：项目定位、两步接入、认领协议

### 技术栈

- TypeScript（原生编译器）类型检查 + tsdown 构建（ESM / node24 产物）+ vitest 测试 + biome 检查
- 入口 `main.cjs`（Actions runner 的 CJS 兼容壳，动态导入 `dist/index.mjs`）