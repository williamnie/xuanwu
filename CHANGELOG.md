# Changelog

本文件记录玄武可发布版本的用户可见变化。Git tag、GitHub Release、`release.json`、后端 `--version` 与前端 build version 必须使用同一个 `vMAJOR.MINOR.PATCH`。

## [Unreleased]

## [0.2.1] - 2026-08-07

### Added / 新增

- 增加 registry-driven Code Agent Provider 架构、动态 catalog、conformance harness，
  以及 Codex、Claude、Pi 与 Qoder adapter。
- 增加 Code Agent 管理界面、Project/Work/Session Provider 选择与真实 Attempt 归属展示。
- 增加 Remote access token 的首次生成、浏览器连接、轮换与服务端保护链路。

### Changed / 变更

- **Breaking:** Release 资产、二进制与 CLI 统一为 `xuanwu`，配套命令统一为
  `xuanwu-daemon`、`xuanwu-install` 与 `xuanwu-update`。
- 环境变量统一使用 `XUANWU_*`，Skill ID、服务标识和默认状态目录同步统一为 Xuanwu。
- 不提供旧命令、旧环境变量或旧服务名的兼容别名；升级前应先备份 `runner.db`。
- 统一 Settings、Project、Work 与 Session 中的 Code Agent 配置和路由体验，并修复历史
  Session 恢复、消息顺序、发送反馈与草稿保留问题。

## [0.2.0] - 2026-08-03

### Added / 新增

- 完成玄武 AI Engineering Control Plane 的 115 项建设路线与最终迁移收口。
- 六条 Golden Journey、容量基准、Supervisor 评测与统一可观测性。
- SQLite 迁移门禁、加密备份/隔离恢复演练和 daemon 生命周期管理。
- 可审计的 release update check、升级快照、release-owned file 回滚，以及仓库公开后启用的 GitHub artifact attestations。
- Work、Run、Evidence、Handoff、Attention 与 Automation 统一产品闭环。
- Codex 与 Claude Provider 路由、Run Detail 与真实 Attempt 归属。
- 中英文 README、贡献指南、安全策略与双语 Release Notes。

### Changed / 变更

- 产品与 GitHub 仓库统一使用玄武 / Xuanwu 品牌。
- 生产后端统一为 Bun/TypeScript，持久化 authority 仍为 `runner.db`。
- Issues/Sessions 用户入口迁移到 Work/Runs；旧 API 进入可观测的 compat v1 deprecation 窗口，保留到 `v0.3.x`。
- Release 安装使用隔离的 Web Gateway、Runner Core 与 Agentic Worker 用户服务。
- 公开许可明确为 PolyForm Noncommercial 1.0.0；项目属于 source-available，而非 OSI 开源。

## [0.1.0] - 2026-05-22

### Added

- 首个 GitHub Release，包含 macOS/Linux 的 arm64、amd64 预构建资产和一键安装脚本。

[Unreleased]: https://github.com/williamnie/xuanwu/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/williamnie/xuanwu/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/williamnie/xuanwu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/williamnie/xuanwu/releases/tag/v0.1.0
