# ADR-XW-0047：Supervisor 项目、Work 与会话上下文解析器

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.04 / Runner #683
- 硬依赖：XW P06.03 / #682、XW P02.06 / #652（均为 `done`）
- 可执行实现：`backend-ts/src/pi/supervisorContextResolver.ts`
- Runtime 接入：`backend-ts/src/http/piConversationApi.ts`、`backend-ts/src/http/piRuntimePrompt.ts`
- canonical 级别：本文、`SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA` 与 `resolveSupervisorContext()` 共同构成本阶段逐 turn target resolution、candidate scoring、歧义和 provenance 的 source of truth

## 1. 决策

每条 PI user turn 在创建 Supervisor runtime 前生成一份
`xw.supervisor-context-resolution.v1`。Resolver 只使用确定性、可复查的候选来源：

1. 显式 Work/legacy issue 引用；
2. transport 或交互卡片传入的 one-shot project target；
3. 文本中明确出现的项目 ID/名称；
4. Runner 当前页面绑定的 `pi_conversations.project_id`；
5. 同一个 Runner conversation 最近的 authoritative `pi_actions` 关系。

输出固定包含 `resolved | ambiguous | missing`、排序后的项目候选、逐候选分数、来源 ref、关联 Work、输入摘要、跨渠道继承策略和必要时的一次澄清问题。Supervisor Prompt 只消费这份紧凑投影；LLM 不负责重算候选、选择歧义 winner 或持久化项目。

## 2. Candidate scoring 与冲突

| 来源 | 基础分 | authority / provenance |
| --- | ---: | --- |
| `work_reference` | 100 | P02.06 复用的 Issue-backed Work adapter；`xw:work:issues:*` |
| `one_shot_target` | 96 | 当前 request/transport/card 已验证存在的 Project |
| `explicit_project` | 90–95 | 当前 turn 文本与 `projects.id/name` 的最长明确匹配 |
| `current_page` | 70 | 当前 trusted Runner conversation 的页面绑定 |
| `conversation_history` | 55 | 当前 trusted Runner conversation 最近的 `pi_actions` |

同一项目有多个来源时只获得最多 4 分的可解释 tie-break bonus，弱来源不能累加超过直接来源。多个直接来源若指向不同项目，Resolver 必须返回 `ambiguous`，不能让最高分悄悄覆盖冲突。没有直接来源时才选择唯一最高分；同分仍为 `ambiguous`。

一个项目内可保留多个 `work_ids`，供后续 P06.05 planner 判断是否为合法 multi-Work 请求。多个 Work 分属不同项目时本阶段先澄清项目，不跨项目隐式执行。

## 3. one-shot、会话与跨渠道

- one-shot target 只作用于当前 turn 的 `toolProject`、授权 scope 和 Prompt；不更新 `pi_conversations.project_id`，也不写新的 context state。
- Runner 页面上的 conversation project 可作为当前页上下文，后续不需要用户每次 `@项目`。
- `runner_chat` / `runner_review` 才允许读取当前页和同 conversation action history。
- Feishu 等跨渠道 source 不继承 `pi_conversations.project_id` 或其他渠道历史；每条消息只能使用本 turn 的显式 Work/项目或 one-shot source target。
- Feishu chat/user mapping 只在当前消息的 chat/sender 精确匹配时形成 `mapping_default` one-shot target；不同 chat/sender 不命中，多个 mapping 冲突返回歧义。旧 `activeProject` 不恢复为隐式 IM context。

这使“来源映射可用”和“跨渠道不错误继承项目”同时成立。项目选择卡片也只恢复原始 pending prompt 一次，不把选择保存成后续默认项目。

## 4. Runtime 权限与审计

每次解析追加一条 `pi_action_events`：

- `event_type=supervisor_context_resolved`；
- `actor=supervisor_context_resolver`；
- `action_id=context-resolution:<turn-id>`，与同 turn intent route 对齐；
- `decision=resolved|ambiguous|missing`；
- payload 保存 schema resolution、candidate scores、source refs、16 字符输入 digest 和字符数，不保存 prompt 原文。

`resolved` 只收窄 `toolProject` 与 project authorization scope，不授予写权限。实际读写仍经过 P06.03 intent route、tool registry、Action Gate、approval 和 P02.06 Work/Issue authority。

`ambiguous` 必须把 runtime authorization 缩到 read-only，并要求一次项目澄清；即使 LLM 猜测项目，也不能在歧义 turn 创建或控制 Work。`missing` 不等于所有意图都需项目：问候、能力问答和全局 memory 等仍按 intent/tool gate 判断，项目型请求由 Supervisor 追问一次。

## 5. 兼容、迁移、回滚与删除门禁

- **业务状态 authority 不变：** Project 仍以 `projects` 为准；Work 继续以 P02.06 的 `issues` + Issue-backed Work adapter 为读写 authority；`pi_conversations`、`pi_actions` 和 Feishu mapping 只提供上下文 provenance。
- **双写：0：** Resolver 只追加 audit，不写 Project、Work、conversation project 或 IM active project。
- **双读：0 个 winner：** 所有来源在单一 deterministic resolver 中评分，不保留 LLM resolver 或第二 state machine；Work 读取复用现有 adapter。
- **旧兼容：** 现有 `target_project_id` 继续作为 one-shot target；Runner conversation project 继续可用；Feishu card/explicit project/issue flow 不改 HTTP response contract。
- **回滚：** 移除 conversation 的 resolve/audit/Prompt projection，恢复旧 `targetProjectId ?? conversation.project_id` tool scope；删除 Feishu mapping fallback 即恢复原 ask/select 行为。没有 DB migration 或数据回滚，已写 append-only audit 保留。
- **最终替换/删除门禁：** 只有多项目/多 Work 歧义、same-channel history、跨渠道隔离、source mapping、one-shot 不持久化、低权限 fail-closed、clean-baseline journeys 与 P10.07 evaluation 连续通过，且替代实现保持同一 schema/provenance/audit correlation 后，才能替换本 resolver。禁止并行保留可自行选 winner 的 LLM resolver。

## 6. 最小验证

```bash
cd backend-ts
bun test src/pi/supervisorContextResolver.test.ts
bun test src/http/piConversationMessagesApi.test.ts
bun test src/integrations/feishuProjectContext.test.ts src/integrations/feishuAgentBridge.test.ts
```

Fixtures 必须覆盖：多项目文本、多 Work 跨项目冲突、显式 Work 覆盖当前页、one-shot 后下一 turn 不继承、同 Runner conversation history、Feishu 不继承本地/旧 conversation project、source mapping 精确匹配与冲突，以及 audit/prompt 不保存原始输入。
