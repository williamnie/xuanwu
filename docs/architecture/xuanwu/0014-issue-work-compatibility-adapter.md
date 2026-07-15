# ADR-XW-0014：Issue → Work 兼容适配器

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.04 / Runner #650
- 依赖：[ADR-XW-0013](0013-work-ledger-repository-service.md)
- 实现：`backend-ts/src/domain/work/issueAdapter.ts`

## 1. authority 与边界

G4 前 `issues`、`issue_events` 和现有 Issue repository/action 仍是唯一事实与写 authority。适配器把 Issue 确定性投影成 `engineering_task` Work；默认只读且 `shadow_mode=disabled`，不会因读取创建 `works` row。兼容写只调用现有 `updateIssue`、`enqueueIssue`、`retryIssue`、`cancelIssue`，不改变旧 API、runner claim、Session、Guardian 或 PI 行为。

`best_effort` shadow 是显式、默认关闭的 W1 开关。启用后，legacy transaction 先独立提交，再通过 ADR-XW-0013 service 做幂等 target shadow；适配器不直接调用 Work repository 写原语。shadow reject/error 只返回 mismatch 并写审计，不能回滚或覆盖 legacy 结果。本期没有 HTTP/UI caller、自动 backfill、正式双读或 target-primary 路径。

## 2. 双向 ID 与字段映射

| Issue | Work | 规则 |
| --- | --- | --- |
| `issues.id` | `id` | `xw:work:issues:<canonical-positive-id>`；反解拒绝其他 authority、前导零、非安全整数 |
| `project_id` | `owner.project_id` | legacy authority；兼容期不可经 Work adapter 搬迁 |
| — | `type` | 固定 `engineering_task` |
| `title` | `title` | 双向可写 |
| `description` | `goal` | 空 description 回退到 title；Work 写要求非空 |
| `status` | `status` | 七态同名一一映射，不创建第二张状态词表 |
| `workflow_snapshot_json` / prompt snapshot | `workflow_ref` | 内容哈希形成稳定 ref；兼容期只读 |
| Issue row + 首条 `issue.created` | `provenance.origin` | authority=`issues`；有 actor/correlation 时 complete，否则显式 `legacy_incomplete`，不得猜补 |
| Agent Execution Contract | `acceptance` | 固定 v1 criterion；P04/P05 前不接受调用方伪造 Evidence/Handoff |
| 映射所依赖的 Issue 字段 | `revision` | 52-bit 内容哈希，仅作 opaque equality token，不表达先后顺序 |
| `created_at` / `updated_at` | 同名字段 | legacy projection 原样读取 |

`acceptance`、`provenance.origin`、`type`、`owner` 和 `workflow_ref` 没有无损 legacy 写位点，因此 W1 adapter 不接受这些字段反写。title/goal 写带 `expected_revision`；stale、空 patch、非法字段或未通过 gate 均 fail closed，并追加 `issue.work_adapter_write` rejected audit。

## 3. 状态与兼容 action

Work action 只暴露当前已验证的 `enqueue | retry | cancel`，分别翻译到同名 Issue action。适配器先复用 Work 纯函数状态机检查 `expected_revision`、合法边和 `deterministic_policy | human_approval` gate，再调用 legacy action；每次 applied/rejected 都写 actor、reason、correlation、event id、gate、before/after revision 和 outcome。

`in_progress` claim 仍只属于 project loop，`pending_verification -> done` 仍走现有 verification 路径；本适配器不伪造 claim、Evidence 或 Handoff。旧 Issue API 不经过适配器时行为保持不变，并继续是 W1 authority。

## 4. 幂等、冲突和审计

- `audit.event_id` 是兼容写幂等键；同 event id + 同 command 返回既有结果，不重复写；同 event id 改绑 command fail closed。
- shadow event id 从兼容写 event id 确定性派生，create/update/status 全部通过 Work service 记录 `work_events`。
- parity 比较忽略两侧独立的 storage revision/materialization timestamp，只比较业务字段、owner、status、acceptance、provenance 和 workflow ref。
- **G4 前冲突固定由 legacy 获胜**；target mismatch 追加 `issue.work_shadow_mismatch`，不得反向修改 Issue。G4 后 target 获胜只能由 P02.08/P02.09 的审计 cutover 改变，LLM 或 request 参数不能选择 authority。
- external write 与 destructive operation 不在本 adapter 范围；仍须通过 Action Proposal/Approval。适配器不提供 delete。

## 5. 兼容期限、回滚与删除门禁

- W1：legacy-primary read/write + 可选 target shadow，最多一个正式 release；关闭 `shadow_mode` 即停止全部 target 写。
- W2：P02.08/P02.09 target-primary read 与确定性 parity，W1+W2 双读合计最多两个正式 release；cutover flag 始终选择唯一 writer。
- 回滚：关闭 shadow，恢复纯 Issue projection；不得删除 target row。target-only delta 回放、DB 副本演练和正式 backfill 属于 P02.08/P02.09。
- 最终删除兼容路径仍要求 P11.05/P11.09、G7、Issue consumer 为零、备份/恢复演练通过及观察窗结束；任一门禁缺失都保留 Issue carrier/adapter。

## 6. 验证

定向测试覆盖：全部七种 Issue status、rich/legacy provenance fixture、ID/status/字段 round-trip、optimistic conflict、幂等 audit、现有 Issue action 转发、旧 API 不变，以及 shadow `done` gate rejection 时 legacy 获胜和 mismatch 审计。
