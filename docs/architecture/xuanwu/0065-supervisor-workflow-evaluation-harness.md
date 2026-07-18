# 0065 Supervisor 与 Workflow Evaluation Harness

## 决策

采用 `xw.supervisor-workflow-eval-suite.v1` 作为固定评测 case format，在
`docs/fixtures/evals/supervisor-workflow-eval-v1.json` 保存输入、golden outputs、离线 model variants、
token/cost 预算与 regression threshold。Harness 位于 `backend-ts/src/evals/`，它是**只读评测投影**，
不创建 Issue/Work/Run/Evidence，也不执行控制工具。

评测必须复用当前产品 authority：

- intent route：`routeSupervisorIntent()`；
- plan / Workflow selection：`planSupervisorWork()` + canonical Workflow Registry contributions；
- tool selection：以 `SUPERVISOR_CONTROL_TOOL_NAMES` 为允许集合，variant 选择不得越权；
- completion gate：`ISSUE_WORK_VERIFICATION_POLICY` + `evaluateWorkflowVerificationPolicy()`；
- report：`supervisorReportSummary()`；
- token cost：fixture 记录的 provider-neutral usage/cost，与 case 预算及 baseline regression 比较。

因此 LLM/recorded variant 只能提供 `selected_tools` 与 token usage 观测，不能改变 Workflow、权限或
完成门禁。工具选择命中 golden 也不等于获得执行权限，真实写操作仍必须经过既有 action/approval gate 和审计。

## Case、golden 与 scorer

每个 case 包含：

- `input`：固定 prompt、source、project，以及可选 completion/report fixture；
- `golden`：路由、计划、工具、完成状态、报告字段和 token/cost 上限；
- `observations`：每个 model variant 的工具选择与 token usage；
- `required_scorers`：从 `intent_route`、`work_plan`、`tool_selection`、`completion_gate`、`report`、
  `token_cost` 选择的确定性 scorer。

Suite 必须恰好有一个 baseline。所有 variant 必须覆盖全部 case；缺 observation、未知 variant、重复 id、
token 加总不一致均 fail closed。候选 variant 还必须满足整体分数、逐 scorer 分数、相对 baseline 分数退化和
token 增长阈值。

## 本地与 CI 报告

Harness 不调用真实外部服务，固定时间戳使结果可重跑。最小本地命令：

```bash
cd backend-ts
bun run src/evals/runSupervisorWorkflowEval.ts
```

CI 或需要归档时：

```bash
cd backend-ts
bun run src/evals/runSupervisorWorkflowEval.ts --output-dir "$RUNNER_TEMP/xw-evals" --json
```

命令同时生成 `supervisor-workflow-eval-report.json` 和 `.md`；threshold 通过返回 0，回归返回 1。
CI 应把该命令作为独立 `commandExecution`，使 Runner completion gate 能识别直接测试证据。仓库根 CI
配置不在本 issue 范围内，因此本变更提供可直接接入的非交互命令，不修改 `.github/workflows`。

## Authority、兼容与迁移

- source of truth：Issue/Work、Run、Evidence、Workflow Registry 与 PI report authority 均保持不变；fixture
  只保存评测输入和 golden，不是运行态状态源。
- 双写：0；Harness 不写产品表或事件。
- 双读：0；没有旧 evaluator 兼容读取窗口，也没有第二套 router/planner/gate/report 实现。
- model variants 是 provider-neutral recorded observations；替换模型只需增加 observation 并重新跑 threshold，
  不改变公共 schema、状态机或 provider adapter。

## 回滚与最终删除门禁

回滚时删除 `backend-ts/src/evals/`、本 fixture 与本文即可；产品运行链无迁移、无数据恢复动作。

最终删除门禁：仅当后续 evaluator 已能复用同一 runtime authority、覆盖六类 scorer、提供固定 golden、
model regression 与 token/cost threshold，并能输出等价 JSON/Markdown 非交互报告后，才可删除本 Harness。
