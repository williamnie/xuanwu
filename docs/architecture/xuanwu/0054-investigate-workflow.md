# ADR-XW-0054：Investigate 只读调查 Workflow

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.08 / Runner #687
- 硬依赖：XW P06.07 / #686、P04.02 / #664（均为 `done`）
- 可执行合同：`backend-ts/src/workflows/investigate.ts`
- canonical fixtures：`docs/fixtures/workflows/investigate-workflow-v1.json`、`investigate-handoff-fixtures-v1.json`

## 1. 决策与边界

注册 exact `workflow:investigate@1`，把调查固定为 `scope → reproduce → root-cause → report` 四个阶段。每个阶段的 `max_tool_permission=read`、`allowed_actions=[]`、`approval.mode=none`，且 Registry 必须用真实 tool catalog 证明 allowlist 中每个工具仍是 `read`；任一工具缺失或被提升为 `write/dangerous` 时整份 revision fail closed。LLM 输出、project override 或报告文本都不能增加 action、工具权限或重试次数。

本 Workflow 只允许读取已授权的 Work/Run/Evidence/Handoff/Issue/Session、仓库、HTTP 和 browser snapshot surface。它不得改代码、Issue/Work/Run 状态、project config、数据库、外部系统或 destructive target；P06.12 runtime 在执行 stage 前后仍必须经过既有 tool registry、read-only invocation 和 append-only tool-call audit。本期不增加 DB、HTTP API、provider adapter、共享状态机或 shell writer。

## 2. 阶段与结果

| stage | 目标 | 终态 |
| --- | --- | --- |
| `scope` | 固定目标、baseline、可读数据与边界 | 必须 `completed` |
| `reproduce` | 在不 mutation 的条件下执行有界复现或证明缺少输入 | `completed` 或信息不足时 `blocked` |
| `root-cause` | 沿 Evidence/source path 收敛 confirmed、hypothesis 或 unknown | `completed` / `inconclusive` / `blocked` |
| `report` | 生成可交接结论、Evidence 链、风险、缺口和下一步 | 必须 `completed` |

报告 outcome 只有 `confirmed`、`not_reproduced`、`insufficient_information`：

- `confirmed` 必须同时具有 reproduced observation、confirmed root cause 和完成的复现/根因阶段；
- `not_reproduced` 必须记录已完成的复现尝试，禁止宣称 confirmed root cause；
- `insufficient_information` 必须把 reproduction 标为同名状态、root cause 标为 unknown，并明确阻塞复现/根因的缺失输入。

三类 fixture 都包含真实 P04 Evidence V1 结构、stage Evidence link、tool audit ref 和下一步，而不是仅用 Agent narrative 表示“调查过”。

## 3. Read-only policy 与 Evidence

`workflow-policy:investigate-read-only@1` 由三层确定性约束组成：

1. Manifest 层：所有 stage 只能解析到 `read` tools，action allowlist 永远为空；project override 只能继续收紧。
2. Evidence 层：`verification-policy:investigate-read-only@1` 至少要求一条 work-scoped、passed、trusted `shell|test|http|browser` observation；事实继续由 P04 collector/verifier 与真实 tool result 决定，报告不能自造 passed Evidence。
3. Report 层：`read_only_audit` 必须带 audit refs，并固定 `allowed_actions=[]`、`changed_files=[]`、`state_mutations=[]`、`external_writes=[]`、`destructive_operations=[]`。closed schema 会拒绝任何非空写集合；validator 还校验 stage 顺序、outcome 一致性、Evidence/Work 归属与至少一条可过门禁的 trusted Evidence。

命令 Evidence 只消费 P04.02 已观察到的 command completion；本 Workflow 不把命令文本里的 “passed” 当事实，也不自行执行 shell。复现到 bug 时，failed observation 可以作为附加调查 Evidence，但 report 完成仍要有一条 passed trusted observation，证明有界调查步骤本身已被 Runner 观察并完成。

## 4. Handoff 与 authority

- **Workflow authority**：P06.07 Registry + `INVESTIGATE_WORKFLOW_MANIFEST` 决定 exact revision、阶段、权限上限和 policy ref。
- **调查事实 authority**：真实运行行为与 P04 Evidence 是 source of truth；report 只做 bounded projection，不覆盖 Evidence status/provenance。
- **状态 authority**：现有 Issue-backed Work、Run 和各自 append-only events 不变；Investigate plan 的 `materialization.mode=none`，不产生 Work mutation。
- **交接 authority**：P05 Handoff 仍拥有正式交付状态与 Evidence linkage。`xw.investigate-handoff-report.v1` 是其只读调查报告输入/附件合同，不创建第二套 Handoff 状态机。

Manifest V1 目前只能选择既有 delivery mode，因此沿用 `local_changes` 作为 P05 adapter carrier；对 Investigate 它不表示允许文件修改。adapter 必须保持 `changed_files=[]`、无 delivery action，并把报告作为 Evidence/report artifact 关联。任何非空 changed-files 或 delivery action 都应由 report/read-only gate 拒绝，而不能升级为 Implement。

## 5. 兼容、迁移与回滚

- **W0（本期）**：新增 concrete manifest、policy、report validator 与 fixtures；Supervisor 可通过 exact ref 选择 read-only Workflow，但 P06.12 runtime 尚未接管 stage execution。双写：0，双读：0。
- **W1（P06.12）**：新 Investigate turn 显式选择并冻结 `workflow:investigate@1`，复用现有 read-only tool invocation、P04 Evidence 和 P05 Handoff adapter；legacy 调查路径不与同一个 Work 竞争 authority。
- **W2（最多两个正式 release window）**：只展示 legacy/V1 coverage；每个 Work/turn 按其 frozen authority 重放，不根据新旧报告猜 winner。
- **回滚**：停止 selector 提供 `workflow:investigate@1`，恢复 legacy read-only investigation/report path；已产生的 Evidence、tool audit 和 report artifact 继续保留，不反写、不删除，也不转换成代码修改 Work。
- **最终删除门禁**：只有 P06.12 runtime、P10 evaluation 与 clean-baseline confirmed/not-reproduced/insufficient-information journeys 全部通过，active investigation 可按 frozen manifest/Evidence 重放，连续一个正式 release 没有 legacy new-investigation producer，权限冲突/future revision/invalid report 都稳定 fail closed，并经 P11/G7 批准后，才可删除 legacy Investigate adapter。

## 6. 最小验证

```bash
cd backend-ts
bun test src/workflows/investigate.test.ts src/workflows/registry.test.ts src/pi/supervisorWorkPlanner.test.ts src/domain/evidence/policy.test.ts src/domain/evidence/commandCollector.test.ts
```

验证覆盖 exact Registry/Planner 选择、四阶段顺序、真实 tool catalog 的只读权限、write-permission fail closed、三类报告/Evidence fixtures、非空写集合拒绝，以及 authority/迁移/回滚/删除门禁。
