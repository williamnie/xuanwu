# ADR-XW-0013：Work Ledger repository 与事务服务

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.03 / Runner #649
- 依赖：[ADR-XW-0011](0011-work-ledger-domain-contract.md)、[ADR-XW-0012](0012-work-ledger-schema.md)
- 实现：`backend-ts/src/db/repositories/workLedger.ts`、`backend-ts/src/domain/work/service.ts`

## 1. 边界与 authority

本期提供 `works`、`work_relations`、`work_events` 的 typed repository，以及创建、更新、关系增删、claim 和状态转移服务。服务尚未接入 HTTP、Issue action、runner loop、PI/Guardian 或 UI；P02.04 的稳定 Issue↔Work adapter 落地前，`issues`、`issue_events` 与现有 Issue service 仍是 W0 唯一运行态读写 authority。

因此本期没有双写或双读，也不 backfill 正式数据。W1 仍最多一个正式 release 的 legacy-primary shadow-write window；W1/W2 双读合计最多两个 release window；G4 后才能切换 target authority。最终删除旧 Issue path 仍须满足 P11.05/P11.09、G7、零 consumer、备份/恢复演练和观察窗门禁。

## 2. repository 与 service 职责

repository 负责：

- `WorkLedgerEntry`、`WorkRelation`、`WorkEvent` 与 SQL row/JSON envelope 的确定性映射；
- Work、relation、event 的读取，以及按 project 重建完整 `WorkLedgerSnapshot`；
- revision compare-and-set、relation row mutation 和 append-only event insert 等单步持久化原语。

service 是唯一可供后续 adapter/API 使用的 mutation boundary：

- 每个 mutation 必须携带 actor、reason、correlation、event id、timestamp 与 `deterministic_policy | human_approval` gate；
- update、relation、claim、transition 必须携带 `expected_revision`；status 只能经 `transitionWork`/`claimWork` 修改；
- transaction 内使用 `BEGIN IMMEDIATE` 重新读取 Work 和 project ledger，再运行 ADR-XW-0011 纯函数门禁；
- `done` 不消费 command 中声称的 Evidence/Handoff；service 只在 transaction 内调用受信的 `WorkAcceptanceProjectionReader`，未接 reader 时 completion fail closed；
- applied mutation 同时 bump revision 并 append event；stale revision、deny/ask、dependency/child/acceptance 或 DAG 前置条件失败时不改 row，只 append `outcome=rejected` event；
- event id 是 mutation idempotency key；同 event id 且 request fingerprint 一致的重试返回既有结果，改绑到另一 Work/type/operation 或不同 command 时 fail closed。

关系删除先 append 审计 event，再删除 relation row 和 bump source Work revision；三步仍在同一 transaction 中提交或回滚。relation 的 source Work（parent 或 dependent）拥有该 mutation revision。

## 3. event 一致性

| 操作 | event type | revision |
| --- | --- | --- |
| create | `work.created.v1` | `expected=before=after=0` |
| metadata/contract update | `work_ledger.work_updated.v1` | applied 时 `after=before+1` |
| claim/transition | `work.status_changed.v1` | applied 时 `after=before+1` |
| relation add/remove | `work_ledger.relation_added.v1` / `work_ledger.relation_removed.v1` | source Work applied 时 `after=before+1` |
| rejected mutation | 与请求相同 | `before=after=current`，保留原始 `expected_revision` 与 violations |

create/update/status event payload 保存 mutation 前后 Work snapshot；relation event 保存确定性 relation。任一 event insert 失败都会回滚同 transaction 内已经执行的 Work/relation 写入。

`work.created.v1`、`work.status_changed.v1` 复用 P00.04 的公开 domain event allowlist；metadata/contract 和 relation 记录使用 `work_ledger.*` 内部审计类型，不冒充尚未进入共享合同的公开 domain event。P02.07 若要把它们投影到跨域 timeline，必须先按公共合同演进流程确定公开名称。

## 4. 回滚与后续接线

当前没有 runtime caller、feature flag、双写或正式数据副作用；代码回滚可部署 P02.02 版本并保留 dormant 表。不得因回滚本服务删除已有 Work rows 或三个表。

P02.04/P02.06 必须复用本 service，不得从 adapter/API 直接调用 repository 写原语，也不得把 request/LLM payload 直接实现为 `WorkAcceptanceProjectionReader`。P04/P05 接线时 reader 必须从当前 Evidence/Handoff authority 确定性投影。后续还必须分别证明 legacy mapping、权限/auth error contract、shadow-write parity 和正式库副本 rollback；这些不属于 P02.03。
