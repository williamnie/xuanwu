# PI provider worker outage 回归说明

> [!WARNING]
> **历史归档（2026-07-19）**：本文保留一次回归背景，不再定义当前 lifecycle。当前 source of truth 见 [canonical 架构文档索引](README.md)、[Run / Attempt 生命周期](xuanwu/0020-run-attempt-lifecycle-contract.md)、[provider Run event contract](xuanwu/0022-provider-run-event-contract.md) 与 [重启恢复不变量](xuanwu/0069-restart-recovery-invariants.md)。

PI 负责 issue lifecycle：claim、open run、deferred/retry、needs_user escalation 与最终用户可见通知都归 PI/Runner 管。Codex、Claude Code 等 provider 只作为 executor worker 执行单个 issue/run；当 worker initialize、transport 或 runtime 短暂不可用时，runner 先把当前 issue 保持 `in_progress` + open run，并记录 `issue.provider_deferred`，避免把 #A 误标 failed 或继续 claim 后续 #B 污染队列。若 supervisor/scheduler 观察到无可恢复 session、同 issue 重复 deferred、或同项目 provider 窗口内多次 deferred，则升级为 `provider_runtime_unavailable`，由 Guardian 生成 `needs_user.escalate`，本地 notification 使用 `pi.needs_user` 暴露 provider 与用户下一步（例如检查/重启 Codex app-server 或 Claude Code provider 后 retry）。

后续接入 Claude Code 或其它 executor 时，应复用同一 generic worker 模型：provider infra transient 先 deferred，hard outage 由 provider-agnostic `provider_error_category` + `diagnosis_code` 分类进入 Guardian；不要为 Claude/Codex 新增 provider-specific issue 状态机。Provider adapter 可以补充 provider 名称、session/turn 与 redacted error evidence，但 lifecycle 决策、recovery budget、needs-user escalation 和通知出口继续由 PI 的通用 supervisor/Guardian 链路处理，且用户可见内容必须经过 redaction，不能暴露 token、绝对路径或 stack。
