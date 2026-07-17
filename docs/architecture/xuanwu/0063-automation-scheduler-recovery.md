# ADR-XW-0063：Automation 调度 claim、恢复与退避

- 状态：Accepted（P08.03 / G0-W0 native scheduler core）
- 依赖：ADR-XW-0062（P08.02）
- 实现：`automationScheduler.ts` repository、`runner/automationScheduler.ts`

## 决策

`automation_definitions` 的 active `cron`/`continuous` 由一个 SQLite immediate transaction 做 due scan：同一 scheduled slot 以 `(automation_id, idempotency_key)` 唯一，`automation_runs` 只会 materialize 一次。queued run 以 token lease claim；完成/失败必须持有同一 lease token 才能提交。崩溃后的过期 lease 先转 queued，再按 `60s, 120s` 指数退避；最多 3 次 claim，耗尽后写 terminal failed 与 `automation_run_events` 审计，并通过既有 `pi_guardian_alerts` 产生可见 Attention。

Cron 错过超过 60 秒的 scheduled slot 固定为 `skip`，写一条 skipped run/event 后从当前时间计算下次；不会补跑或重放。Cron expression 使用 trigger 保存的 IANA timezone；春季不存在的本地时间跳过，秋季重复本地 minute 只执行一次。

## Authority、兼容与回滚

这是 **native target definition** 的 claim authority，仅在 system loop 注册 governed executor 时启用。`cron_tasks`、`pi_automations`、delegation、heartbeat、watch 与通知仍是各自 legacy/live definition、cursor 和执行 authority；本期不读取、双写或迁移它们，W0 的 dual-read/dual-write 仍为 0。没有 executor 时 loop 返回空结果，不能让 LLM 或未注册执行器触发外部写。

回滚只需移除 governed executor registration，已经写入的 run/event/Attention 保留审计；不会回写 legacy carrier。之后的 W1/W2/G4 迁移仍受 ADR-XW-0062 的最多两个正式 release、parity、backup/restore 和非 LLM G7 delete gate 约束。
