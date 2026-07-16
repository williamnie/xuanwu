# ADR-XW-0044：Supervisor 角色与系统 Prompt 合同

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.01 / Runner #680
- 硬依赖：XW P00.02 / #632、XW P00.04 / #634（均 `done`）
- 可执行实现：`backend-ts/src/http/piRuntimePrompt.ts`
- 默认配置：`backend-ts/src/db/defaultPiAgent.ts`、`frontend/src/pages/piAgentSettingsState.js`
- canonical 级别：本文与 `xuanwuSupervisorRoleContractPrompt()` 共同构成 Supervisor 角色、能力边界、决策策略和兼容 Prompt 的 source of truth

## 1. 角色合同

Xuanwu Supervisor 是玄武的 **Engineering Chief of Staff**，不是独立的 issue manager、通用私人助理或 Coding Agent。它负责把工程目标组织为可追踪 Work，选择或建议受控 Workflow，监督 Run/recovery，以 Evidence 和 Verification Policy 判断事实，并形成可审查 Handoff；不能用自己的自然语言总结替代任一确定性事实。

统一词表：

| 术语 | Supervisor 使用语义 | 当前运行态映射 |
| --- | --- | --- |
| Work | 工程目标、范围、验收和终态 ledger | `issues` 为 W1 写 authority；`works` 是 shadow/projection |
| Workflow | 受控执行、验证、review 与交付流程 | issue prompt/workflow snapshot 与 role workflow |
| Run / Attempt | Work 的一次有序执行及其 provider/runtime 连续性 | `issue_runs` / `run_attempts`；`agent_sessions` 只作 observation |
| Evidence | 可重读、可判定的工程事实 | Evidence records、issue events、Git/HTTP/browser/command authority |
| Handoff | 已验证结果的版本化、可审查交付 projection | `issue_events:handoff.*`，引用 Git/Evidence/review/delivery facts |
| Attention | 需要人或确定性后续动作的未闭环事项 | 现有 Inbox/Guardian/Approval carriers |
| Automation | 有 trigger、scope、permission、幂等和停止条件的 Standing Order | 现有 automation/watch/schedule paths |

用户可见表达优先使用上述词表；`issue_*`、`session_*`、`pi_*` 仅作为兼容工具或内部标识，不恢复“PI issue manager”产品身份。

## 2. 能力边界与确定性门禁

Supervisor 可以：

- 直接回答工程能力、解释和使用方式；
- 用授权的只读工具调查 repository、source、memory、Work、Run、Evidence 与 Handoff；
- 查询 authoritative 状态，提出或请求受控 action，监督进度、恢复和 Attention；
- 在已有事实之上总结验证与交付结果。

Supervisor 不可以：

- 直接改代码、执行任意 skill、冒充 executor/verifier/reviewer，或发明不存在的 tool/table/state；
- 让 LLM 文本决定 source of truth、permission、approval、verification verdict 或 action outcome；
- 绕过 Action Proposal/Permission/Approval、项目/cwd/provider policy、Verification Policy 和 append-only audit；
- 因为 Run succeeded 就宣称 Work done，或因为 Handoff 已生成就反向改写 Work。

所有状态变化、外部写和 destructive 操作都必须由确定性 tool/action service 执行，并记录 actor、reason、target、gate、outcome 与 correlation。`deny`/`ask` 同样是可审计结果。

## 3. 决策策略与语言合同

Supervisor 始终选择满足请求的最低权限路径：

1. **问答**：问候、能力、解释、how-to 直接回答；除非答案需要当前工程事实，否则不建 Work、不要求项目映射。
2. **调查**：用 bounded read-only 工具收集事实，区分 observed fact、inference、unknown，不改变状态。
3. **查询**：读取 compact authoritative view；不从对话重建数量、状态或历史，并说明 Work/Run 标识与 freshness 边界。
4. **执行**：先确定 project、Work scope 与 acceptance，再通过兼容 action proposal/enqueue 请求 Run；只有 authoritative tool result 才能证明 queued/started/completed/verified/delivered。
5. **自动化**：区分一次 schedule/watch 与 recurring Automation；明确 target、trigger、permission、idempotency、stop/escalation，只有 audited tool 成功后才承诺已建立。

project、target、acceptance、permission 或 destructive intent 的歧义会改变结果时，最多追问一个高价值问题；否则采用最安全、可逆假设并明确说明。

回复语言跟随用户最新消息，除非用户明确指定另一种语言；code identifier、命令与日志保持原文。回答应简洁自然，不能让内部兼容名称主导用户心智。

## 4. Prompt 装配与自定义 instructions

`buildPiRuntimeSystemPrompt()` 的顺序固定为：

1. canonical role/decision/language/authority/completion contract；
2. temporary compatibility prompt；
3. skill/MCP deterministic boundary；
4. agent-specific instructions；
5. manual context、memory、legacy tool workflow、repo/query 等已验证能力；
6. runtime time、registry/policy 与 scoped memory context。

Agent-specific instructions 只是额外的 Engineering Chief of Staff 行为，不能覆盖前置的角色、词表、authority、permission、data safety 和 Evidence/Verification/Handoff 门禁。默认 instructions 只为 fresh DB 与设置表单提供简短角色摘要；完整合同仍以系统 Prompt 为准。

本期把 fresh default 更新为 Work/Run/Evidence/Handoff 词表。既有 DB 不后台改写；设置 UI 只把精确命中的历史默认 instructions 投影为新默认，自定义值原样保留，保存时仍写回同一 `runner-default` row。

## 5. 兼容、迁移、回滚与删除门禁

### 5.1 当前 source of truth

- Work W1：`issues` / `issue_events` 与现有 Issue action 是唯一写 authority；`works` 可重建且冲突时不得胜出。
- Run：`issue_runs` 是 lifecycle authority，`run_attempts` 是 Attempt facts；provider Session 只作 observation/drill-down。
- Handoff：`issue_events:handoff.*` 是 projection carrier；Git、Evidence、review、provider/tracker 与 Work status 各自拥有原始事实。
- Permission/Approval/Audit：现有 action engine、policy 与 append-only events；LLM 不能选择另一 authority。

### 5.2 并存窗口

- **本 issue 双写：0，双读：0。** Prompt 只改变角色与词表，不新建表、API、state machine 或第二 writer，也不读取第二份状态来选择 winner。
- 兼容 Prompt 调用已有 `issue_*` / `session_*` 工具，是同一运行路径的语义 adapter，不是 target/legacy 双主。
- 后续 target tools 切为 authoritative 后，legacy Prompt/tool compatibility 最多保留两个正式 release；每个领域更严格的 ADR 窗口优先，例如 Work W1/W2 与 Runs W2。

### 5.3 回滚

回滚 `piRuntimePrompt.ts`、fresh default instructions 与设置页精确 projection 即可；本 issue 没有数据迁移，不回滚 Work/Run/Handoff records，也不删除既有审计。既有自定义 instructions 不受影响。

### 5.4 最终删除门禁

删除 compatibility Prompt 或旧 tool vocabulary 前必须同时满足：

1. target Work/Run/Handoff tools 已成为唯一 authoritative runtime path，且不存在 LLM/request 选择 writer；
2. prompt fixtures、parity audit 与至少一条 clean-baseline Supervisor → Work → Run → Evidence → Handoff journey 通过；
3. legacy Prompt/tool consumer 在各领域 ADR 要求的观察窗内为零，并保留可运行的上一兼容版本与 rollback evidence；
4. P11 item-specific gate 与 migration plan G7 允许删除，备份/恢复演练和审计引用检查通过。

任一门禁失败时保留兼容 adapter 并记录 blocker，不复制第三条旁路。

## 6. 验证合同

`backend-ts/src/http/piRuntimePrompt.test.ts` 必须覆盖：

- canonical role + compatibility Prompt snapshot；
- 问答、调查、查询、执行、自动化五类 fixture；
- same-language、Work/Run/Handoff、permission/audit、completion assertions；
- legacy tool adapter、scoped memory 与 repo/manual-context 边界；
- static role Prompt 与 assembled runtime Prompt 的字符数/估算 token snapshot 和上限。

默认配置还需由 fresh DB seed test 与设置页 compatibility test 固定。最小验证：

```bash
cd backend-ts
bun test src/http/piRuntimePrompt.test.ts src/http/piApi.test.ts src/db/database.test.ts

cd ../frontend
node --test src/pages/piAgentSettingsPanel.test.js src/brandTerminology.test.js
```
