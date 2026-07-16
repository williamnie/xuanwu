# ADR-XW-0052：Supervisor Planner 与 bounded Work 分解

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.05 / Runner #684
- 硬依赖：XW P06.03 / #682、P06.04 / #683、P02.03 / #649（均为 `done`）
- 可执行实现：`backend-ts/src/pi/supervisorWorkPlanner.ts`
- canonical fixture：`docs/fixtures/supervisor-planner/supervisor-planner-v1.json`
- canonical 级别：本文、`SUPERVISOR_WORK_PLAN_SCHEMA`、`planSupervisorWork()`、`validateSupervisorWorkPlan()` 与 `evaluateSupervisorPlanApproval()` 共同构成本阶段 Supervisor plan、分解边界、DAG、验收生成和 user approval precondition 的 source of truth

## 1. 决策

Planner 消费 P06.03 的单 turn `xw.supervisor-intent-route.v1`、P06.04 的
`xw.supervisor-context-resolution.v1`、自然语言 goal、显式 Workflow purpose → exact manifest ref 配置，以及
P06.07 Workflow Registry resolver，输出 closed `xw.supervisor-work-plan.v1`：

- `answer/query/work_control/approval` 生成 `no_work`，不为已有状态控制平行创建 Work；
- `investigate` 生成 `read_only`，可选择 exact Investigate Workflow，但 `works=[]`、无状态写；
- `execute/automation/release` 生成 `work_plan`，包含 project-bound Work、可选 objective/子 Work、parent 和 dependency edge、逐 Work acceptance contract、exact Workflow revision 与审批前置条件；
- route/context 要求澄清时返回 `needs_clarification`，mutating plan 没有 resolved project 或 exact Workflow Registry resolution 时不生成 Work mutation；
- Planner 只形成 proposal。`materialization.state_writes=not_executed` 与
  `approval_policy.materialization_permitted=false` 是固定值，模型输出或一份 plan 自身永远不能授予 writer 权限。

`recordSupervisorWorkPlanAudit()` 可把完整 bounded plan 记录成 append-only
`pi_action_events:supervisor_work_planned`。实际 runtime consumer 在展示、审批或 materialize plan 前必须调用它；审批和后续
Work/Run action 仍各自保留现有 proposal/action/domain audit，planner audit 不能替代 outcome audit。

## 2. Bounded decomposition 与 DAG

V1 是单次、非递归分解：

| 约束 | 固定值 | 行为 |
| --- | ---: | --- |
| 最大层级 | 1 | 只有 objective root 与直接 child；不会递归调用自己 |
| 最大 Work | 8 | 最多 1 root + 7 child |
| 最大 dependency edge | 16 | schema 与 semantic validator 双门禁 |
| 多步骤顺序 | 输入显式顺序 | child N 依赖 child N-1 |

Planner 只把编号/项目符号列表、`先/然后/最后`、`first/then/finally` 或分号表达的显式步骤当作分解依据；不会按代码、目录或模型猜测无限扩展。超过 7 个步骤时，保留前 6 个并把其余内容折叠为一个有界 remainder Work，`bounds.truncated=true`，原始/计划步骤数均进入 plan。

`validateSupervisorWorkPlan()` 在任何 writer 之前检查：closed schema、唯一 Work ID、project owner、parent 存在且深度递增、acceptance contract、Workflow ref 来自本 plan 的成功 Registry selection、dependency endpoint、重复/self edge，以及 parent/dependency 两张图分别无环。非法 candidate 不存在“尽量执行”分支。

## 3. Acceptance 与 Workflow 选择

每个 planned Work 直接复用 P02 `WorkAcceptanceContract`：

- `completion_rule=all_required`、`requires_handoff=true`、`version=1`；
- `requested-outcome` 把该 Work 的具体 goal 固定为 required criterion；
- `focused-verification` 要求范围相称、可重新读取的 passed Evidence；
- Release Work 额外要求 `release-audit`，覆盖确定性审批、外部目标、结果和 rollback fact；
- criterion 的 `verification_policy_ref` 只来自 Registry 已解析 manifest 的 exact stage refs，不由 prompt/LLM 自填。

Planner 不自动选择 latest，也不把缺失/非法 manifest 降级为 legacy template。purpose 必须映射到完整
`workflow:<id>@<revision>`；Registry 对 missing dependency、invalid override 或 unknown revision 的诊断会让 mutating plan
进入 `blocked` 且 `works=[]`。project override 只由 Registry 应用，并把 applied flag/audit ref 投影进 plan。

## 4. User approval policy

Planner 的确定性 policy 只判断额外的人类前置条件，不替代 Action Gate：

- 单个普通 triage Work proposal 不要求重复确认，但仍不能由 plan 直接写入；
- 多 Work 分解要求在 `plan_materialization` 前确认，防止一句含糊请求批量创建 Work；
- manifest `before_stage` 要求 stage execution 前确认；
- Release 或 manifest `before_external_write` 要求 external write 前确认；
- `blocked/needs_clarification/read_only/no_work` 不可 materialize。

`evaluateSupervisorPlanApproval()` 只接受 plan ID 完全匹配、带时间与 `audit_event_ref` 的 identified user approval。Supervisor、automation、system 自批，错 plan、拒绝或缺审计全部 deny。即使返回
`planner_precondition_satisfied=true`，`tool_permission_granted` 仍固定为 `false`；真实 mutation 继续经过 P06.06 tool permission、PI Action Gate、project/delegation scope、risk/approval repository、Work service optimistic revision 和 append-only outcome audit。

## 5. Authority、兼容、迁移与回滚

当前没有 authority cutover：

| 事实 | 当前 authority | Planner 行为 |
| --- | --- | --- |
| Work 状态与写入 | `issues` / `issue_events`，经 Issue-backed Work adapter | 只生成 proposal；不写 `works` shadow |
| Work acceptance 语义 | P02 Work contract/service | 复用 contract validator；不新增第二状态机 |
| 已冻结 Workflow | 现有 Issue snapshot / Work `workflow_ref` | 新 plan 只选择 exact Registry ref，不覆盖历史 Work |
| 结构关系 | 当前 PI carrier read projection；HTTP structural write 在 G4 前不可用 | parent/dependency 只保留在 plan，禁止偷写 shadow relation |
| 权限/审批 | PI Action Gate、approval repository、domain gate | Planner policy 只能收紧，不能授权 |

- **双写：0。** 本期不改 DB/schema/public HTTP、不写 Issue、Work shadow、relation、Run 或 Workflow snapshot。
- **双读：0。** Planner 输入由已解析 route/context 与显式 Registry resolver 给出，不同时读取 legacy/new plan 决定 winner。
- **W1 接入：** P06.08–P06.12 concrete Workflow/Skill Runtime consumer 可在同一个 Supervisor turn 中生成、审计并展示 plan；用户批准后只能经 `issues-via-work-adapter` materialize。结构 relation 必须等待 G4 carrier/authority 门禁，不得临时写第二套表。
- **回滚：** 停止调用/展示 `xw.supervisor-work-plan.v1`，恢复既有单 Issue proposal 路径；planner audit 保留，无数据回滚。
- **最终删除门禁：** 只有 concrete Workflow、runtime consumer、plan approval UI/API、Issue-backed materializer 与 relation carrier 完成映射，simple/multi-step/read-only/release、cycle/overflow/approval fail-closed 和 clean-baseline Golden Journey 连续通过，active Work frozen plan 可重放，legacy new-Work producer 连续一个正式 release 为零，且 P11/G7 批准后，才可删除 legacy planner/issue proposal compatibility。旧 Issue/plan audit 仍按 retention policy 保留。

## 6. 最小验证

```bash
cd backend-ts
bun test src/pi/supervisorWorkPlanner.test.ts
```

canonical fixtures 覆盖 simple、multi-step、read-only 与 release；测试同时覆盖 overflow 单次折叠、最大深度/Work 数、dependency 与 parent cycle 拒绝、Registry exact-ref fail closed、identified user approval 与 append-only plan audit。全部为 fake/provider-neutral contract verification，不依赖本机 Claude CLI、登录或 session。
