# ADR-XW-0036：Handoff 与 Delivery 状态合同

- 路线 issue：XW P05.01 / Runner #672
- 硬依赖：XW P00.04 / #634（`done`）、XW P04.01 / #663（`done`）
- 可执行合同：`backend-ts/src/domain/handoff/contracts.ts`
- canonical 级别：本文与可执行合同是 Handoff 交付模式、结构化事实、review、risk、rollback 和状态门禁的 source of truth；P00.04 继续是 Handoff ID、四态词表和状态边的唯一 source of truth

## 1. 边界与 authority

Handoff 是某个 Work 在一个确定 revision/tree 上的**版本化、可重建 projection**，不是 Git、外部 provider、Evidence 或 Work 状态的新 authority：

- Work/Run 链接来自 P02/P03 的确定性 ID；P04.01 `EvidenceRecord` 继续拥有验证事实与 `passed` 判定。
- changed files、baseline/final revision、branch/commit 来自 Git；PR、deploy、release 与 tracker result 来自对应 provider response；gate/result audit 来自 `pi_action_events` 等现有审计 carrier。
- `issues`/Work service 继续拥有 Work status。Handoff 只能作为完成门禁输入，不能反向越权把 Work 设为 `done`。
- narrative `summary`、risk 说明或 rollback 草稿可由 LLM 辅助生成；ID、revision、artifact ref、Evidence status、review decision、gate 和 action outcome 必须由确定性读取或人类审批提供。

本期不实现 P05.02–P05.08 的 changed-files collector、Git writer、remote provider、review loop、repository/API/UI，也不执行 commit、push、PR、deploy、release 或 tracker update。

## 2. Delivery mode 与必填事实

`delivery.mode` 是闭集；未知值 fail closed。每个模式都必须满足公共字段，并额外提供下列事实：

| mode | 必填 delivery facts | required delivery actions |
| --- | --- | --- |
| `local_changes` | `working_tree_ref`，且等于 `final_revision` | 无外部 action；状态 transition audit 仍必需 |
| `branch_commit` | `branch_ref`、`commit_ref` | `commit` |
| `push` | branch/commit、`remote_ref` | `commit`、`push` |
| `draft_pr` | branch/commit/remote、`pull_request_ref`、`url` | `commit`、`push`、`pull_request` |
| `ready_pr` | 与 draft PR 相同；review 必须处于 active state | `commit`、`push`、`pull_request` |
| `deploy` | `revision_ref`、`environment`、`deployment_ref` | `deploy` |
| `release` | `revision_ref`、`version`、`release_ref` | `release` |

branch/commit/PR 模式的 `commit_ref`，deploy/release 的 `revision_ref` 必须等于 `final_revision`。前五种代码变更模式必须有 scoped `changed_files`；deploy/release 可以只交付已经存在的不可变 revision/artifact。

`tracker_update` 是可选 delivery action，不构成新的 delivery mode。它与 push、PR、deploy、release 一样是外部写，必须经过独立 gate 并记录 provider result；不得因为某个 mode 已获准而隐式授权 tracker update。

## 3. Handoff schema

`HANDOFF_SCHEMA_VERSION=1`。`HANDOFF_SCHEMA` 闭合字段并由 `validateHandoff()` 做跨字段/跨对象校验：

| 区域 | 合同 |
| --- | --- |
| identity/version | `id=xw:handoff:derived:*`、`revision>=0`、可选 `supersedes_id`；不能 supersede 自己 |
| owner/links | 唯一 `work_id`；`run_ids`、`evidence_ids` 必须存在于校验 context 且属于同一 Work |
| artifact | `baseline_revision`、`final_revision`、P00.04 `review_ref`、去重的 `changed_files` 与 mode-specific delivery facts |
| actions | action、required、classification、target、P00.04 `gate_decision`、trusted gate authority/policy、outcome、audit event、before/after/rollback refs |
| completion | `ready|delivered` 至少引用同一 Work 的一条 `passed` Evidence；`delivered` 的 required actions 全部成功 |
| human loop | `review` 明确 required/state/ref/reviewer/decision timestamp，不用空字符串猜测 |
| operations | `risks` 与 `rollback` 永远存在；无风险可为空数组，不可回滚必须显式 `blocked` 并关联 risk |

Handoff 不内嵌 Evidence output、provider response body 或 diff 内容，只保留 typed refs，避免复制第二套事实。引用的 raw artifact 继续遵循 retention/redaction policy；含 token、cookie、signature 或 credential 的 URL/ref 必须在进入 Handoff 前由 producer 脱敏，不能把秘密放入 summary、risk、rollback 或 provider ref。

## 4. 状态与 review

状态表直接复用 P00.04：

```text
draft -> ready -> delivered
   \        \        \
    +-------> superseded
```

- `draft`：结构化 artifact 已形成，但 Evidence、review 或 delivery action 尚未满足目标状态。
- `ready`：同 Work `passed` Evidence 已存在，内容可审查；不等于 review approved，也不隐含外部写已授权。
- `delivered`：所有 `required=true` action 均有 `allow + succeeded + after_ref`；若 `review.required=true`，review 必须 `approved`。
- `superseded`：revision、reviewer changes 或 delivery target 变化时保留旧版本；transition 必须给出新的 `superseding_handoff_id`。终态不原地改写。

Review states 为 `not_requested | pending | approved | changes_requested | not_applicable`。`pending/approved/changes_requested` 必须有 `review_ref`，decision state 还必须有 `decided_at`。`ready_pr` 不能是 `not_requested/not_applicable`；PR review ref 必须指向同一 `pull_request_ref`。`changes_requested` 不能同时宣称 Handoff 为 `ready|delivered`，应形成新 Handoff version 并 supersede 旧版本。

## 5. 风险与 rollback

`risks` 使用稳定 ID、severity、summary、mitigation 和 source refs；“没有已知风险”表示空数组，而不是省略字段。`rollback` 的 availability 必须是：

- `not_required`：只允许 `local_changes` 等无需外部逆操作的交付；
- `available`：必须写明 plan，可附回滚 revision/provider refs；
- `blocked`：必须写明不可回滚原因，并至少记录一个对应 risk。

非 `local_changes` 交付不得用 `not_required` 跳过 rollback 评估。若 rollback 本身是 destructive 操作，必须给出 `approval_policy_ref`；该 ref 只是门禁引用，不是 approval decision。真正执行仍由后续 action service 重新读取当前状态并取得非 LLM `allow`。

## 6. 审计与权限门禁

`evaluateHandoffTransition()` 是纯函数，检查 current revision、P00.04 状态边、target-state 前置条件和 transition audit。每次状态变化必须包含 actor、event/correlation ID、reason、timestamp 和 gate。

每个 local state change、external write 或 destructive delivery action 都必须记录：

- `classification`、operation/action、target；
- `gate.authority=deterministic_policy|human_approval`、`gate_decision`、policy ref；
- `outcome=not_executed|succeeded|failed`、`audit_event_ref`，成功时的 `after_ref`；
- 可用时的 `before_ref` 与 `rollback_ref`。

`deny|ask` 只能得到 `not_executed`；未 `allow` 不得声称执行成功/失败。LLM 输出不能提供 allow、伪造 provider outcome、改变 Evidence/review 状态或绕过 destructive approval。后续 P05 writer/provider 必须把 proposal payload 与重新读取的 deterministic authority 分开，不能直接把模型 JSON 写入 Handoff authority。

## 7. 当前兼容 projection

P04.07 completion gate 当前只在 transaction 内构造 `{id, work_id, status: ready}`，作为 legacy Issue → Work `done` 门禁的最小 compatibility signal。它没有 mode、Git snapshot、delivery action、risk、rollback 或 review facts，因此：

1. 它不是 `HandoffRecord`，不得由 P05 API 当完整 Handoff 返回；
2. 它只能与同一次 deterministic Verification Policy evaluation、当前 acceptance version 和 passed Evidence 一起消费；
3. P05.02–P05.08 接线前继续保留该路径，不能复制另一个 completion writer，也不能用 LLM 补齐缺失字段；
4. 切换时必须由 authoritative Git/Evidence/audit facts 重建完整 record，并以稳定 mapping 做 parity。

## 8. 兼容、迁移与删除门禁

- **本期 source of truth：** `issues`/Work、`issue_runs`、P04 Evidence、Git、`pi_action_events` 与外部 provider 各自继续 authoritative；`domain/handoff` 只提供 schema/validator，不持久化。
- **本期双写窗口为 0；双读窗口为 0。** 没有新 table、column、API、provider adapter 或运行时 writer。
- **未来窗口：** evidence/handoff stream 只允许 plan.json 的 W1 一个正式 release shadow-write；W1 与 W2 合计最多两个正式 release window。每个 record 必须保存 old source refs、stable ID mapping、mode/status/revision/action parity 和 mismatch audit；不得出现双主。
- **cutover：** 仅 G4 且 P05.08 repository/API、P04.09 Evidence read、P05.03–P05.07 producers/reviewer loop 和 clean-baseline Golden Journey 通过后，才能由 audited flag 切换单一 authority。
- **回滚：** 删除本期文件即可，无数据恢复。未来 cutover 失败时停止 target writes、恢复 legacy Evidence/Handoff assembly 与 deterministic done gate，保留 target records/audit，并从 provenance refs 重建；不得删除或反写 Git/provider/raw event。
- **最终删除门禁：** 仅 P11.03/P11.06 在 G7、全部 audit/provenance consumer 映射完成、legacy producer/consumer 连续一个正式 release 为零、contract fixture 留档、provider/artifact 备份恢复演练和观察窗通过后，才能删除 legacy completion projection/adapter。本 issue 不删除任何旧路径。

## 9. 验证合同

```bash
cd backend-ts
bun test src/domain/handoff/contracts.test.ts
bunx tsc --noEmit
```

Focused tests 必须证明：

- 七种 delivery mode 的 schema 都可运行，且各自缺少必填字段时 fail closed；
- Handoff 四态与 P00.04 完全一致，terminal state 不被放宽；
- cross-Work/missing/duplicate Run 与 Evidence refs 被拒绝，`ready|delivered` 需要 passed Evidence；
- required action、review、risk 和 rollback 规则生效；
- status、external write 与 destructive action 都需要 trusted gate/audit，LLM authority 被拒绝；
- supersede 必须指向新的 Handoff identity。

## 只读任务的零文件凭证

`local_changes` 允许 `changed_files=[]`，仅限 baseline_revision 与 final_revision 相同、delivery_actions 为空且关联 Run 和 Evidence。ready/delivered 仍必须关联同 Work 的 passed Evidence。该凭证只声明验证及快照，不声明已有脏文件归属。其他交付模式仍要求原有文件、动作、审批及回滚事实。首启检查通过现有 recordHandoffDelivery 写入同一事件流，未增加数据库表或状态机。
