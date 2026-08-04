# ADR-XW-0079：PI Action、Proposal、Approval 与 Attention 决策层收敛

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P11.03 / Runner #738
- 硬依赖：P02.05 / #651、P08.07 / #713、P08.08 / #714、P10.02 / #725（均为 `done`）
- 数据迁移：`052_consolidate_pi_decision_layers`
- 可执行 delete gate：`maintenance attention audit`

## 根因与 mapping

P08.09 已让 Command Center 读取统一 Attention projection，但 projection 只包含 intake Inbox、Guardian 和 provider
Approval。内部 `pi_actions.status=pending|snoozed|changes_requested` 仍只能从 `/api/pi/actions` 发现；关联
`pi_action_proposals` 也只能在旧 Attention Inbox 页面决定。2026-07-18 的 launchd/3008 live authority 中有 746 条
`pi_actions`，其中 1 条 `pending`、1 条 `snoozed`，而 Command Center route 尚未部署（404）。因此旧 API/UI 不是
consumer-zero，不能删除表或旧读接口。

本次只收敛决策夹层，不改 Work、Run、provider protocol 或 Action 状态机：

| 对象 | source of truth | 统一映射 |
| --- | --- | --- |
| internal Action | `pi_actions`；审计为 `pi_action_events` | active approval 状态投影成 `approval_required` Attention，ID 为 `xw:attention:pi_actions:<id>` |
| Action Proposal | `pi_action_proposals` | 作为来源 Attention 的 `proposal:<id>` related ref；不成为第二个 Attention authority |
| provider Approval | `pi_approval_requests` + provider acknowledgement | 继续投影成 `approval_required` Attention |
| intake / Guardian | 各 legacy carrier | 保持 P08.07 的确定性 projection 与 command overlay |

Proposal approve 仍只创建/复用一个 `pi_actions` idempotency chain，再经现有 deterministic Action Gate 和 dispatch；
Proposal reject 会在同一 service 中把关联 Inbox source 标为 `ignored`。LLM 只能提出 proposal/rationale，不能调用
绕过 gate 的 writer。

## Service 与 API 收敛

`attentionDecisionService.ts` 是 Action、Proposal、provider Approval 的唯一 HTTP decision seam。Command Center 使用：

- `GET /api/command-center/attention/:id`：读取 bounded decision detail；
- `POST /api/command-center/attention/:id/actions/:action`：按已验证的 `decision_ref` 执行 approve/reject 等命令。

旧 `/api/pi/actions/:id/*`、`/api/pi/action-proposals/:id/{approve,reject}` 和
`/api/pi/approval-requests/:id/resolve` mutation route 保留为 translation-only adapter，并返回 `Deprecation: true`、
successor `Link` 和 `Warning`。它们不再各自持有 decision implementation。旧 GET detail/audit route 继续可读，
保证历史记录、provider drill-down 和 P11.09 前的恢复能力。

## Event migration、双读退出与回滚

`052_consolidate_pi_decision_layers` 不建新表、不复制 authority。它只做两件可重放的 forward migration：

1. 用 `action-proposal:<proposal-id>:<proposal-action-id>` 幂等键回填历史 Proposal action 的 `pi_action_id`、
   `execution_status` 和已有 result/error；
2. 对真实 parent/child `pi_actions` 追加 `action_proposal.migrated` / `action_proposal.action_mapped` audit event，保存
   proposal/source mapping；原 Proposal、Action 和 event 均不改写或删除。

新 runtime 不做 request-time old/new reader comparison：Command Center 直接从当前 authority 构建一次 projection；旧 mutation
route 只调用同一 service，不双写。迁移回滚使用 P10.02 的 fresh pre-forward SQLite backup 恢复隔离副本；旧 binary 仍能读取
保留的 carrier。迁移后已经发生的真实 external effect 不通过反写 DB 伪造回滚。

## Delete gate

```bash
xuanwu maintenance attention audit \
  --db /tmp/xw-p11-03/runner-copy.db \
  --report /tmp/xw-p11-03/attention-audit.json --json
```

报告分开给出 `data_gate_passed` 与 `destructive_delete_authorized=false`，并检查 active Action、pending Approval、proposed
Proposal、Action audit orphan、approved Proposal→Action link 和 Proposal→Attention source gap。即使 data gate 通过，本工具也
不会授权删除；仍必须由 P11.09/G7 提供一个正式 release 的 legacy mutation consumer-zero、fresh backup、隔离 restore、保留的
rollback artifact 和 exact non-LLM destructive approval。

本 issue 不 drop `pi_actions`、`pi_action_proposals`、`pi_approval_requests`、`pi_action_events` 或索引。

## 最小验证与副本演练

```bash
cd backend-ts
bun test src/domain/attention/contracts.test.ts src/domain/attention/consolidationAudit.test.ts \
  src/db/consolidatePiDecisionLayersMigration.test.ts src/http/commandCenterApi.test.ts \
  src/http/piActionProposalsApi.test.ts src/http/piActionsApi.test.ts \
  src/http/piApprovalRequestsApi.test.ts src/cli/maintenance.test.ts

xuanwu maintenance db migration-forward --db <copy> --backup <pre-forward> \
  --report <forward.json> --actor release-operator --actor-kind user --audit-ref issue:738 \
  --reason 'P11.03 copy rehearsal' --apply --confirm-backup-tested --confirm-no-active-writers --json
xuanwu maintenance attention audit --db <copy> --report <attention-audit.json> --json
xuanwu maintenance db migration-rollback --db <copy> --backup <pre-forward> \
  --report <rollback.json> --actor release-operator --actor-kind user --audit-ref issue:738 \
  --reason 'P11.03 rollback rehearsal' --apply --confirm-backup-tested --confirm-no-active-writers --json
```
