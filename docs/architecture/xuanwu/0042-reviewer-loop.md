# ADR-XW-0042：Reviewer Loop 与修改回路

- 路线 issue：XW P05.07 / Runner #678
- 硬依赖：XW P04.08 / #670（`done`）、XW P05.01 / #672（`done`）
- 可执行实现：`backend-ts/src/domain/handoff/reviewerLoop.ts`
- focused fixtures：`backend-ts/src/domain/handoff/reviewerLoop.test.ts`

## 1. 边界与 authority

`createReviewerLoopService()` 是 workflow-neutral 的 reviewer loop orchestration seam。Repair/Review Workflow
以后只需注入 reviewer provider、当前权限 gate、repair Run scheduler 和 audit sink，不得在各 Workflow 内复制
`request_changes -> repair Run -> fresh Evidence -> re-review` 状态机。

本 service 不新增 DB/schema、HTTP route、provider adapter、共享 Work/Run/Handoff 状态词表，也不写 Issue/Work
状态。现有 authority 保持不变：

- Work/Issue 与 `issue_runs` 分别拥有 Work/Run 状态；repair scheduler 负责真正创建 Run；
- P04 `EvidenceRecord` 和结构化 verifier review 拥有验证事实与确定性 verdict；
- P05.01 `HandoffRecord` 是 Git、Evidence、review 和 delivery audit 的可重建 projection；
- 人工决策来自现有 authenticated human approval carrier；audit sink 保存请求、决定、修复 intent/outcome 和预算耗尽事实。

Reviewer Loop 只返回 Handoff projection、append-only cycle history 和新 `RunWorkRelation`，不能自行把 Work
设为 `done/failed/triage`，也不能执行 push、PR、tracker update、deploy 或其他外部写。

## 2. Reviewer provider 与门禁

`ReviewerProvider` 以 `provider_id + mode(automated|human)` 注册，接收当前 Handoff、同 Work link context、
cycle budget、历史 findings 及上一 Repair Run 的 fresh Evidence refs：

- automated provider 必须返回 P04.08 `StructuredVerifierReview`；`accept/request_changes/reject` 必须与
  `pass/inconclusive/fail` 一致；
- human provider 返回显式 findings 和 decision ref；required human review 不允许 automated provider 代答；
- provider 输出是待验证数据。独立注入的 `ReviewerDecisionGate` 必须从当前 deterministic policy 或 human
  approval authority 重新授权；LLM/provider 输出不能自授权，也不能在 payload 中声明 `allow`；
- `accept` 只把当前 ready Handoff projection 的 review 更新为 approved；真正 Work completion 仍走 P04.07 gate。

`reject` 是 reviewer-loop 终态记录，不强行发明 P05.01 不存在的 Handoff review state。后续 Workflow 可按既有
Work service 将 Work 转为 failed，但必须引用本次 decision/audit。`request_changes` 只有在预算尚有剩余时才调用
repair scheduler。

## 3. 修改回路与 cycle budget

`max_cycles` 范围为 `1..16`，每一次 reviewer 决定消耗一个 cycle：

1. 先写 `handoff.review.requested.v1`，再调用 reviewer provider；
2. 校验 findings、current Work/Handoff/Evidence refs，并经独立 gate 授权；
3. 写 `handoff.review.decided.v1`；accept/reject 结束；
4. request_changes 且预算有余时，先写 `handoff.review.repair_requested.v1` intent，再调 scheduler；
5. scheduler 必须返回同 Work 的全新 Run、`executes` relation、新 Handoff identity 和 fresh passed Evidence；
6. 写 `handoff.review.repair_run_created.v1` 后进入下一 review cycle；最后一个 cycle 再 request changes 时写
   `handoff.review.budget_exhausted.v1`，不得额外创建 Run。

每个 repair Handoff 必须 `supersedes_id=previous_handoff.id`，保留所有旧 Run/Evidence refs，并链接新 Run 与
fresh Evidence。结构化 re-review 至少消费上一 Repair Run 的一条 fresh Evidence，否则 fail closed。

## 4. Evidence、findings 与 audit

每个 `ReviewerCycleRecord` 保存当时的 Handoff ID、完整 Evidence ID snapshot、fresh Evidence、findings、
decision/authorization/policy refs。`evidence_history` 逐 cycle 返回，不使用“最新结论”覆盖旧记录。

Repair validation 会逐项比较旧 context；旧 Evidence 结论保持 append-only，既不能改 status/owner，也不能从新
Handoff 丢弃。新 Evidence ID 必须未出现过、属于同 Work、被新 Handoff 引用，且至少一条为 `passed`。因此失败
Evidence、旧 review finding 和后续 passed Evidence 可以同时被审计和重放。

所有 provider 调用、gate 结果、repair Run intent/outcome 和 budget exhaustion 均有 correlation/cycle/Handoff/
Work/provider refs。provider、gate 或 scheduler 失败写 `handoff.review.failed.v1`；错误文本走现有 redaction。

## 5. 兼容、迁移、回滚与删除门禁

- **当前 source of truth：** legacy Issue verification、`issue_runs`、P04 Evidence/verifier review、P05 Handoff
  projection 和现有 audit carrier 各自 authoritative；本 service 不持久化第二份 ledger。
- **窗口：** 本期双写/双读窗口均为 0。P05.08 接 API/repository 前只能由显式 Workflow 调用并持有返回值；
  不替换 `POST /api/issues/:id/verification`，不接 live runner loop。
- **未来接线：** 只能按 migration plan W1/W2 shadow/parity window 写入正式 Handoff stream，stable ID、cycle、
  Work/Run/Evidence links、action、findings 和 audit refs 必须与 legacy authority 可对账，不能双主。
- **回滚：** 删除本期 service/fixtures/ADR 即可；它没有数据迁移和 live writer。未来接线失败时停用 Workflow
  registration，恢复 legacy verification path，保留已写 Evidence/review/audit，不反写或删除旧结论。
- **最终删除门禁：** 仅 P11.03/P11.06 与 G7 完成、P05.08 repository/API 和 Repair/Review Workflows 全部映射、
  clean-baseline Golden Journey 通过、连续一个正式 release 无 legacy reviewer-loop producer/consumer，且完成
  budget exhaustion、audit replay、Evidence restore 和 rollback rehearsal 后，才能删除 compatibility path。

## 6. 验证

```bash
cd backend-ts
bun test src/domain/handoff/reviewerLoop.test.ts \
  src/domain/handoff/contracts.test.ts \
  src/domain/evidence/verifierReview.test.ts \
  src/domain/run/contracts.test.ts
bunx tsc --noEmit
```

Fixtures 固定覆盖 structured pass、human reject、多轮 request_changes 后接受、cycle budget、旧 Evidence 结论
防覆盖和 provider 决策不能自授权。
