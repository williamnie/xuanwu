# ADR-XW-0012：Work Ledger 持久化结构

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.02 / Runner #648
- 领域合同：[ADR-XW-0011](0011-work-ledger-domain-contract.md)
- migration：`backend-ts/src/db/schema/041_work_ledger_schema.ts`

## 1. 边界与 source of truth

本期只增加 `works`、`work_relations`、`work_events` 和查询索引，不增加 repository、API、backfill、双写或双读，也不改变现有 Issue 状态机。

`issues`、`issue_events` 与现有 Issue API/state service 仍是 W0 唯一读写 authority。三个新表在 P02.03/P02.04 的事务服务、稳定 Issue 映射和 parity gate 落地前保持空置；它们不能反向更新 Issue，也不能被 UI 或 LLM 直接写入。W1/W2 的双写、双读期限与最终 authority 切换继续以 ADR-XW-0011 第 9 节为准。

## 2. 表与约束

### `works`

- `id` 使用 `xw:work:<authority>:<external-id>`，`project_id` 外键指向现有 `projects`。
- `type` 和 `status` 通过 SQL `check` 固定为 ADR-XW-0011 的词表；`revision` 必须非负。
- acceptance、provenance 使用必需且 JSON-valid 的 envelope，具体字段与版本仍由领域合同及 P02.03 repository 校验。
- `created_at`、`updated_at` 默认写入 UTC ISO timestamp。

### `work_relations`

- `source_work_id` / `target_work_id` 的含义由 `kind` 决定：`parent_child` 表示 parent → child，`depends_on` 表示 dependent → prerequisite。
- 组合外键把关系两端限制在同一 `project_id`；禁止 self edge 和重复 semantic edge。
- partial unique index 保证一个 child 最多一个直接 parent。DAG cycle 无法用 SQLite 静态约束完整表达，由 P02.03 在同一事务内校验后再写关系和事件。
- actor、reason、correlation、audit event ref 与发生时间均为必需字段。

### `work_events`

- append-only 审计行保存 actor、reason、correlation、确定性/人工 gate、expected/before/after revision、outcome 与 payload。
- gate authority 不接受 `llm`；`outcome` 仅允许 `applied | rejected`，避免把 deny/ask 或 stale revision 伪装成成功 mutation。
- event 必须引用同 project 的既有 Work。P02.03 负责在 mutation transaction 中同时写 row 和 event；本 migration 本身没有 writer。

## 3. 索引与查询形态

- Work 列表/队列：`idx_works_project_updated`、`idx_works_project_status_updated`。
- 正向/反向图遍历：`idx_work_relations_source`、`idx_work_relations_target`。
- Work/project timeline 与 correlation audit：`idx_work_events_work_occurred`、`idx_work_events_project_occurred`、`idx_work_events_correlation`。

数据库测试必须用 `EXPLAIN QUERY PLAN` 固定上述主查询命中对应 index，避免只验证 index 名存在但运行时不使用。

## 4. Schema rollback note

该 migration 是 additive，旧 binary 不读取三个新表；W0 回滚优先部署上一版本并让新表保持 dormant，不需要改写 `issues` 或 `issue_events`。

只有在确认三个表零行、没有 active consumer/writer、保留新鲜数据库备份并取得非 LLM 的 destructive approval 后，才可在单一事务中按以下顺序撤销 schema：

```sql
drop table work_events;
drop table work_relations;
drop table works;
delete from schema_migrations where id = '041_work_ledger_schema';
```

一旦任一表存在正式数据，不得使用上述 drop rollback；应停止 Work 读写、恢复 legacy Issue path，并按 ADR-XW-0011 的稳定 Issue↔Work mapping 回放已审计 delta 后重建 projection。最终删除旧 Issue 路径仍须等待 P11.05/P11.09、G7、零 consumer、备份/恢复演练及观察窗全部通过。
