# ADR-XW-0015：Action / Automation Watch → Work 关系适配器

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.05 / Runner #651
- 依赖：[ADR-XW-0013](0013-work-ledger-repository-service.md)、[ADR-XW-0005](0005-capability-disposition-inventory.md)
- 实现：`backend-ts/src/domain/work/piRelationAdapter.ts`

## 1. 决策与边界

`pi_actions` 与 `automation_watches` 不获得 Work identity，也不成为新的 Work type。适配器只把它们投影为既有 Issue-backed Work 的 **execution / observation** 关系；`authorization` kind 为已有公共读合同保留，但 target-primary 路径不再读取 `pi_delegations`：

| legacy carrier | relation kind | Work 目标 | 语义 |
| --- | --- | --- | --- |
| `pi_actions` | `execution` | action 明确引用、创建或操作的 Issue-backed Work | 一次经过既有 Action gate 的执行/副作用事实 |
| `automation_watches` | `observation` | subject 引用的 Issue-backed Work | 只观察完成；不创建 Work、不改写 acceptance |

这是 read-only compatibility projection，不扩展 ADR-XW-0011 的 Work-to-Work `parent_child | depends_on` 合同，也不写 `works` 或 `work_relations`。因此读取空表或重复读取都不会产生重复 Work 或重复 semantic relation。

## 2. identity、引用与去重

- Work ID 继续复用 P02.04：`issues.id=N -> xw:work:issues:N`；adapter 不分配第二个 Work ID。
- relation ID 由 `kind + carrier authority + immutable carrier id + Work ID` 确定性生成。相同输入重复投影得到同一 ID。
- `source_ref` 保存 carrier `authority/external_id/source_status/updated_at`；Action audit 追加 `xw:evidence:pi_action_events:<id>`，关联 conversation/delegation/guardian/heartbeat 只作为 `related_refs`。
- 历史 Action 上的 delegation id 只保留为 `related_refs` provenance，不触发对 `pi_delegations` 的读取。
- Watch 只使用持久化 `automation_watches.subject_json`；origin conversation/source event/source message 保留为 related refs。
- Action 优先使用 row `issue_id`，并兼容 payload 的显式 `issue_id(s)/target_issue_id(s)`；`issue.create`、`agent.workflow_request` 只读取结果顶层明确返回的 `id|issue_id`。不递归猜测任意 JSON 数字。

无法确定 Work 的 carrier 不静默丢失：projection 的 `unmapped` 返回 `missing_work_reference | missing_work | project_mismatch` 和完整 source ref。历史未知状态保留原始 `source_status`，归一化为 `legacy_unknown`，不得猜成成功。

## 3. 生命周期映射

关系 lifecycle 只用于统一读取，不回写 carrier，也不触发 Work transition：

| carrier | source status | relation lifecycle |
| --- | --- | --- |
| Action | `candidate/pending/approved/proposed/pending_approval/changes_requested` | `pending` |
| Action | `executing/running/in_progress` | `active` |
| Action | `snoozed/paused` | `paused` |
| Action | `completed/succeeded/success/done` | `completed` |
| Action | `failed/error/denied/rejected/timeout` | `failed` |
| Action | `cancelled/skipped/superseded` | `cancelled` |
| Watch | `active` | `active` |
| Watch | `satisfied/notified` | `completed` |
| Watch | `failed/cancelled` | `failed/cancelled` |
| 任意历史未知值 | 原值保留 | `legacy_unknown` |

Action `completed` 只说明 Action 执行结束，不等于 Work `done`；Watch `satisfied/notified` 也不构成 passed Evidence 或 Handoff。Work transition 仍由 Work/Issue authority 与确定性 acceptance/permission gate 决定。LLM 只能读取或提出 proposal，不能通过 relation lifecycle 改状态、授予权限或绕过审批。

## 4. source of truth、兼容期限与回滚

- W3/G4：`automation_watches` 是 observation relation 的唯一 source of truth；legacy delegation/watch 表只保留为 rollback/archive，adapter 不再读取它们，双写、双读均为 0。
- 旧 Automation 入口为 audited redirect-only compatibility surface，不得继续双存储写入。
- 回滚：停止 target release，恢复保留的 pre-cutover SQLite backup 并部署上一 release；不得同时启用两个 writer，也不删除任何 carrier 表。
- 最终删除要求 P11.03/P11.04/P11.05/P11.09 对应 consumer-zero、无 active delegation/watch/action、审计与 cursor parity、备份恢复、观察窗和 G7 非 LLM destructive approval 全部通过。

## 5. 不迁移清单

本 issue 明确不迁移：

1. 无明确 Issue/Work ref 的 project/global Action；它继续留在 `pi_actions/pi_action_events` 审计链。
2. legacy Delegation；不自动关联项目全部 Work，不复制 authorization policy，历史 id 仅可作为 Action provenance。
3. subject 缺失 Issue 或 project 不一致的 Watch；保留 watch/cursor/error/notification authority 并报告 gap。
4. Action Proposal、Approval、Guardian decision、heartbeat、notification/outbox、Run/Session、Evidence/Handoff；只保留引用，不吞并事实或权限。
5. carrier payload/result、状态机、writer、API、provider adapter 和 destructive delete；本 adapter 没有 mutation 方法。

后续 backfill 只能消费稳定 relation ID 与 `unmapped` 报告；不得在本 adapter 中补第二套 carrier、猜测缺失 provenance，或把 projection 当成 authoritative persistence。

## 6. 验证

`piRelationAdapter.test.ts` 覆盖 Action event/source refs、native Watch 多 Work、生命周期分支、空表、历史 Action fallback、缺失/错 project gap、重复读取幂等，以及 `works/work_relations` 始终为零。
