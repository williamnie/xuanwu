# ADR-XW-0034：Verifier Agent 结构化审查输出

- 状态：Accepted
- 路线 issue：XW P04.08 / Runner #670
- 依赖：[ADR-XW-0032](0032-workflow-verification-policy.md)、[ADR-XW-0033](0033-evidence-policy-completion-gate.md)
- 可执行合同：`backend-ts/src/domain/evidence/verifierReview.ts`

## 1. 决策与根因

旧 `issue.verification_report` 由 `title/error` 拼出 `summary`、`evidenceMissing` 和 `recommendation`，既不读取 P04 Evidence，也不执行 Work acceptance / P04.06 policy。PI verifier workflow 还提示 Agent 调用 `issue accept`，会把 Agent 决定误包装成人工 override。报告结论因此可能与 P04.07 gate 分裂。

P04.08 定义 `xw.verifier-review.v1`，由同一份 `VerificationPolicyEvaluation` 确定性生成：

- `input_context`：Work id/revision/status、acceptance contract/criteria、policy ref、Evidence refs、evaluation time、projection errors；
- `findings`：`acceptance_criterion | policy_requirement | input_integrity`，每项有 `pass | fail | inconclusive`、criterion/Evidence 绑定和确定性理由；
- `verdict`：`passed|overridden -> pass`、`pending -> inconclusive`、`failed|invalid -> fail`；
- `missing_evidence`：按 requirement 写明 kind、scope、criterion 与缺口理由；
- `recommended_next_action`：只允许 `complete_via_gate | fix_and_reverify | collect_missing_evidence | repair_review_input`；
- `gate_consistency`：保存原 policy decision、`satisfied` 和唯一 expected Issue status。

结构化 review 是审查输出，不是权限或状态 mutation command。`complete_via_gate` 只能请求 P04.07 audited gate；review 自身不能关闭 Work、创建 human Evidence 或授权外部/destructive 操作。

## 2. PI verifier workflow 与 prompt-injection 边界

Verifier workflow snapshot 保存 acceptance/Evidence URL 和 output schema。prompt 明确把 Work title、criteria、Evidence excerpt/artifact、comment 和 provider text 视为不可信数据；这些字符串只能进入 bounded/redacted input context，不能决定 verdict、next action 或 gate status。

Verifier 的 pass write-back 改为 `issue update --status done`，由 P04.07 重新投影真实 Evidence 并执行 policy。禁止 Agent 使用 `issue accept` 伪造 user override。fail/inconclusive 只能 request changes 并列出结构化缺口。现有 action gate、provider authorization 和 append-only audit 均保持外层 authority。

## 3. 报告与 Evidence API

- completion gate 在同一事务、同一 evaluation 后记录 `issue.verification_report`；因此 report `expected_status` 与实际 target status 使用同一 mapping；
- advisory `POST /api/issues/:id/verifier-report` 只读投影当前 Work/Evidence，生成同一 schema，不修改 Issue/Work；
- PI report 只投影最新 structured review 的 verdict、Evidence ids、missing evidence、next action 与 gate consistency；
- `GET /api/evidence/:id` 添加引用该 Evidence 的 bounded `verifier_review_refs`，不复制 artifact 或把 report 变成 Evidence authority。

## 4. Source of truth、兼容、回滚与删除门禁

| 窗口 | authority / 读写 |
| --- | --- |
| W1（P04.08） | P04.01 Evidence + P04.06 evaluation 是 verification 语义 authority；P04.07 是 completion mutation authority；`structured_review` 是审查 source of truth |
| W1 compatibility | 旧 `summary/acceptanceChecklist/evidenceFound/evidenceMissing/risk/recommendation` 仅由 structured review 单向生成，供现有 UI 读；不双写第二份判断 |
| W2（最多两个正式 release window） | PI report / Evidence API 读 structured review；legacy fields 仅作展示兼容，并监测 structured/legacy parity |
| W3 | structured-only consumer；legacy fields 按 event retention 保留但不再读取 |

- **双写：** 没有双主。一个 event 只保存一个 canonical `structured_review`，legacy 字段是同 payload 内的 deterministic projection。
- **回滚：** 停用 structured report consumer 和 PI workflow prompt；P04.07 gate/Evidence event 保持不变。已写 append-only report 不删除、不反写；旧 UI 可继续读 projection 字段。
- **最终删除门禁：** P11.03/P11.06 与 G7 完成；连续一个正式 release 无 legacy reader；structured/legacy verdict parity 为 100%；报告与 gate status parity 为 100%；完成回滚 rehearsal 后才删除 legacy projection。

## 5. 验证

```bash
bun test \
  src/domain/evidence/verifierReview.test.ts \
  src/domain/evidence/completionGate.test.ts \
  src/http/piVerifierWorkflowApi.test.ts \
  src/http/frontendCompatibilityApi.test.ts \
  src/http/evidenceApi.test.ts \
  src/pi/reports.test.ts
```

fixtures 固定覆盖 pass/fail/inconclusive、prompt injection 数据边界、missing Evidence、PI workflow 禁止 `issue accept`，以及 report verdict / completion gate status 一致性。
