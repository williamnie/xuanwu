# ADR-XW-0021：Run / Attempt 关联字段与迁移

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.02 / Runner #657
- 依赖：[ADR-XW-0020](0020-run-attempt-lifecycle-contract.md)、[ADR-XW-0012](0012-work-ledger-schema.md)
- migration：`backend-ts/src/db/schema/042_run_attempt_relations.ts`

## 1. 边界与 source of truth

本期只建立稳定 Run identity、Issue-backed Work link、Attempt child facts 与 Session drill-down 关联，不增加 Run repository、HTTP API、provider adapter、控制 command 或 UI。

`issue_runs` 仍是唯一 Run authority。现有 `id`、`issue_id`、`attempt`、`status`、provider refs、start/end 和 terminal 列在 W1 继续是唯一 lifecycle 读写来源；本 migration 不改变 Issue/Run 状态机，也不允许 `run_attempts` 反向关闭或重新拥有 Run。

`agent_sessions` 仍是 observation / drill-down。它可以被多个 Attempt 引用，但 session status、raw payload 或后到的 provider ref 都不能创建新 Run、改变 Work owner 或写 Run terminal status。`run_attempts.agent_session_key` 仅在现有 session key 精确匹配时建立 nullable 外键；缺少 Session row 不会产生伪造记录。

## 2. ID mapping 与约束

### 2.1 Run / Work

`issue_runs` 增加三个只读 generated columns，旧 binary 无需写入：

| target | deterministic mapping |
| --- | --- |
| `run_id` | `xw:run:issue_runs:<issue_runs.id>` |
| `work_id` | `xw:work:issues:<issue_runs.issue_id>` |
| `run_sequence` | 原 `issue_runs.attempt`；它是同一 Work 下的 Run sequence，不是 provider Attempt sequence |

`run_id` 全局唯一，`(work_id, run_sequence)` 唯一。`work_id` 在 W1 通过既有 `issue_runs.issue_id -> issues.id` 外键解析；不能直接指向 `works`，因为正式 Work backfill 可以尚未执行且 `issues` 仍是 authority。Work target row 存在时，其 canonical ID 必须与该 generated value 相同。

### 2.2 Attempt

`run_attempts` 是 `issue_runs` 的 child facts，不是第二张 Run 表：

- `attempt_id = <run_id>~attempt:<positive sequence>`；`(run_id, sequence)` 唯一。
- composite FK `(run_id, issue_run_id)` 保证 Attempt 只能属于 identity 一致的 legacy Run；删除 legacy Run 时 child cascade。
- 每个 migration 时已存在的 `issue_runs` row 确定性投影一个 `kind=initial, sequence=1` 的 Attempt。后续 `resume|recovery` 由 P03.04 的受审计 command 创建，本 migration 不猜测。
- provider invocation ref 使用现有 `issue_runs.id` anchor；session/turn 优先读取通用 provider 列，缺失时才读取 Codex compatibility 列。
- cost 初始为 `unavailable` 合同值，不能把未知 token 或金额写成零；P03.03 才消费 provider usage Evidence。

旧 writer 插入/更新 `issue_runs` 时，deterministic trigger 维护唯一 initial Attempt；一旦同一 Run 已存在后续 Attempt，该 compatibility update trigger 停止覆盖 initial Attempt，避免把 Run-level legacy status 错写到 resume/recovery Attempt。Session 晚于 Run 到达时，Session trigger 只补精确 observation link。

## 3. legacy columns policy 与未知状态

P03.01 的已知映射保持固定：

| legacy `issue_runs.status` | initial Attempt status |
| --- | --- |
| `in_progress` | `running` |
| `pending_verification`, `done` | `succeeded` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

历史库可能含 `auto_retry`、`hold`、`todo`、`triage` 等旧 Run row。未知 legacy status 必须保留原值并 fail closed：`run_attempts.status=NULL`，`legacy_status` 保存原值，`mapping_error` 保存确定性错误；migration 不把它猜成 succeeded/failed/cancelled，也不允许 unified reader 把该行当成已通过 lifecycle validation 的 Attempt。后续修复必须引用原始 `issue_runs`、provider/runtime event 与受审计 repair command，不能由 LLM summary 决定。

`issue_runs.attempt`、`issues.attempt_count`、Codex compatibility refs 与 `agent_sessions.issue_id/status` 均保留。删除或改义必须有 superseding ADR、parity Evidence 与独立迁移，P03.02 不做清理。

## 4. 索引与无孤儿门禁

- Work Run 列表：`ux_issue_runs_work_sequence`。
- canonical identity / legacy lookup：`ux_issue_runs_run_id`、`ux_issue_runs_run_legacy`。
- Run Attempt：`ux_run_attempts_run_sequence`、`ux_run_attempts_provider_invocation`。
- Session/provider 下钻：`idx_run_attempts_agent_session`、`idx_run_attempts_provider_session`。

迁移测试必须同时证明：Run/Attempt ID 数量和唯一性一致、Attempt composite FK 无 orphan、非空 Session link 无 orphan、generated Work ID 可由 authoritative Issue 解析、`pragma foreign_key_check` 为空，并用 `EXPLAIN QUERY PLAN` 证明主要查询命中声明索引。

## 5. 兼容期限、审计与权限

- **W1（本期）：** legacy `issue_runs` projection primary；generated relation 与 initial Attempt 只作可重建 child facts。
- **W2：** unified projection 可 primary，legacy projection只做 comparison/fallback，最多一个正式 release；任一 mapping/parity drift 立即回到 legacy read。
- **双写窗口为 0：** trigger 写入的是同一 `issue_runs` authority 的确定性 child projection，不是 shadow Run authority；没有第二条 lifecycle mutation path。
- migration outcome 由 `schema_migrations(042_run_attempt_relations)` 审计。schema/backfill 没有外部调用、destructive 操作或 LLM gate；P03.04 的 retry/resume/interrupt/supersede 必须另行通过 deterministic/human gate 和 append-only audit event。

## 6. Schema rollback note

该 migration 是 additive，旧 binary 使用显式 legacy columns，可在停用 unified Run consumer 后直接恢复部署。首选数据回滚是：停止读取 `run_attempts` 和 generated columns，恢复纯 `issue_runs` lifecycle projection与 Sessions view，并保留 additive schema dormant；这不需要反写或删除 authority 数据。

只有在保留新鲜备份、确认没有 active writer/consumer、确认 `run_attempts` 只含可重建 compatibility facts，并取得非 LLM destructive approval 后，才可在维护窗口执行物理 schema rollback：

```sql
drop trigger trg_agent_sessions_run_attempt_link_update;
drop trigger trg_agent_sessions_run_attempt_link_insert;
drop trigger trg_issue_runs_run_attempt_update;
drop trigger trg_issue_runs_run_attempt_insert;
drop table run_attempts;
drop index ux_issue_runs_work_sequence;
drop index ux_issue_runs_run_legacy;
drop index ux_issue_runs_run_id;
```

SQLite 删除 generated columns 需要 rebuild `issue_runs`，风险高于保留 dormant additive columns；本期 rollback 禁止为“清理”重建 authority table。也不得仅删除 `schema_migrations` 记录造成重复 backfill。若 `run_attempts` 已包含 P03.04 正式 resume/recovery facts，则禁止 drop，必须恢复 legacy read 并保留数据等待受审计 replay/runbook。

最终只允许 P11.05 在 Sessions consumer 为零、G7、旧 API contract 留档、备份/恢复演练和观察窗通过后退役 Sessions 入口；不得删除 `issue_runs`。`agent_sessions` 的保留/最小化另受 Session/Evidence retention policy 控制，不能由本 migration 级联清理。

## 7. 验证

最小门禁：

```bash
bun test backend-ts/src/db/runAttemptMigration.test.ts backend-ts/src/db/database.test.ts
```

除 empty/history fixture 外，应在 SQLite online backup 或等价一致性副本上运行当前 binary migration，再检查 migration id、mapping counts、unknown-status quarantine、orphan counts、`pragma foreign_key_check` 与 `pragma quick_check`；不得在 live DB 上做首次 destructive 验证。
