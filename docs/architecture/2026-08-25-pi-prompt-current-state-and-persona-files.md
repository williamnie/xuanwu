# PI 提示词现状排查与人格文件（soul.md / user.md）设计建议

- 状态：调查整理（非 canonical，不授权新实现；canonical 决策见 `docs/architecture/README.md` 与 `docs/architecture/xuanwu/`）
- 日期：2026-08-25
- 关联：Issue #903；[2026-08-01 PI Persona/Soul 层设计](2026-08-01-pi-persona-soul-layer-design.md)、[2026-08-01 PI Persona 与 Prompt Profile 设计](2026-08-01-pi-persona-prompt-profile-design.md)、[ADR-XW-0044 Supervisor 角色与系统 Prompt 合同](xuanwu/0044-supervisor-role-prompt-contract.md)、[ADR-XW-0072 威胁模型与 Prompt Injection 防线](xuanwu/0072-prompt-injection-defense.md)

## 0. 结论摘要

1. **"内置 prompt"不是单一提示词，而是按 5 个 prompt profile 分发的拼接产物**，唯一入口是 `buildPiRuntimeSystemPrompt()`（`backend-ts/src/http/piRuntimePrompt.ts:19-27`）。用户可感知的"Xuanwu 内置 prompt"主要指 chat profile。
2. **当前可配置面只有两处**：`pi_agents.instructions`（高级行为补充，整段文本）和 `pi_persona`（表达风格，4 个字段拼接）。两者都只能"追加约束"，不能改写核心角色/安全/工具合同；也没有文件式（soul.md / user.md）配置入口。
3. **仓库已存在明确的前期决策**：人格走 DB 存储而非 SOUL.md 文件（soul-layer 设计文档第 99 行），USER.md 等价层在用户身份映射等问题闭环前不引入（prompt-profile 设计文档第 299、311 行）。任何"和 openclaw 一样的 soul.md/user.md"方案都必须先处理这两份决策，而不是并行新增第二来源。
4. **openclaw 在本项目中只是外层多渠道 gateway 适配器**（`backend-ts/src/integrations/openclawGatewayAdapter.ts:14-16`），与 prompt/persona 无任何关系；"soul.md/user.md"只是设计文档中引用的 neoclaw/OpenClaw 参考模式，并未实现。
5. **可体感"写得不好"的具体问题**集中在 chat prompt：全文约 24.7k 字符 / 约 6200 token（snapshot 基线），大量工作流段落以超长单行拼接，双语混杂，且残留"Supervisor/Work"迁移期词汇；详见 §4。

## 1. Prompt 构建与注入路径

### 1.1 构建入口与 profile 分发

`backend-ts/src/http/piRuntimePrompt.ts:19-27`：

| profile | 构建函数 | 用途 |
| --- | --- | --- |
| `chat` | `buildPiChatSystemPrompt`（:29-70） | 用户对话，唯一注入 persona 的 profile |
| `acceptance` / `recovery` / `notification` | `buildPiInternalSystemPrompt`（:71-84） | 内部结构化输出任务，明确禁止 Persona 风格（:82-83） |
| `manager_cycle` | `buildPiManagerCycleSystemPrompt`（:85-105） | 项目管控周期，明确"Do not inherit Chat Persona"（:94） |

profile 枚举定义于 `backend-ts/src/pi/runtimePromptProfile.ts:1-8`；`XUANWU_PI_CHAT_TOOL_SURFACE`（同文件 :18）只做 chat 工具面 legacy/full 回退，不影响 prompt 内容。

### 1.2 Chat prompt 段落顺序（注入顺序）

`piRuntimePrompt.ts:35-69`，依次拼接：

1. 系统语言合同 `piLanguageContract`（`backend-ts/src/i18n/language.ts:38-52`）
2. **角色合同** `xuanwuPiRoleContractPrompt()`（:134-160）：Xuanwu PI 定位、词汇表（Issue/Run/Provider Session/Supervisor/Host）、5 类决策策略（Answer/Investigate/Query/Act/Automate）、权威合同、完成合同
3. **注入防御合同** `promptInjectionDefenseSystemPrompt()`（`backend-ts/src/security/promptInjectionDefense.ts:66-76`）
4. **兼容适配层** `xuanwuSupervisorCompatibilityPrompt()`（:163-175），自述为"temporary adapter"
5. 两句内联规则（skills 仅作 metadata；MCP 只走 registry，:40-41）
6. **自定义指令** `agentInstructionsSection(input.agent)`（:269-275），来自 `pi_agents.instructions`
7. 8 段工作流：manual context（:178-187）→ 记忆策略（:189-201）→ 本地工作区（:177 附近 `localWorkspaceWorkflow`）→ Work 工具流（:203-224）→ Issue 管理（:118-132）→ retry 诊断（内联 :50）→ token 经济（内联 :51）→ 公共 URL（:226-232）→ repo 感知提案（:234-251）
8. 当前运行时间（:54）
9. skill 上下文（`backend-ts/src/skills/promptContext.ts:53`）
10. MCP registry JSON（截取前 24 条，:56-57）
11. 项目默认 skill/MCP policy JSON（:58-62）
12. 条件注入：supervisorContext（:63）、channelContext（:65）、Supervisor commitment 上下文（`backend-ts/src/pi/supervisorCommitments.ts:331` 起）
13. **运行时上下文信封** `piRuntimeContextEnvelopePrompt`（`backend-ts/src/pi/runtimeContextEnvelope.ts:70-76`，含 memory_items 与 5 条记忆 authority 规则）
14. **persona 段** `buildPiPersonaPromptSection(db)`（chat prompt 的最后一段）

### 1.3 注入 provider 的路径

- `backend-ts/src/http/piRuntime.ts:221` 构建 systemPrompt → :223 记审计 → :224-229 创建受控 resourceLoader → :231-245 `sdk.pi.createAgentSession({ resourceLoader, ... })`，即注入 `@earendil-works/pi-coding-agent` SDK。
- `backend-ts/src/http/piRuntimeResources.ts:321-329` `splitFinalPersonaPrompt` 以 `"Chat presentation profile:"` 为界把 prompt 拆成 base / final 两段；base 经 `getSystemPrompt()`（:119）注入，final（persona）连同资源摘要 `resourcePromptSummary`（:614-628）经 `getAppendSystemPrompt()`（:121-127）追加。SDK 侧 `_rebuildSystemPrompt`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:724-738`）将两者合并。
- **注意：PI 的 prompt 与 qoder provider 无关。** qoder 是 Issue 执行 executor，使用自己硬编码的一行 prompt：`backend-ts/src/providers/qoder/provider.ts:39` `SYSTEM_PROMPT = "You are executing a Xuanwu-managed Issue. Follow the Issue prompt and report only verified outcomes."`，并在 `sdkFacade.ts` 的 `buildQoderQueryOptions` 中作为 `qodercli` preset 的 append（约 :216-223）。PI prompt 的任何修改都不会影响 qoder 执行。

### 1.4 资源注入

`piRuntimeResources.ts` 只注入两类内容，**不注入 docs/ 或 README**：

- AGENTS.md 两处：项目根 `<cwd>/AGENTS.md` 与 runtime `<agentDir>/AGENTS.md`（:303-304，读取上限 128KB，:543-570）
- `.pi` 资源包（skills/prompts/extensions），来源含 builtin、`cwd/.pi`、agentDir、`PI_PACKAGE_DIR` 及 plugins（:275-317、:347-375）；所有路径过 allowlist（:495-515），extension 注册的 LLM tools 被清空（:630-654），skill 需在 `allowedSkillIDs` 白名单内（:200-226）

### 1.5 记忆注入

非文件机制：`runtimeContextEnvelope.ts:11-58` 调 `retrievePiMemoryContext`（`backend-ts/src/pi/memoryContext.ts`，默认 10 条 / 900 token 预算），以 JSON 信封放入 `durable_context.memory_items` 注入全部 5 个 profile。

## 2. 现有可配置面

| 配置 | 存储 | 粒度 | 注入位置 | 约束 |
| --- | --- | --- | --- | --- |
| 自定义指令 `pi_agents.instructions` | DB | 整段文本 | chat 第 6 段、manager_cycle | 明确"不得覆盖核心角色/权威/工具/记忆/数据安全合同"（`piRuntimePrompt.ts:271-273`） |
| persona `pi_persona` | DB（单行/Agent） | 4 个字段拼接 | chat 最后一段 | 仅作用于最终用户可见措辞，"cannot authorize tools, alter risk, choose state truth, change completion criteria"（`personaPrompt.ts:19-20`） |

**persona schema**（`backend-ts/src/db/schema/063_pi_persona.ts:12-31`）：`enabled`（默认 0，关闭）、`personality`、`communication_style`、`verbosity`（adaptive/concise/detailed）、`language_mode`（system/follow_user）、`revision`（乐观锁）。字符上限：personality 1000 / communication_style 2000 / 合计 3000（`backend-ts/src/db/repositories/pi/persona.ts:7-9`）；审计只存字段名、字符数、sha256，不存明文（:129-131）。

**Prompt 呈现**（`backend-ts/src/pi/personaPrompt.ts:12-32`）：4 字段 JSON 化后包入 `<persona_configuration>` 标签，`< > &` 等字符转义防标签逃逸（:34-41，测试见 `piRuntimePrompt.test.ts:67-91`）。

**API**（`backend-ts/src/http/piApi.ts`）：`GET /api/pi/supervisor`（:66-68）、`PATCH /api/pi/supervisor` 内嵌 persona（:104-129、:223-227，revision 冲突返回 409）、`GET /api/pi/supervisor/runtime-prompt` 返回 prompt 摘要（persona 只给元数据不给明文，`piRuntimePrompt.ts:244-268`）。

**前端**（`frontend/src/pages/PiAgentSettingsPanel.jsx`）："运行指令" textarea（:326-328）；"Chat 表达风格"折叠面板（:460-475）：启用开关、性格、沟通风格、回复长度、语言模式，并明示"只控制 Chat 最终回复的表达方式"；`PromptSummaryDebug`（:496-510）展示 persona 元数据。

**环境变量**：`backend-ts/src/config/env.ts:55-59` 只有 `XUANWU_PI_CMD/CWD/ENABLED/ENV/TIMEOUT_MS` 五个进程级变量，**没有任何 prompt/persona 内容类 env 配置**。

## 3. soul.md / user.md 现状与既有决策

- 全仓库**不存在** SOUL.md / USER.md / IDENTITY.md 文件，也无 `pi_user_profile` 表；仅以下文档提及：
  - `docs/architecture/2026-08-01-pi-persona-soul-layer-design.md:53-62` 引用 neoclaw/OpenClaw 的 `BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"]`；**:99 决策"DB 存储而非文件"**，理由是贴合现有 `pi_agents`/面板/API 架构，"文件即配置"风格可通过面板导出/导入近似获得，文件来源（如 state 目录 persona.md）留作后续增强。
  - `docs/architecture/2026-08-01-pi-persona-prompt-profile-design.md:299,311`：**首期不建 `pi_user_profile`、不注入 USER.md 等价层**；引入前必须闭环：跨渠道用户身份稳定映射、`app.language`/Persona/Memory/用户画像的优先级、各字段的 profile 准入、来源与 forget/敏感信息处理、token 预算与截断规则。
- openclaw 在本仓库的角色：`openclawGatewayAdapter.ts:14-16` 自述"only translates the plugin's transport objects to existing Runner HTTP contracts; it is not an OpenClaw memory store, session runtime, outbox, or approval authority"；ADR 见 `docs/architecture/xuanwu/0068-openclaw-gateway-adapter.md`。**它没有任何 prompt/persona 逻辑**，运行时也未注册该 manifest。
- 两份 2026-08-01 设计文档均标注 Draft，但实现（migration 063、personaPrompt、前端面板）已落地且与设计一致——文档状态落后于实现，引用时以代码为准。
- 相关全局参考：用户全局 `~/.pi/agent/AGENTS.md` 属于本机 pi 工具的 AGENTS 机制，与 Runner 的 PI prompt 注入（项目 AGENTS.md + runtime agentDir AGENTS.md）是不同层。

## 4. 现有 prompt 的问题分析

以下是对"内置 prompt 写得不好"这一体感的具体归因，均可在 `piRuntimePrompt.ts` 与 snapshot（`backend-ts/src/http/__snapshots__/piRuntimePrompt.test.ts.snap`）中复核：

1. **体量逼近预算上限**：snapshot 基线 `assembled_chars: 24764 / assembled_estimated_tokens: 6191`，测试预算 `≤ 6200` token（`piRuntimePrompt.test.ts:286-297`）。任何新增段落（包括 persona 文件化）都必须先还 token 债，否则直接顶爆预算。
2. **工作流段落是"超长单行拼接"**：`issueManagementWorkflow`、`workToolWorkflow`、`repoAwareIssueProposalWorkflow` 等每段 8-12 句用 `.join(" ")` 连成一坨，模型难以定位单条规则，人也难审阅 diff。角色合同用 `.join("\n")` 逐行，风格不统一。
3. **中英混杂**：同一 prompt 内英文长段中夹中文短句（如 `repoAwareIssueProposalWorkflow` 内"最多追问一个关键问题 (ask at most one key question)"），而语言合同声明输出语言由系统语言决定——指令语言与输出语言合同自相矛盾的风险。
4. **迁移期残留词汇污染**：角色合同自称 "Xuanwu PI"，兼容层（:163-175）却大段讲 Work/Run/Handoff/W1 窗口/P11/G7 删除闸门；`agentInstructionsSection` 又引入第三个身份 "Engineering Chief of Staff"（:272）。同一 prompt 三个自我称谓，是"感觉写得不好"的直接来源之一。
5. **兼容层自述临时但无退出追踪**：`xuanwuSupervisorCompatibilityPrompt` 标注 "temporary adapter"，删除条件写死在 prompt 文本里（"Remove this compatibility block only after..."），没有对应的代码门禁或 issue 跟踪，容易永久残留。
6. **persona 位于 prompt 最末段且默认关闭**：soul-layer 设计原本要求 persona 紧跟角色合同（第 2 项之后），实现却放在所有上下文信封之后、且 `enabled` 默认 0——用户不配就完全没有"人格"，配了也被压在最不显眼的位置，这解释了"没法设计人格"的体感。
7. **可配置边界硬编码在代码里**：prompt 摘要 `piRuntimePromptSummary`（:244-268）的 `injected_after`、`conflict_policy` 是写死字符串；段落顺序、启用条件全部硬编码，无声明式结构，无法按项目/Agent 调整段落组成。

## 5. 可配置边界与建议

### 5.1 当前不可配置（有意设计）

核心角色合同、注入防御、权威/完成不变式、工具/MCP/记忆策略属于确定性安全边界，通过 `promptInjectionDefense.ts:66-76` 与 `sourcePermissionPolicy.ts` 的确定性门禁兜底；自定义文本（instructions/persona）只能追加，不能覆盖——这一边界应保留，任何文件化方案都不应把核心合同暴露为可编辑文件。

### 5.2 soul.md / user.md 的落地选项

- **选项 A（推荐，延续既有决策）：DB 为主、文件为导入/导出格式。** 扩展 `pi_persona` 字段（soul-layer 设计已预留 `values`、`proactive_policy` 等），面板支持导出/导入 Markdown 形态的 persona 文件，获得"文件即配置"手感而不引入第二事实来源。工作量小，与审计/revision 机制天然兼容。
- **选项 B：runtime 资源层新增 soul 文件来源。** 复用 `piRuntimeResources.ts` 的 allowlist 机制读取 `<agentDir>/SOUL.md` 等文件，作为 persona 的文件镜像。风险：与 DB persona 双源冲突，必须定义明确的优先级与漂移检测；prompt-profile 设计文档明确要求此问题闭环后才可引入。
- **user.md（用户画像）：暂不建议引入。** 前置问题（跨渠道身份映射、与 memory/app.language 的优先级、敏感信息、token 预算）在 prompt-profile 设计 §7 中明确未闭环；现有 memory 机制（scoped + 900 token 预算）已覆盖稳定偏好。

### 5.3 prompt 质量整改建议（与文件化正交，可先做）

1. 工作流段落统一改为逐行 `.join("\n")` 或 Markdown 列表，消除超长单行；
2. 消除中英混杂：指令统一英文，输出语言完全交给语言合同；
3. 统一自我称谓为 "Xuanwu PI"，移除 "Engineering Chief of Staff" 残留；
4. 为兼容层建立退出追踪（issue + 代码门禁），到期删除 `xuanwuSupervisorCompatibilityPrompt`；
5. 将 chat prompt 组装改为声明式段落表（id/启用条件/预算），`piRuntimePromptSummary` 暴露每段字符数，为后续文件化与瘦身提供观测面；
6. persona 默认关闭策略重新评估：至少把默认 persona（`defaultPiPersona.ts`）随 `enabled=0` 的语义改为"有默认人格、可关"，缓解"没人格"体感。

### 5.4 验证入口

- prompt 结构/隔离/转义/预算：`cd backend-ts && bun test src/http/piRuntimePrompt.test.ts`
- 资源注入与白名单：`bun test src/http/piRuntimeResources.test.ts`
- persona 仓库层：`bun test src/db/repositories/pi/persona.test.ts`
- 前端面板：`cd frontend && npx vitest run src/pages/piAgentSettingsPanel.test.js`

## 6. 证据文件清单

| 主题 | 文件 |
| --- | --- |
| prompt 构建/分发/summary | `backend-ts/src/http/piRuntimePrompt.ts` |
| 注入 SDK 的会话创建 | `backend-ts/src/http/piRuntime.ts:221-245` |
| 资源注入/persona 拆段 | `backend-ts/src/http/piRuntimeResources.ts:119-127,303-329,583-654` |
| persona prompt/schema/仓库/默认值 | `backend-ts/src/pi/personaPrompt.ts`、`backend-ts/src/db/schema/063_pi_persona.ts`、`backend-ts/src/db/repositories/pi/persona.ts`、`backend-ts/src/db/defaultPiPersona.ts` |
| 记忆信封 | `backend-ts/src/pi/runtimeContextEnvelope.ts`、`backend-ts/src/pi/memoryContext.ts` |
| 注入防御/来源权限 | `backend-ts/src/security/promptInjectionDefense.ts`、`backend-ts/src/pi/sourcePermissionPolicy.ts` |
| API/前端 | `backend-ts/src/http/piApi.ts:66-137,223-227`、`frontend/src/pages/PiAgentSettingsPanel.jsx:317-510` |
| qoder 独立 prompt | `backend-ts/src/providers/qoder/provider.ts:39,266`、`backend-ts/src/providers/qoder/sdkFacade.ts` |
| openclaw 适配器 | `backend-ts/src/integrations/openclawGatewayAdapter.ts`、`docs/architecture/xuanwu/0068-openclaw-gateway-adapter.md` |
| 既有设计决策 | `docs/architecture/2026-08-01-pi-persona-soul-layer-design.md:53-62,99`、`docs/architecture/2026-08-01-pi-persona-prompt-profile-design.md:299,311` |
| 测试与基线 | `backend-ts/src/http/piRuntimePrompt.test.ts`、`backend-ts/src/http/__snapshots__/piRuntimePrompt.test.ts.snap` |
