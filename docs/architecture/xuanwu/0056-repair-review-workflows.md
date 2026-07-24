# ADR-XW-0056：Repair 与 Review Workflows

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.10 / Runner #689
- 硬依赖：XW P06.07 / #686、P04.08 / #670、P05.07 / #678（均为 `done`）
- 可执行合同：`backend-ts/src/workflows/repair.ts`、`backend-ts/src/workflows/review.ts`
- canonical manifests：`docs/fixtures/workflows/repair-workflow-v1.json`、`review-workflow-v1.json`

## 1. 决策与边界

注册 exact `workflow:repair@1` 与 `workflow:review@1`。Repair 固定
`diagnose → recovery-budget → recover → verify → handoff-replan`；Review 固定
`scope → inspect → decide → handoff-replan`。Registry 继续冻结 exact revision、工具/动作上限、verification policy
和 project override；缺少任何依赖时整份 revision fail closed。

本期只增加 concrete manifests、deterministic projection 和 focused fixtures，不新增 DB、HTTP API、公共 schema、共享
Work/Run/Handoff 状态机或 provider adapter。P06.12 runtime 尚未接管 stage execution；projection 是现有 authority 的
可验证派生结果，不是第二份 ledger。

## 2. Repair：诊断、预算、恢复和 handoff/replan

Repair 直接复用 `backend-ts/src/pi/recoveryDiagnosis.ts`、`recoveryBudget.ts`，并消费 PI 已选择的
`action_candidate`：

1. trusted P04 Evidence 必须证明 deterministic `diagnosis_code`；Agent/LLM prose 不能自行把 permanent failure 改成
   transient。
2. `PiRecoveryBudgetDecision` 是 recovery budget source of truth。`allow` 时 PI 可选择
   `issue.retry | issue.retry_after | session.resume_followup`，但候选必须携带与该动作完全匹配的 gate authorization；确定性代码不从错误文本替 PI 选择动作。
3. permanent failure（现有 `needs_context | unsafe` 等 deterministic 分类）以及 issue/session/project budget exhaustion
   必须停止自动恢复，产生 `needs_user.escalate` 与 audited `handoff-replan`。
4. transient recovery 完成必须有独立 action outcome audit 和 fresh、trusted、passed Evidence，且
   `decisive_output.facts.outcome=passed`；诊断 Evidence 不得复用为恢复验证。
5. action candidate 的 `authorizedActions` 必须包含 PI 当前选择的 exact action；LLM 输出、manifest 文本或 projection 都不能替代 Guardian/action gate，也不存在“取第一个推荐动作”的 fallback。

`xw.repair-workflow-projection.v1` 仅引用 diagnosis Evidence、budget snapshot、existing recovery candidate、action audit 和
handoff/replan ref。真正 Attempt、recovery attempt、Work/Run 状态仍写现有 repository；投影不得重置预算或覆盖旧失败。

## 3. Review：只读审查、findings 与修改回路

`scope` 和 `inspect` 的 tool permission 固定为 `read`，`allowed_actions=[]`；Review 不得修改 workspace。`decide` 和
`handoff-replan` 只声明 reviewer orchestration 的状态写上限，实际仍必须调用
`backend-ts/src/domain/handoff/reviewerLoop.ts`，不能复制另一套修改回路：

- automated review 继续消费 P04.08 structured findings；human review 继续要求 authenticated human approval；
- `accept` 必须全为 pass finding，并产生 approved P05 Handoff projection；
- `request_changes` 由 Reviewer Loop 在 cycle budget 内创建新 Repair Run、新 Handoff identity 和 fresh Evidence，旧
  Evidence/findings append-only；re-review 必须消费 fresh Evidence；
- final `request_changes` budget exhaustion 不得再创建 Run，projection 只生成显式 Repair replan 建议；
- `reject` 同样要求 replan，但不发明共享 Handoff 状态或直接把 Work 写成 failed。

`xw.review-workflow-projection.v1` 从 `ReviewerLoopResult` 校验 cycle、findings、Evidence history、repair relations 和 final
Handoff 后派生。P05.07 Reviewer Loop 仍是 request_changes/repair/re-review 编排 authority。

## 4. Evidence、Handoff 与审计 authority

- **Workflow authority：** P06.07 Registry 与两个 canonical manifests 决定 exact revision、stage、权限和 policy 上限。
- **故障与预算 authority：** Guardian deterministic diagnosis、`pi_recovery_attempts` 和 `recoveryBudget.ts`；projection
  不读取 `issues.attempt_count` 伪造预算。
- **验证 authority：** tool/runtime observation 与 P04 Evidence；Agent claim 不得满足 gate。
- **审查 authority：** P04.08 structured verifier review、authenticated human decision 与 P05.07 Reviewer Loop gate。
- **交付 authority：** P05 Handoff 以及现有 Work/Run/relation repositories；projection 只引用 ID、audit 和 append-only
  findings/Evidence history。

所有状态变更都必须保留 intent/outcome、actor、correlation、policy、gate decision 与 audit ref。未来 external write 或
destructive action 必须另行扩 manifest revision 并经过显式权限/审批；本 V1 不 push、不建 PR、不 deploy、不操作真实外部系统。

## 5. 兼容、迁移与回滚

- **W0（本期）：** manifests、projection validator 与 fixtures 可被 Registry/focused tests 执行；legacy
  Issue/Session/Guardian/PI、P04 Evidence、P05 Handoff/Reviewer Loop 继续独占写 authority。双写：0，双读：0。
- **W1（P06.12）：** 新 Run 冻结 manifest revision，通过 adapter 调用现有 recovery/Reviewer Loop service，并将 stage
  audit/Evidence 追加到现有载体；legacy worker 与 workflow runtime 不得同时写同一 Run。
- **W2（最多两个正式 release window）：** 只做 legacy/V1 coverage 与 replay parity；winner 由 frozen manifest、现有
  repository 和 audit 决定，不能按 summary 或时间猜测。
- **回滚：** 停止 Registry selector 提供 `workflow:repair@1` / `workflow:review@1`，恢复 legacy 调度；保留已产生的
  recovery attempt、Run、Evidence、findings、Handoff 与 audit，不反写、不删除、不重置预算。
- **最终删除门禁：** 仅 P06.12 runtime、P05.08 repository/API、P10 evaluation 和 clean-baseline Golden Journey 全部
  通过；transient/permanent、issue/session/project budget exhaustion、pass/request_changes/reject、fresh Evidence、audit
  replay、rollback rehearsal 均覆盖；连续一个正式 release 无 legacy new-run producer/consumer；并经 P11/G7 批准后，
  才能删除 legacy Repair/Review adapter。

## 6. 最小验证

```bash
cd backend-ts
bun test src/workflows/repairReview.test.ts \
  src/workflows/registry.test.ts \
  src/pi/recoveryDiagnosis.test.ts \
  src/pi/recoveryBudget.test.ts \
  src/domain/handoff/reviewerLoop.test.ts \
  src/domain/evidence/verifierReview.test.ts
```

覆盖 two-manifest Registry、read-only inspect、action fail closed、transient/permanent failure、issue recovery budget
exhaustion、fresh recovery Evidence、review pass、request_changes + Repair Run、review cycle budget、findings/Evidence/Handoff
projection 和 replan。
