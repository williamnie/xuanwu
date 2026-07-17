# ADR-XW-0055：Implement 工程执行 Workflow

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.09 / Runner #688
- 硬依赖：XW P06.07 / #686、P04.07 / #669、P05.03 / #674（均为 `done`）
- 可执行合同：`backend-ts/src/workflows/implement.ts`
- canonical fixtures：`docs/fixtures/workflows/implement-workflow-v1.json`、`implement-run-fixtures-v1.json`

## 1. 决策与边界

注册 exact `workflow:implement@1`，把工程修改固定为
`confirm-target → modify → focused-verify → regression → handoff → completed`。Supervisor 只能选择 Registry
已验证的 exact revision；缺少 tool、action、verification policy 或 project override 扩权时整份 revision fail closed。

本期复用 Issue-backed Work、现有 Run/Agent Session、P04 Evidence/完成门禁和 P05 Handoff，不新增 DB、HTTP API、
provider adapter、公共 schema 或共享状态机。`xw.implement-workflow-run.v1` 是 P06.12 runtime 可消费的 closed completion
receipt，不是第二套 Work/Run/Handoff authority，也不能由 LLM prose 直接构造通过。

## 2. 阶段、转换与重做

| stage | 进入/完成条件 | 允许下一步 |
| --- | --- | --- |
| `confirm-target` | trusted human Evidence 固定 goal 与 acceptance criteria | passed → `modify` |
| `modify` | 已确认目标；写入操作有 allow gate、intent/outcome audit 和 conflict-free Git Evidence | passed → `focused-verify` |
| `focused-verify` | 独立的 passed command-style Evidence | passed → `regression`；failed → `modify` |
| `regression` | 与 focused 不同的 passed command-style Evidence | passed → `handoff`；failed → `modify` |
| `handoff` | P05 Handoff 合同有效，且 P04 verification 重新计算为 passed | passed → `completed` |

`blocked` 没有自动转换；跳阶段、`ask/deny` gate、修改未审计、verification `pending/failed/overridden/invalid`、
Handoff `draft/superseded` 都不得进入 `completed`。Receipt 只描述已完成的 canonical forward path；runtime 的失败/重做
仍写入现有 Run/Attempt 和 append-only audit，修复后产生新的阶段尝试，不覆盖旧 Evidence。

## 3. Verification policy 与 Evidence 绑定

三个 P04 policy 分别约束阶段事实：

1. `verification-policy:implement-target-confirmation@1`：要求 work-scoped trusted human Evidence，
   `decision=target_confirmed`；Agent claim 不可替代。
2. `verification-policy:implement-change-snapshot@1`：要求 current Run 的 Git Evidence，`changed_path_count` 非零且
   `conflict_count=0`；Git repository 仍是 changed-files/revision source of truth。
3. `verification-policy:implement-command-verification@1`：要求 current Run 的 passed
   `test|lint|build|http|browser` Evidence，且 `outcome=passed`。

Receipt validator 分别用 focused 与 regression 的 Evidence 子集重跑同一 command policy，并强制两个集合不相交；因此单条
命令不能同时冒充定向验证和回归。最终 Handoff 必须关联 confirmation、Git、focused、regression 全部 Evidence。验证失败
不得交付，manual override 也不被本 Workflow completion receipt 接受；P04.07 仍负责真实 Work `done` mutation 与
`issue.verification_gate_intent/outcome` 审计。

## 4. 修改、权限和 Handoff mode

- `modify` 只有在 `approval-policy:implement-target-confirmed@1` 的 `before_stage` gate 后执行；workspace change、可选
  Work projection update 都要记录 operation、target、before/after、rollback ref 和 audit ref。
- `handoff` V1 只支持 P05.03 已具备迁移路径的 `local_changes` 与 `branch_commit`。默认是 `branch_commit`；project
  override 只能切到 `local_changes`，不能扩大到 push/PR/deploy/release。
- `branch_commit` 必须复用 P05.03 隔离 index、scoped staging、commit-tree、CAS ref update 和 rollback audit；
  `local_changes` 不得虚构 commit operation。
- 两种 mode 都禁止 external write/destructive delivery action。本期不会 push、建 PR、deploy、release 或写真实外部系统；
  后续 mode 必须依赖对应 P05 producer，并经过 human approval/确定性 action gate 后另行扩 revision。

所有状态变更、Git ref 写入和未来 external/destructive 操作必须保留 intent/outcome、actor、policy、gate decision 与
rollback provenance。LLM 只能提出目标、命令和摘要，不能改写 tool result、Evidence status 或 gate decision。

## 5. Authority、兼容、迁移与回滚

- **Workflow authority**：P06.07 Registry + `IMPLEMENT_WORKFLOW_MANIFEST` 决定 exact revision、阶段、权限上限、policy
  与允许的 Handoff mode。
- **Work/Run authority**：Issue-backed Work、Run/Attempt 与现有 repository/service 保持唯一写 authority；receipt 只投影。
- **验证 authority**：真实 tool/runtime observation 和 P04 Evidence 是 source of truth；receipt validator 重算 policy，
  不信任 `decision` 文本。
- **交付 authority**：P05 Handoff 是 delivery、review、risk、rollback 和 revision 的 source of truth；receipt 只引用它。

迁移窗口：

- **W0（本期）**：新增 concrete manifest、stage transition evaluator、completion receipt validator 与 fixtures；
  Supervisor 可选择 exact workflow，P06.12 尚未接管 stage execution。双写：0，双读：0。
- **W1（P06.12）**：新 Implement Run 冻结 manifest revision，按 stage 追加 audit/Evidence，并在完成前验证 receipt；legacy
  provider 继续执行文件/命令，但不得与 workflow runtime 同时写同一 Run。
- **W2（最多两个正式 release window）**：只展示 legacy/V1 coverage；每个 Run 按冻结 authority 回放，不根据 summary 猜 winner。
- **回滚**：停止 selector 提供 `workflow:implement@1`，恢复 legacy Issue/Session 执行链；保留已产生的 Run、Evidence、Git
  commit/ref audit 和 Handoff，不反写、不删除。若 branch commit outcome audit 失败，继续使用 P05.03 CAS rollback。
- **最终删除门禁**：只有 P06.12 runtime、P04.07 completion gate、P05.03 两种 local Handoff journey、失败重做、脏工作树
  隔离和 P10 evaluation 全部通过；active Run 可按 frozen manifest/Evidence 重放；连续一个正式 release 无 legacy new-run
  producer；并经 P11/G7 批准后，才可删除 legacy Implement adapter。

## 6. 最小验证

```bash
cd backend-ts
bun test src/workflows/implement.test.ts src/workflows/registry.test.ts src/domain/evidence/policy.test.ts src/domain/handoff/localBranchCommit.test.ts
```

验证覆盖 Registry/Planner exact selection、action/tool fail closed、canonical stage 边、verification failure/rework、
focused/regression Evidence 隔离、`local_changes`/`branch_commit` fixtures，以及真实临时 Git project 的 scoped branch commit E2E。
