# Changelog

本文件记录玄武可发布版本的用户可见变化。Git tag、GitHub Release、`release.json`、后端 `--version` 与前端 build version 必须使用同一个 `vMAJOR.MINOR.PATCH`。

## [Unreleased]

### Changed / 变更

- 二进制 Release 现在携带与版本匹配的 Xuanwu Skill，安装器默认安装到 Codex，并支持选择
  Claude Code、同时安装或跳过；固定旧版本缺少 Skill 时保持兼容安装。
- 会话自动命名跟随应用语言设置，支持完整中英文 Prompt、类型和主题；日期按后端动态检测的系统时区转换创建时间，不依赖浏览器，也不再固定上海时区。
- 将 Qoder SDK/CLI 成对升级至 `1.0.32` / `1.1.40`，同步协议 `1.3.0`、构建及运行时版本校验。
- 新发布清单记录 Qoder CLI 版本，安装器按发布包声明校验，并兼容未声明版本的旧发布包。
- Qoder 模型列表读取使用与任务执行相同的进程通道，并在完成或超时后清理进程。
- Qoder CLI 仍要求 `sharp ^0.34.5`，原有安全例外继续保留，不强制跨版本替换。

## [0.2.12] - 2026-09-03

### Added / 新增

- 未指定标题的 Codex 会话可复用 Supervisor 的模型与鉴权，通过一次 LLM 调用根据 Issue
  或用户消息自动命名，格式为 `MMDD｜类型｜主题`；日期取上海时区的会话创建时间。
- 支持在创建 Codex 会话时显式传入标题，并保护用户在生成期间修改的名称；无法判断主题、
  模型调用失败或超时时保留原名，自动命名不阻塞任务执行，也不批量改写已有会话。

### Security / 安全

- 将后端传递依赖 `fast-uri` 从 `3.1.5` 升级至兼容补丁 `3.1.6`，修复 URI 主机名规范化
  相关的四项安全公告，恢复依赖审计门禁。
- 将后端传递依赖 `qs` 升级至 `6.16.0`，修复输入解析相关的拒绝服务问题。
- 将 Tiptap 编辑器组件统一升级至 `3.30.4`，修复属性合并可能引入可执行 DOM 属性的问题。

### Fixed / 修复

- 编辑器重新载入 Markdown 时保持本地文档路径和裸 URL 为纯文本，显式创建的链接仍可使用。

## [0.2.11] - 2026-09-03

### Fixed / 修复

- Work 与 Runs 刷新按钮在手动刷新、自动轮询和事件刷新请求期间显示转圈动效，请求结束后
  恢复可点击状态，便于确认数据正在更新。
- 修复 Command Center 与 Runs 在开发模式重挂载时复用已取消请求的问题。
- 统一弹窗相对视口居中，避免页面容器影响弹窗定位。
- 恢复 Run 详情的代码代理对话展示，并补齐会话消息与运行状态同步。

## [0.2.10] - 2026-09-02

### Fixed / 修复

- Command Center 的 Attention 仅读取最近七天内的有限 Action，并增加对应数据库索引，避免
  历史 Action 持续增长后拖慢概览请求。
- Recent Deliveries 列表限制最大高度并支持区域内滚动，避免交付记录较多时页面被过度拉长。

## [0.2.9] - 2026-09-01

### Fixed / 修复

- Run 详情默认展示 Summary，只有显式打开 Provider 时才读取当前 Session；移除嵌入视图的
  全局 Session 列表、偏好读取和周期性全量 transcript 刷新。
- Codex Session 详情拆分为轻量 metadata 与原生 `thread/turns/list` 摘要分页，将典型详情
  载荷从约 1.43 MB 降至约 11 KB，并保留服务重启后的权威运行态。
- 增加脱敏慢 SQL trace，记录查询指纹、耗时、返回行数、连接角色和调用位置，不记录绑定值。

## [0.2.8] - 2026-09-01

### Fixed / 修复

- Release rollback 成功后将对应最新升级job标记为 `rolled_back` 并记录目标版本，避免恢复到
  旧前端后仍把已回滚的成功job展示为“升级完成”。

## [0.2.7] - 2026-09-01

### Fixed / 修复

- 回滚后只有当当前版本仍等于升级job目标版本时才展示“升级完成”，避免旧成功job遮盖新的
  可升级状态。

## [0.2.6] - 2026-09-01

### Fixed / 修复

- 更新检查以正在运行的 Core build version 作为当前版本权威，避免旧 installer 服务模板或
  自定义安装目录让检查器误读另一份全局 binary；同时补齐 SemVer prerelease 比较。

## [0.2.5] - 2026-09-01

### Changed / 变更

- 修复自定义 `XUANWU_INSTALL_DIR` 的 Release 安装在 Core 更新检查中误读其他全局 binary，
  导致当前版本判断和升级任务基线不一致的问题。
- 升级状态 API 增加最近一次成功检查时间，便于区分新鲜 Release 结果与离线期间保留的状态。
- 保持 `xuanwu.storage-compat.v1`，不新增数据库迁移或配置切换，可从 `v0.2.4` 直接安全升级。

## [0.2.4] - 2026-08-31

### Added / 新增

- 增加 Release 后台检查、网页全局升级提醒、Feishu/Telegram 幂等通知，以及带备份、
  隔离恢复演练和失败回滚的一键安全升级。
- 增加 Telegram IM 连接器、设置面板、长轮询接收、分段投递、审批交互与通知链路。
- 增加 Provider-neutral IM 上下文预算、投影游标与 Session rollover 生命周期，避免长会话
  无界增长并保留可审计的上下文谱系。
- 增加 Work 热路径 claim、Git workspace baseline、运行归属与生命周期治理，并补充移动端
  导航抽屉和响应式工作台体验。

### Changed / 变更

- 收紧 PI 工具分层、对话范围与授权询问语义，限制连续无进展续跑，并补齐 Code Agent
  目录发现与 Codex OAuth release 加载。
- 加固 release 第三方许可、依赖安全、仓库卫生与 provenance 门禁。
- 项目许可证由 PolyForm Noncommercial 1.0.0 调整为 Apache License 2.0，允许在遵守许可证
  条款的前提下使用、修改、分发及商业使用。

## [0.2.3] - 2026-08-16

### Added / 新增

- Work 与 Runs 列表增加五秒静默刷新，在不打断筛选、分页和操作状态的前提下同步最新运行态。
- 将玄武 Supervisor 对话整合进应用侧栏，并补充稳定的后端连接探测、重连状态和 SSE 重试提示。
- 增加 Run 列表慢请求观测与进程组内存回收状态，便于定位运行时性能和资源压力。

### Changed / 变更

- 统一工作台、仪表盘、设置页、会话输入区与 Provider 对话流的视觉和交互，恢复完整消息时间线，
  默认折叠内部执行过程。
- 模型选择仅接受当前 Provider catalog 中可用的模型，并为 Qoder 模型发现增加有界超时和安全回退。
- 延长 Core 冷启动健康检查窗口，细化部署失败诊断；本地开发启动时展示实际生效的访问 Token。

## [0.2.2] - 2026-08-14

### Added / 新增

- 增加 Qoder Code Agent 的 Session 创建、恢复、历史读取、事件转译、审批与精确中断链路，
  并将冻结的 CLI runtime 与 policies 一并打入 release 资产。
- 增加统一执行策略合同与持久化能力，为 Codex、Claude、Pi 和 Qoder 提供一致的 sandbox、
  approval 与权限解析语义。
- 增加 Code Agent 运行下钻、用量展示、Session transcript，以及 Qoder 离线回归与真实账号
  验收记录；Qoder support level 仍保持 `preview`。

### Changed / 变更

- 优化调度查询、事件维护和 Provider Session 生命周期，降低热路径扫描与 Codex 进程刷新洪峰。
- 收紧 managed executor 的 Issue 生命周期写入边界，并修复 PI 验收、通知、重试与执行结果语义。
- 修复 Claude SDK 本地登录复用、Qoder release runtime 完整性，以及首次 release 目录升级返回码。

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

[Unreleased]: https://github.com/williamnie/xuanwu/compare/v0.2.12...HEAD
[0.2.12]: https://github.com/williamnie/xuanwu/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/williamnie/xuanwu/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/williamnie/xuanwu/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/williamnie/xuanwu/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/williamnie/xuanwu/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/williamnie/xuanwu/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/williamnie/xuanwu/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/williamnie/xuanwu/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/williamnie/xuanwu/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/williamnie/xuanwu/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/williamnie/xuanwu/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/williamnie/xuanwu/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/williamnie/xuanwu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/williamnie/xuanwu/releases/tag/v0.1.0
