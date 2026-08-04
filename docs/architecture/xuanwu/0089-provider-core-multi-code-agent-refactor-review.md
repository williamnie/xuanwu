# 0089 Provider Core 多 Code Agent 重构方案 — 独立 Review 报告

- 被评审文档：`docs/architecture/xuanwu/0089-provider-core-multi-code-agent-refactor-plan.md`
- Review 类型：只读独立复核（reviewer 子代理）
- 结论：**有条件可行** — 方案对仓库现状描述高度准确，与既有 ADR 契约一致，阶段划分自洽；需补充少量前置条件与引用后可执行。

---

## 一、总体判断

方案整体结构（P0 现状 inventory → 统一 ProviderManifest → 契约收敛 → 解耦 → 多 Code Agent 接入）与仓库既有架构演进方向一致，未发现契约冲突、依赖循环或不可验证的验收标准；文档中引用的仓库文件均真实存在。主要缺口集中在**外部依赖调研门禁缺失**与**引用/覆盖遗漏**，属可修正项而非方向性问题。

## 二、已核验一致项（证据）

### 2.1 现状耦合描述全部属实
- 闭合联合 `EXECUTOR_PROVIDER_IDS = ["codex","claude","fake-execution-only"]`（`backend-ts/src/providers/types.ts:3`）
- `SessionCreateResult` 双暴露 `provider_session_id/thread_id`（`types.ts:134-141`）
- `SessionMessageResult.turn_id` 强制（`types.ts:152`）
- `readSession` 返回 `Record<string, unknown>`（`types.ts:163`）
- `runtime/core.ts:191-202` 手写 Codex/Claude 分支
- `sessionApi.ts:75,122,126,357` 内嵌 Codex 分支
- `systemStatus.ts:11-14` 手写 provider status
- 前端 `PROVIDER_OPTIONS`/`SESSION_CAPABLE_PROVIDERS` 存在（`frontend/src/pages/sessions/sessionOptions.js:25`、`frontend/src/utils/issueRuns.js:2`）

### 2.2 引用契约一致
- `invocation_ref/session_ref/turn_ref` 与 0020:125-127 一致
- `xw.run-event.v1` unknown/preserve 语义与 0022:11,40-48 一致
- intent → provider call → outcome 链路与 0069:18,41,53 一致
- session key `<provider>:<ref>` 格式在 `backend-ts/src/domain/run/service.ts:928`、`domain/run/contracts.ts:180`、`domain/work/timeline.ts:395` 等处一致（sessionApi 相关实现见 `backend-ts/src/http/sessionApi.ts`）

### 2.3 无隐藏 DB 前置障碍
- `run_attempts.provider` 仅非空 check（`db/schema/042_run_attempt_relations.ts:80`），`provider_turn_id` 允许空串，`projects/issue_runs` 无枚举约束 → P1「无 schema 变化」成立
- `/api/providers` 路由当前不存在，无冲突

### 2.4 DAG 传递闭包自洽
- P11←P10←P4/P5/P6 依赖链与 §18 文字描述一致

## 三、主要风险与问题（按严重度排序）

### 3.1【中】外部依赖假设未设前置门禁
P10/P11 的「不改 Core 即可接入」建立在 `pi --mode rpc`、SessionManager 及 Qoder SDK（`qodercliAuth()/resumeSessionAt/forkSession/canUseTool`）能力之上，仓库内不可验证。§17 第 1 步虽有调研意向，但 P10/P11 的交付清单与 DAG 中**没有显式「接口调研 gate」**；若实际能力不足，将冲击各自 `required` 验收项（§15.2/§16.2）。

### 3.2【中】引用缺漏
头部依赖清单未覆盖以下强相关文档：
- **0063-approval-action-gate**（§11.2 审批映射相关）
- **0073-secret-lifecycle-redaction**（P4「secret/redaction registry」相关）
- **0070-db-migration-rehearsal-gate**（§13/P12 删除门禁相关）
- **0059-provider-presets-connections**（拥有 PI model provider 连接合同，与 §3.2/§23 隔离声明直接相关）
- **0049-workflow-manifest-registry**（与 ProviderManifest 的命名关系未说明）

### 3.3【轻】现状描述小偏差
§2 称联合类型为 `codex/claude/fake`，仓库实际为 `fake-execution-only`（`types.ts:3`）。

### 3.4【轻】存量 UI 与 seed 迁移未覆盖
- `sessionOptions.js:25-31` 含 `opencode/kimicode` disabled 占位项，P6 验收「planned 未注册不作为 option」未说明其去留
- `db/schema/068_builtin_executor_profiles.ts:16-17` 仅 seed codex/claude 内置 profile，新 Provider 的 profile 策略未提及

### 3.5【轻】既有前后端 capability 漂移佐证
前端 `CAPABILITY_LABELS` 含 `transcript_export`（`sessionOptions.js`），后端 `ExecutorCapability` 无此项——印证 §8.3 drift 风险真实存在，建议 P0 inventory 阶段明确收录该差异。

## 四、修正与补充建议

1. **P10/P11 前增加显式调研工作项**：官方接口能力核实 + transport 定版，作为独立 gate 进入 DAG；允许 §15.2/§16.2 的 `required` 项按调研结果降级为 `capability-detected`。
2. **补齐引用**：头部依赖与 §11/§13/P4/P12 处补充 0059/0063/0070/0073/0049 的显式引用，并说明 ProviderManifest 与 0049 Workflow Manifest Registry 的命名边界。
3. **P6 补充迁移策略**：明确 `opencode/kimicode` 占位 option 的清理方式，以及 built-in executor profile 对新 Provider 的 seeding 策略。
4. **修正表述**：§2 联合类型改为 `fake-execution-only`。
5. **P0 inventory 收录 capability 漂移**：将前后端 capability 集合差异作为 drift 基线样例登记。

## 五、结论

方案方向正确、契约描述与仓库现状吻合，无阻断性不可行点。补齐上述中/轻级建议（尤其是外部依赖调研 gate）后即可按 DAG 执行。建议在方案定稿前由方案作者针对 3.1、3.2 两处做一轮修订。

---
*本报告由 reviewer 子代理只读产出，仅代表独立评审意见，不构成对方案的修改。*
