# Changelog

本文件记录玄武可发布版本的用户可见变化。Git tag、GitHub Release、`release.json`、后端 `--version` 与前端 build version 必须使用同一个 `vMAJOR.MINOR.PATCH`。

## [Unreleased]

### Added

- 六条 Golden Journey、容量基准、Supervisor 评测与统一可观测性。
- SQLite 迁移门禁、加密备份/隔离恢复演练和 daemon 生命周期管理。
- 可审计的 release update check、升级快照、release-owned file 回滚与 GitHub signed provenance。

### Changed

- 产品统一使用玄武品牌；`codex-issue-runner` 保留为仓库、二进制和兼容 API 名称。
- 生产后端统一为 Bun/TypeScript，持久化 authority 仍为 `runner.db`。

## [0.1.0] - 2026-05-22

### Added

- 首个 GitHub Release，包含 macOS/Linux 的 arm64、amd64 预构建资产和一键安装脚本。

[Unreleased]: https://github.com/williamnie/codex-issue-runner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/williamnie/codex-issue-runner/releases/tag/v0.1.0
