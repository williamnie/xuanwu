# ADR-XW-0046：Supervisor Intent Router

> **状态：Superseded by ADR-XW-0085。** 逐 turn 的自然语言 intent router 已从运行链删除；本文仅保留历史决策背景，不再描述当前实现。

- 状态：Superseded
- 日期：2026-07-17
- 路线 issue：XW P06.03 / Runner #682
- 硬依赖：XW P06.01 / #680（`done`）
- 可执行实现：`backend-ts/src/pi/supervisorIntentRouter.ts`
- Runtime 接入：`backend-ts/src/http/piConversationApi.ts`、`backend-ts/src/http/piRuntimePrompt.ts`
- canonical 级别：本文、`SUPERVISOR_INTENT_ROUTE_SCHEMA` 与 `routeSupervisorIntent()` 共同构成本阶段逐 turn intent route、source trust、低置信 fail-closed 和 routing audit 的 source of truth

## 1. 决策

每条 PI conversation user turn 在创建 Supervisor runtime 前先生成 `xw.supervisor-intent-route.v1`。Router 识别并保留以下互不排斥的意图：

- `answer`：问答、能力与 how-to；
- `investigate`：有边界的调查、诊断和根因分析；
- `execute`：要求产生工程变更；
- `work_control`：已有 Work/Run 的开始、恢复、重试、暂停、取消或终态控制；
- `automation`：schedule、watch、周期 Standing Order 与通知；
- `approval`：批准、拒绝或确认受控动作；
- `release`：deploy、publish、TestFlight、上线或发版；
- `query`：authoritative 状态、数量、进度与历史纯查询。

Route schema 固定包含 primary intent、按首个明确 signal 排序的 multi-intent、逐 intent/整体 confidence、source trust、ask-one-question、write policy 和不含原文的 input audit 摘要。多意图不会被压成一个 issue-manager 分支；例如“先调查，再修复并发布”保留 `investigate → execute → release`，由 Supervisor 在同一受控路径中编排。

本阶段 Router 是 deterministic language/safety router，不是第二个 planner、action engine 或业务 state machine。它只决定 turn 的最低权限形状并向同一个 PI SDK `AgentSession` 注入紧凑 route projection；P06.04 继续负责 project/Work/conversation context resolution，P06.05 继续负责 planner 与 Work 分解。

## 2. confidence、ask-one-question 与低置信写保护

`execute`、`work_control`、`automation`、`approval`、`release` 是 mutating intent。只有每个已识别 mutating intent 在 source trust 折减后均达到 `0.72`，且输入没有 prompt-injection/permission-override 形状时，route 才给出 `decision=controlled_action` 与 `allow_mutation=true`。

这并不直接授权写操作：它只允许后续既有 Action Proposal/Permission/Approval gate 继续判断。任何 project scope、action allowlist、risk、approval 或 destructive gate 仍可 `ask`/`deny`。

含糊请求如“处理一下”或 `Handle it` 会得到 `decision=ask_one_question`，并按用户语言生成一个且仅一个高价值问题。该 turn 的 runtime authorization 被确定性缩到 `PI_READ_ONLY_ACTION_TYPES`，PI SDK pre-tool hook 还会按 tool registry 的 `permission=read|write` 做第二次 fail-closed 检查；即使 LLM 仍尝试调用 `issue_create_proposal`、`manual_context_intake` 等写工具，也只会留下 `tool_call_audit status=denied`，不能进入 action handler、创建 Work、启动 Run 或改变状态。问答、调查和纯查询同样默认只得到 read-only authority。

## 3. source trust 与恶意输入

Transport 身份不等于内容 authority：

- local `runner_chat` / `runner_review` 为 `trusted_direct`，但文本仍不能授予权限；
- Feishu 等 authenticated conversation transport 为 `contextual`，confidence 轻度折减；
- unknown/indirect source 进一步折减；
- 要求忽略 system/developer rules、绕过 permission/approval 或无确认直接 destructive action 的 prompt-like 内容降为 `untrusted`。

`prompt_is_authority` 永远为 `false`。Source trust 只能降低 confidence/authority，不能提高 Action Gate 权限。How-to、状态查询和明确否定（如“不要发布，只告诉我状态”）会抑制附近的 mutating signal，避免把说明或查询误路由为执行。

## 4. routing audit

每次 route 在调用 runtime 前写入 append-only `pi_action_events`：

- `event_type=supervisor_intent_routed`；
- `actor=supervisor_intent_router`；
- `action_id=intent-route:<turn-id>`；
- `decision/reason` 保存 route 决策与 write-policy 原因；
- payload 保存完整 schema route，但只记录 prompt 字符数、16 字符 hex digest、signal IDs、可信的 `review` hint 与 injection flag，不保存 user prompt 原文。

SDK/tool runtime 的 `runtime_tool_registry_snapshot`、`tool_call_audit` 与 `pi_actions` gate/execution events 继续记录实际工具和状态结果。Intent audit 只能解释“为什么允许进入某类路径”，不能替代 action outcome 或证明 Work/Run 完成。

## 5. 兼容、迁移、回滚与删除门禁

- **状态 authority 不变**：Work/Run/Evidence/Handoff 与 permission/approval 仍由既有 SQLite repository、service 和 Action Gate 拥有。Router route 是 turn-local policy input；LLM 输出、request body `intent` 和 audit event 都不能成为业务状态 writer。
- **旧兼容**：`intent=review` 仍只触发现有更严格的 review authorization；Router 记录该 hint 但不能借 hint 扩权。既有 `issue_*` 工具、PI conversation API request/response、provider adapter 和 schema 均未修改。
- **双写：0；双读：0**：没有新业务表、第二 action writer 或 legacy/new route winner。新增 append-only routing audit 是单份证据，不是业务状态双写。
- **回滚**：移除 conversation 的 pre-route、per-turn Prompt projection 和 authorization narrowing 即可恢复 P06.01 行为；没有 DB migration 或数据回滚，已写 audit 保留。
- **最终替换/删除门禁**：只有中英文/含糊/恶意/multi-intent evaluation fixtures、低置信实际写工具 deny、source-trust 回归、clean-baseline Supervisor journeys 和 P10.07 evaluation harness 连续通过，且替代 router 仍保持同一 schema、fail-closed authority 与 audit correlation 后，才可替换当前 classifier。禁止并行保留两个可扩权 router 或让 request/model 自选 winner。

## 6. 最小验证

```bash
cd backend-ts
bun test src/pi/supervisorIntentRouter.test.ts
bun test src/http/piConversationMessagesApi.test.ts
```

Fixtures 必须覆盖八类意图的中文/英文表达、含糊请求的单问题、明确 multi-intent 顺序、否定 scope、恶意 prompt-like 内容、route payload 不保存原文，以及低置信情况下 LLM 主动调用写工具仍被 deterministic gate deny。
