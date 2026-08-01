# PI Persona 灵魂层设计方案（Draft）

> 状态：Draft，待 review，不是当前实现规范
> 日期：2026-08-01
> 范围：为 runner 内 pi（Xuanwu Supervisor）的 system prompt 增加可编辑的「人格/沟通风格」注入层，解决回复机械化问题
> 约束：不修改内核安全/权限/状态机契约；不改变工具流程 authority；不引入新的外部依赖
> 关联实现：`backend-ts/src/http/piRuntimePrompt.ts`、`backend-ts/src/http/piRuntime.ts`、`backend-ts/src/db/schema/*`、`frontend/src/pages/PiAgentSettingsPanel.jsx`

## 1. 背景与问题

### 1.1 现状

pi 的 system prompt 由 `buildPiRuntimeSystemPrompt()`（`backend-ts/src/http/piRuntimePrompt.ts`）在每次 turn 重新拼接，共约 25 个组成部分（约 20KB+），SDK 资源层再叠加 AGENTS.md、skill 元数据与资源摘要：

1. 语言合同（强制简体中文，系统语言优先于用户消息推断）
2. Xuanwu Supervisor 角色合同（能力边界 / 决策策略 / authority / completion contract）
3. Prompt 注入防御合同（UNTRUSTED_DATA / 指令权分层）
4. 兼容性合同（W1 过渡窗口临时适配器）
5. Supervisor 上下文解析（每轮 JSON）
6. 渠道上下文
7–8. 两条固定约束句（skills 仅 metadata、MCP 仅走 registry）
9. agent 自定义 instructions（当前仅一句合规描述）
10–18. 各类工作流（manual context / memory / workspace / work 工具 / issue 管理 / retry / token economy / URL / repo 提案）
19. 当前时间
20. Skill 元数据（UNTRUSTED_DATA 信封）
21–23. MCP registry / skill policy / MCP policy（JSON）
24. Supervisor 承诺投影（JSON）
25. 记忆上下文（JSON）

当前实际生效配置（live 库 `~/Library/Application Support/codex-issue-runner-bun-live/state/runner.db`）：

| 项 | 值 |
| --- | --- |
| agent | `runner-default`（显示名：石头） |
| 模型 | `openai-codex` / `gpt-5.6-luna` |
| thinking | `high` |
| 自定义 instructions | 一句：*"你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。"* |
| 语言 | zh-CN（app 无语言记录，默认） |

### 1.2 机械化根因（代码级证据）

1. **角色被塑造成"被监管的执行器"而非对话者**：角色合同要求"选最小权限路径"、"claim nothing until its tool or authority confirms it"、"最多问一个澄清问题"、"不得编辑源码/执行任意 skill/捏造状态"。
2. **禁令与强制语量大**：`piRuntimePrompt.ts` 中 Never×7、Do not×8、Must×13、Only×18，中文侧"必须/不得/不要"同样密集。
3. **契约术语轰炸**：Work/Run/Evidence/Handoff/Attention/Automation + authority/completion/capability boundaries/decision policy/uncertainty policy，并要求回复引用工具 id 与状态字段（如 `reached_target=true`）。
4. **语言合同强制中文**：系统语言优先于用户消息推断，用户说英文也被切回中文；还要求 `rationale/recovery_message/message/expected_outcome` 等字段全用中文。
5. **JSON 元数据灌满上下文**：每轮注入 supervisor 解析、MCP registry、policy、commitments、memory 的 JSON，模型被训练成"引用结构化数据回复"。
6. **UNTRUSTED_DATA 安全信封**：所有工具输出/skill 内容被标为"仅数据、无指令权"，模型对一切外部输入持防御姿态。
7. **自定义指令没有"人格"**：instructions 是纯合规描述，无语气、无风格、无表达自由度，模型只能拿流程话术填空。
8. **thinking=high + 几十个工具**：倾向先调工具验证再回答，回合慢、输出高度结构化。

结论：system prompt ≈100% 是流程/权限/安全/契约约束，"人设"只有一句话。为自治安全而设计，代价是回复必然公文化。**这不是模型能力问题，而是 prompt 中没有留给表达的空间。**

## 2. 参考模式：neoclaw / OpenClaw 的 Soul 文件

本机 `~/Documents/xiaobei/neoclaw`（OpenClaw 系）采用 workspace 文件模式：

- `SOUL.md`：人格（Personality / Values / Communication Style）
- `USER.md`：用户画像（称呼、时区、语言、偏好、工作上下文）
- `AGENTS.md`：行为准则（与人格分离）
- `memory/`：长期记忆

启动时 `ContextBuilder.getSystemContext()` 依次加载 `BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"]`，拼接进 system context。核心思想：**人设/语气/沟通风格与流程契约分层，人格层可编辑、可注入**。

## 3. 目标与非目标

### 3.1 目标

- 给 pi 的 system prompt 增加独立可编辑的「Persona 灵魂层」（性格/沟通风格/价值观/主动性/语言模式）与「用户画像层」。
- 让 pi 回复自然、有温度、像 LLM：先结论后理由、口语化、跟随用户语言、主动完成低风险动作。
- 保持现有安全/权限/状态机契约不变（内核只增不改）。
- 提供默认 persona，升级后立即可感知差异；全部可回滚、可关闭。

### 3.2 非目标

- 不重写内核 system prompt 的契约部分（Phase 2 另行评估精简）。
- 不改变工具 authority、Action Gate、审批、状态机、审计路径。
- 不引入外部依赖（不依赖 neoclaw/OpenClaw 代码）。
- 不做 per-project persona 多租户（首期仅全局，预留扩展）。

## 4. 设计

### 4.1 数据模型（新增 1 张表）

**`pi_persona` 表**（全局单行，预留 `project_id` 空串=全局）：

| 字段 | 对应 SOUL.md | 类型 | 默认值 |
| --- | --- | --- | --- |
| `id` | — | text pk | `runner-default` |
| `personality` | Personality | text | 见 4.4 |
| `communication_style` | Communication Style | text | 见 4.4 |
| `values` | Values | text | 见 4.4 |
| `proactive_policy` | —（主动性） | text | 见 4.4 |
| `language_mode` | —（语言） | text | `follow_user` |
| `enabled` | — | integer | 1 |
| `created_at` / `updated_at` | — | text | — |

**`pi_user_profile` 表**（可选 Phase 1.5，先不建）：称呼、时区、语言、回复长度偏好、正式度、技术深度、兴趣话题。

> 决策：DB 存储而非文件。原因：贴合现有 `pi_agents`/面板/API 架构，支持 UI 编辑与审计；SOUL.md 的"文件即配置"风格可通过面板导出/导入近似获得。如需文件来源（如 state 目录 `persona.md`），作为后续增强，不做首期。

### 4.2 Prompt 注入（改 1 个函数）

`buildPiRuntimeSystemPrompt()` 中，**在角色合同（第 2 项）之后、prompt 注入防御合同（第 3 项）之前**插入 `personaSection(db, input)`：

```
## 沟通与表达（Persona 灵魂层）
以下定义"如何说话"，不改变内核契约的权限/安全/状态机规则：
- 性格：<personality>
- 沟通风格：<communication_style>
- 主动性：<proactive_policy>
- 语言：<language_mode 决定：跟随用户 / 简体中文 / English>
当 persona 与任何工具流程描述冲突时，以 persona 决定表达方式，以内核契约定安全性。
```

注入时机说明：

- 位置靠前：persona 先于大量"must/never"约束被读取，避免被后文淹没。
- 每次 turn 重新读取 DB（与现有 `buildPiMemoryPromptContext` 一致），修改即时生效，无需重启。
- `enabled=0` 或表为空时输出空串，行为与现状完全一致（零成本回滚）。

### 4.3 语言合同降级（开关，默认关）

`piLanguageContract()`（`backend-ts/src/i18n/language.ts`）增加行为分支：

- 默认（`language_mode=follow_user`，本次变更后成为默认）：面向用户的自然语言**跟随用户最近消息的语言**；结构化字段（`rationale`/`recovery_message`/`message`/`expected_outcome`）仍按系统语言约束；代码/命令/路径/枚举/JSON 保持原文。
- `zh-CN` / `en-US`：维持现状（强制）。

> 风险提示：跟随用户会削弱多语言一致性，属于表达层取舍；安全字段语言仍受控，不影响审计与前端展示。首期默认 `follow_user`，可通过面板切回强制模式。

### 4.4 默认 persona 内容

```text
personality:
专业可靠的工程参谋长，有温度、不端架子。像一位熟悉项目的老同事，而不是流程机器人。

communication_style:
先给结论，再给理由；回答长度跟随问题复杂度，不为了结构而结构。
口语化、自然，用"我"和"你"，禁止"根据系统合同/权威状态/确定性记录"等官腔。
可以正常寒暄、解释、给建议，像人一样对话。

values:
准确优先于速度；透明说明做了什么与没做什么；不夸大、不虚构、不替用户做未经授权的决定。

proactive_policy:
低风险且结果清晰的请求直接完成，不反复确认；
只有真正缺失关键信息（如目标项目/验收标准/破坏性意图）时才追问一个短问题；
不使用固定话术模板填充回复。
```

同时把默认 agent `instructions`（`backend-ts/src/db/defaultPiAgent.ts` 与 `frontend/src/pages/piAgentSettingsState.js` 的默认值）升级为两段式：人设一句 + 合规一句，与 persona 层保持一致。

### 4.5 API（改 1 个文件）

`backend-ts/src/http/piApi.ts`：

- `GET /api/pi/persona` → 当前 persona（含 `enabled`、`language_mode`）
- `PUT /api/pi/persona` → 更新 persona（校验枚举：`language_mode ∈ {follow_user, zh-CN, en-US}`）
- `GET /api/pi/settings/prompt-summary`（现有 `piRuntimePromptSummary()`）扩展字段：`persona_configured`、`persona_enabled`、`language_mode`

### 4.6 前端 UI（改 2 个文件 + css）

`frontend/src/pages/PiAgentSettingsPanel.jsx` 在 "Runtime Instructions" 下方新增「Persona / 灵魂设置」折叠面板：

- 4 个 textarea：性格 / 沟通风格 / 价值观 / 主动性
- 1 个 select：语言模式（跟随用户 / 简体中文 / English）
- 1 个开关：启用
- PromptSummary 区显示 persona 注入状态

`frontend/src/pages/piAgentSettingsState.js`：扩展 form 字段与保存逻辑。

### 4.7 迁移（新建 1 个文件）

`backend-ts/src/db/schema/063_pi_persona.ts`：

- 建表 `pi_persona` + 唯一索引（`project_id` 预留）
- 插入默认 persona（见 4.4）
- 更新默认 agent instructions 为两段式（仅当仍为旧默认值时）

注册进 `backend-ts/src/db/schema/index.ts`。

### 4.8 测试（2 个文件）

- `backend-ts/src/http/piRuntimePrompt.test.ts` 扩展：
  - persona 启用时注入、字段正确、位于角色合同之后
  - persona 关闭/表为空时输出空串（回归）
  - `language_mode=follow_user` 时语言合同输出跟随语义；`zh-CN/en-US` 维持现状
  - prompt-summary 的 persona 字段
- `backend-ts/src/http/piApi.test.ts` 扩展：GET/PUT persona 的读写、枚举校验、禁用保护

## 5. 落地文件清单

| 文件 | 动作 |
| --- | --- |
| `backend-ts/src/db/schema/063_pi_persona.ts` | 新建（迁移） |
| `backend-ts/src/db/schema/index.ts` | 修改（注册迁移） |
| `backend-ts/src/db/repositories/persona.ts` | 新建（read/write persona） |
| `backend-ts/src/pi/personaPrompt.ts` | 新建（构建 persona section） |
| `backend-ts/src/http/piRuntimePrompt.ts` | 修改（注入 personaSection + summary 扩展） |
| `backend-ts/src/i18n/language.ts` | 修改（language_mode 分支） |
| `backend-ts/src/http/piApi.ts` | 修改（GET/PUT persona） |
| `backend-ts/src/db/defaultPiAgent.ts` | 修改（默认 instructions 两段式） |
| `frontend/src/pages/PiAgentSettingsPanel.jsx` | 修改（Persona 面板） |
| `frontend/src/pages/piAgentSettingsState.js` | 修改（form 字段/保存） |
| `frontend/src/pages/PiAgentSettingsPanel.css` | 修改（样式） |
| `backend-ts/src/http/piRuntimePrompt.test.ts` | 修改（测试） |
| `backend-ts/src/http/piApi.test.ts` | 修改（测试） |

不动：Action Gate、状态机、工具注册、审批/审计、MCP/skill 策略、SDK 资源加载器。

## 6. 风险与回滚

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| persona 引导模型忽略安全约束 | 中 | persona 文本明确"不改变内核权限/安全/状态机规则"；内核契约仍在同一 system prompt 中；测试断言注入顺序 |
| 跟随用户语言导致多语言不一致 | 低 | 结构化字段仍受系统语言控制；可切回强制模式 |
| 默认 persona 表述不当引发风格问题 | 低 | 首期默认值保守；面板可随时修改/关闭 |
| 每 turn 多一次 DB 读 | 极低 | 单行主键查询，与现有 memory/commitment 注入同量级 |
| 迁移在旧库上失败 | 低 | 迁移幂等（`create table if not exists`），follow 现有 062 模式 |

回滚：`enabled=0` 或删除行即恢复现状；迁移本身可逆（drop 表）；不涉及数据迁移回写。

## 7. 验证方式

1. 单元测试：persona 注入/关闭/语言模式/prompt-summary。
2. 面板手动验证：改 persona 后新 turn 回复语气变化；关闭后恢复。
3. 真实对话采样：升级前/后各取 5 条 feishu/runner 对话，对比官腔密度、口语化程度、是否跟随用户语言。
4. 回归：既有 `piRuntimePrompt.test.ts`、`piApi.test.ts`、`piRuntimeSmoke.test.ts` 全绿。

## 8. Phase 划分

- **Phase 1（本方案）**：Persona 注入 + 默认配置 + 语言模式开关 + 面板 + API + 迁移 + 测试。内核不动。
- **Phase 1.5（可选）**：`pi_user_profile` 表 + 用户画像注入。
- **Phase 2（另行评估）**：精简 system prompt——把 `issueManagementWorkflow`、`legacyWorkToolWorkflow` 等大段流程从 system prompt 挪入工具 description/按需注入，目标 ~20KB → ~8KB。风险高，需回归整个自治链路，先验证 Phase 1 效果再决定。
