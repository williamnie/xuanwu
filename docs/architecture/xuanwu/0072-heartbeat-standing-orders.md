# ADR-XW-0072：Heartbeat 与 Standing Orders

- 状态：Accepted（P08.05 / G0-W0 native composition）
- 依赖：P08.04 / Runner #710、P06.13 / Runner #692（均为 `done`）
- 实现：`standingOrderRuntime.ts`、`automationWorkRunExecutor.ts`

## 决策

不新增 Standing Order 表或另一套 heartbeat runtime。active native Automation 的 `continuous` trigger 就是 Standing Order definition；`automation_definitions` 继续拥有 project scope、Workflow、mode、permission policy、状态与 idempotency namespace，`automation_trigger_configs` 继续拥有 poll interval。一次到期 tick 仍由 `automation_runs` 和既有 lease/retry authority 管理。

Work 物化前增加确定性 preflight：

1. 只接受显式 project scope，并复用 `pi_heartbeat_controls` 的 project pause；
2. 复用 `project_pi_policies` 的 timezone/quiet hours；
3. 复用 `project_pi_settings.max_actions_per_cycle` 作为同一 schedule cycle 的 project Work budget；
4. 复用 `collectProjectHeartbeatSignals` / `planHeartbeatActions` 与 P06.13 的 active Supervisor commitment，按 project 选择不超过剩余 budget、发生变化的 operational context；
5. 没有变化、处于 quiet hours、heartbeat paused 或预算耗尽时，只终结本次 Automation run 为 audited `skipped`，不创建 Issue-backed Work、engineering Run、provider session 或 notification。

上下文只包含候选 action 的类型/Issue/risk/rationale，或 commitment 的 goal/work status/due/watch 引用；不注入 transcript，不从聊天文本推断新 commitment，也不把 operational commitment 写入 PI memory。LLM 只能消费已经选择的上下文，真正执行仍必须经过 exact Workflow stage、permission policy、Action Proposal/Approval 和 provider sandbox。

Heartbeat candidate 若来源 Work 本身由 `automation_definitions` 物化，则不再喂回 Standing Order；verification/completion 继续走既有专用 authority，避免 Automation Work 递归制造新的 Automation Work。

## 恢复、抑制与审计

- `automation_execution_links` 定位既有 structured Evidence，Evidence 中每个 context item 的 `ref + updated_at` 是 durable suppression checkpoint；它们都是既有关系/审计事实，不新增 cursor authority。只有 heartbeat candidate/commitment 或其 authoritative Work 版本变化，后续 tick 才会再次选择；同一 tick 未消费的 item 不会被较新的全局时间戳饿死。
- 同一个 `automation_run_id` 已有 execution link 时视为恢复同一 Work/Run：重启或 retry 不重新消费 budget、不创建第二条 link，也不因 context checkpoint 把未完成 attempt 误判为 no-op。
- skipped reason 写入 `automation_runs.summary_json` 与 `automation_run_events`；实际执行的 `xw.standing-order-context.v1` 作为 JSON fact 进入既有 Automation Evidence，继续关联 Work、Run 与 Handoff。
- budget 统计同 project、同 schedule cycle 已写入 Evidence 的 context item 数；不同 project 的 policy、commitment、signals 和计数不能互相消费或投影。

## Authority、兼容与回滚

**Source of truth：** native Standing Order 仍由 `automation_definitions` / `automation_trigger_configs` 定义，tick/lease/retry 仍由 `automation_runs` / `automation_run_events` 定义；Work、Run、Evidence、Handoff、Supervisor commitment 与 heartbeat control 各自保持现有 authority。preflight 只是 composition，不保存第二份 definition、commitment、signal、cursor 或 action state。

**双写/双读：** W0 dual-write=0、dual-read=0。legacy `cron_tasks`、`pi_automations`、`pi_delegations`、`pi_heartbeat_runs/events`、completion watch 与 notification carrier 不迁移、不回写；continuous native Automation 只读取它们已经公开的 policy/signal/projection seam。

**回滚：** 从 native executor 移除 Standing Order preflight 即恢复 P08.04 的直接 Work materialization。已经存在的 Automation run/event、execution link、Work/Run/Evidence/Handoff 保留，不删除、不反写 legacy carrier。

**最终删除门禁：** 只有 P08 后续统一 Watch/Completion、P11/G7 migration/decommission、restart/retry、quiet hours、budget、no-op、多 project 隔离与 backup/restore rehearsal 全部通过，且连续两个正式 release 没有 legacy-only producer/consumer 后，才可删除 compatibility reader 或 legacy carrier；destructive 操作仍须独立的非 LLM approval。
