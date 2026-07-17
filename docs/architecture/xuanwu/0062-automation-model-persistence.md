# ADR-XW-0062：统一 Automation 模型与持久化

- 状态：Accepted（P08.02 / G0-W0 additive foundation）
- 日期：2026-07-17
- 依赖：ADR-XW-0060（P08.01）、Workflow Manifest Registry（P06.07）
- 合同：`backend-ts/src/domain/automation/contracts.ts`
- 存储：`automation_definitions`、`automation_trigger_configs`、`automation_runs`、`automation_events`

## 决策

Automation definition 统一保存 scope、`workflow_ref`（必须是 P06.07 的精确 versioned manifest）、permission policy、mode、definition status、next run 和 idempotency namespace。触发器以不可变版本保存：Cron 必须保存 IANA timezone；manual、webhook、continuous 各自使用闭合的 config shape。`next_run_at` 一律 UTC ISO-8601，Cron 的业务时区不从配置中推断或丢失。

`automation_runs` 是单次 trigger history，`automation_events` 是 definition status/config mutation 的审计事实。所有 mutation 都必须带 correlation、actor、reason 和 deterministic-policy 或 human-approval 的 allow gate；LLM 不可作为 gate authority。P08.02 不接入 executor，因此不会绕开既有 Action Proposal/Approval/外部写审计。

## Source of truth、并存与回滚

**W0 source of truth：** 现有 `cron_tasks`、`pi_automations`、`pi_delegations`、heartbeat 与 completion watch 仍各自拥有 live definition、claim、cursor 和 execution。新表是 additive target storage，尚无 runtime/API writer 或 reader；repository 只供之后经过 migration gate 的 command seam 使用。

**双写/双读：** W0 均为 0。W1 只能由带 migration batch 的幂等 shadow write 开启，W2 最多一个正式 release 的 target read/fallback；合计不超过 ADR-XW-0060 规定的两个正式 release。不得让 legacy 和 target 同时成为 writer。

**回滚：** G4 前停止 target read/shadow 即恢复 legacy，P08.02 四张 additive 表保留作可审计空/影子记录。G4 后必须先停 target writer，按 correlation/cutover checkpoint 回放受审计 delta 后才恢复 legacy writer。

**最终删除门禁：** 仅 P11/G7 可删除 compatibility 或 target storage；要求 active/paused=0、claim/cursor/timezone/restart/retry/watch-dedupe parity、一个 release consumer-zero、fresh backup、隔离 restore 和精确的非 LLM destructive approval。

## 索引与迁移

迁移 `045_automation_model` 是可重复的 SQLite additive migration。definition 的 `(scope_kind, scope_id, status, next_run_at, id)` 服务于 scope 内 due/paused 查询；trigger version、run history 与 event history 各有覆盖索引。外键一律 `restrict`，防止没有 archive/restore gate 的 history 删除。
