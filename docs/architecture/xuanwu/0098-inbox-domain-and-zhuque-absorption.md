# ADR-XW-0098：Inbox 管理域、来源插件中心与吸收朱雀的改造

- 状态：Proposed
- 日期：2026-10-31
- 决策范围：产品非目标、Inbox 边界、来源插件合同与插件中心、外部消息 intake、来源授权、memory authority、提醒，以及从朱雀吸收的 Soul / 记忆 / 模型与登录 / 技能 / 插件中心
- Supersedes：ADR-XW-0001 第 5 节中「日历/邮件代管」「外部消息回复」「通用个人 memory」三条非目标，在本 ADR 定义的 Inbox 边界内放开（见 2.2）；其余非目标、六个核心工作、source of truth 与迁移合同继续有效
- 相关 canonical 合同：ADR-XW-0001、0058、0061、0063、0064、0072、0076、0088、0092

## 1. 背景

2026-10-19 起，用户在玄武之外另开了私有原型「朱雀」（Pi SDK + SQLite + 本地 Web），用来做玄武非目标排除的那部分：分拣用户本人 IM 和邮件里别人发来的消息，替用户起草或发送回复，记待办，并把工程活派给 Coding Agent。

两周后的结论有两条。

**一、能力上朱雀独有的很少，和玄武重复的很多。**

| 朱雀能力 | 玄武现有实现 |
| --- | --- |
| CLI 信息源插件（manifest + JSONL） | `pi/intake/cliConnectorManifest.ts`（工具式，按需拉取） |
| 分拣 | `pi/intake/llmIntake.ts`：带 schema 的单次结构化调用 |
| 提案 → 授权 → 执行 | `action_proposals` + `http/pi/piActionProposalExecution.ts` + `pi/actions/sourcePermissionPolicy.ts` + Action Gate |
| 代回复 | `message.reply_draft` / `message.reply_send`，按 `reply_policy` 的 chat / person allowlist 放行，并有 `assessDataEgress` |
| 提醒 | `reminder.create` → automation |
| 记忆、通知、早晚报、定时 | `pi/memory/`、`pi/notifications/`、`schedule/cronSchedule.ts` |
| 派工程活 | 朱雀经 OCS 派给在线会话；实测会话地址动态变化，两天只派出 1 次，且停滞 |

两套 Pi、两套 memory、两套审批和两个 Web 入口带来的直接问题是**知识分裂**：玄武知道有哪些项目、对应哪些仓库，朱雀知道对话在聊什么。实测里朱雀把工程活派到错误的仓库，根因就是它没有项目概念。

**二、产品体验上朱雀有几块比玄武好**，合并时应该以朱雀为准改造玄武，而不是把朱雀降级迁入：插件中心、记忆、Soul、模型与登录、技能（见第 3 节）。

### 1.1 用户证据（朱雀 2 天 live 数据，钉钉单一来源，只列统计）

- 149 条消息，12 个会话；其中 36 条是用户本人发的，但因为没有配置本人身份，全部被当作外部消息分拣，产生了「替用户回复用户自己」「把用户对同事的安排当成派给 Coding Agent 的工程活」等错误任务。
- 朱雀按「来源 + 会话 + 发送方」攒批，同一段对话里一来一回被拆开：109 批里有 86 批只有 1 条消息；相隔 5 分钟以内的 93 对相邻消息，有 62 对落在不同批次；出现了两组相隔 2~3 分钟、内容相同的重复任务。
- 分拣用的是 agent 循环：每批平均 2.2 次模型调用，109 批里 `conversation_context` 调了 61 次、`memory_search` 调了 39 次，`skill_read` 一次没调。系统提示词 5.9k 字，其中 75% 是没被用到的 skills 列表。
- 别人发来的 113 条消息里，有 51 条在 15 分钟内用户本人已经回复。

结论：分拣的质量主要取决于**引擎准备的上下文**（本人身份、整段对话、项目归属），而不是 agent 自己查找的能力。这和玄武「context bundle + 单次结构化 intake」的形状一致；朱雀的问题在适配和上下文，而它的界面和配置设计值得保留。

## 2. 决策

### 2.1 一句话

**进入玄武 Inbox 的消息，玄武都要分拣并给出处理结论；结论能执行到哪一步，由授权决定。** 用户通过「启用哪些来源插件、插件里收哪些会话」决定什么进入 Inbox。朱雀停止开发，它的插件中心、记忆、Soul、模型与登录、技能按第 3 节迁入玄武后归档。

### 2.2 Inbox 边界

1. **进不进 Inbox 由用户控制，分两层：**
   - 插件层：在插件中心启用或停用来源插件（钉钉、飞书、Gmail……）。
   - 会话层：插件内按会话或按人设三档：`triage`（分拣）、`context_only`（只当上下文，不分拣）、`excluded`（不收）。会话层沿用现有 source policy，粒度从来源细化到会话。
2. **进了 Inbox 就一定有结论**，结论只有：忽略、记住、回复草稿、待办、提醒、triage issue。没有「没看到」这种状态。
3. **「管」不等于「动手」。** 默认结论都停在草稿或待办；自动回复、自动建 issue、自动入队要在来源授权里单独放开（2.5）。
4. **Inbox 不区分工作与生活。** 用户启用的就管，用户没启用的就不碰。ADR-XW-0001 第 5 节以下三条在 Inbox 边界内放开：

| ADR-XW-0001 第 5 节原文 | 本 ADR 后 |
| --- | --- |
| 日历/邮件代管 | 已启用来源的日历与邮件：读取、起草、经授权代发；日历写入只能通过插件的 send / act 能力和 Action Gate |
| 默认接管……社交账号或外部消息回复 | 已启用来源的代回复：默认只出草稿，自动发送必须由来源授权显式放开；「默认接管」仍然不做 |
| 以「记住用户的一切」为价值的通用个人 memory | Inbox 内的人、承诺与安排可以记忆，必须有来源，并按 2.5 区分权威等级 |

继续不做：接管整台电脑或任意 shell；以 channel 数量或插件市场为卖点；为每个来源复制一套 Issue / Approval / Automation 状态机。

### 2.3 对话入口与 Inbox 分离

| | 对话入口 | Inbox |
| --- | --- | --- |
| 例子 | Web 聊天、飞书 / Telegram 机器人单聊 | 用户本人钉钉、飞书、邮箱里别人发来的消息 |
| 谁在说话 | 用户本人 | 第三方 |
| 内容地位 | 指令（仍受 Action Gate 约束） | **永远是数据**，消息里要求做什么都只当内容判断 |
| 处理路径 | Pi 对话会话 | intake → `action_proposals` → 来源授权 |
| 实现 | 玄武原生 channel（ADR-XW-0064） | 来源插件（2.4） |

同一个渠道可以同时出现在两边（例如飞书：机器人是对话入口，用户本人账号读到的消息进 Inbox），但走两条路，不能混。

### 2.4 来源插件合同与插件中心

**三层分工：**

| 层 | 负责方 | 做什么 | 不做什么 |
| --- | --- | --- | --- |
| 渠道 CLI / API（dws、lark-cli、Gmail API） | 官方或第三方 | 收发消息 | — |
| **来源插件**（manifest + 薄适配脚本） | 玄武维护官方插件 | 收消息（常驻流或定时拉取）、规范化成标准事件、维护游标、读历史、执行发送 | 不调 LLM，不做分拣或任何「该怎么办」的判断 |
| 玄武核心 | 玄武 | 分拣、本人身份、项目归属、记忆、授权、执行 | — |

渠道相关的知识（哪条是用户本人发的、属于哪个会话、回复发给谁）必须写在插件里并有测试守着，不交给模型猜。分拣不放进插件，因为分拣需要跨来源的信息（同一个人在 IM 和邮件里说同一件事、项目列表、记忆、本人身份），提示词和回放评测也只该维护一套；插件对接外部渠道，只算半可信，不能决定动作。插件可以附带渠道给的提示（系统通知、@ 了用户），只当数据。

**manifest 扩展。** 现有 `pi-cli-connector.v0` 是工具式的（Pi 按需调命令拉数据）。新增 `source` 能力，协议以朱雀插件协议为准：

- `stream` 或 `poll` 两种收取模式，游标由玄武保存；
- 标准事件必填 `chat_id`、`sender`、`is_self`、`occurred_at`、回复目标；有 thread 的带 thread；
- `history`：按会话读上文（构建 context bundle 时用）；
- `send`：只能由 Action Gate 批准后的动作调用，带动作 id 作为幂等键；
- `setup`：按锁文件安装插件自己的依赖；插件进程不拿玄武的任何凭据，渠道凭据由插件自己管。

**插件中心。** 迁入朱雀的插件中心：官方插件目录、安装、设置（含本人身份）、会话三档、授权、随时启停、健康状态（复用 ADR-XW-0076 的诊断）。首批官方插件：钉钉、飞书（用户本人身份）、Gmail、jsonl-file（测试与回放）。

### 2.5 分拣与授权

**分拣合同：**

1. **本人身份是插件设置的一部分**，事件带 `is_self`。本人发的消息只当上下文，不触发 intake。本人在同一会话里的回复作为上下文交给分拣，由模型判断前面的消息是否已由本人处理（可给出 `ignore`，原因 `self_handled`）；引擎不自动标记为已处理（TD-1 第 5.5 节）。
2. **对话以 chat 为单位，而不是以发送方为单位。** context bundle 必须按 `chat_id`（有 thread 时按 thread）选取事件。现状 `contextBundleBuilder.isRelated` 在没有 thread 时会纳入同一来源、时间窗内的**所有会话**，必须先修。
3. **静默窗。** 同一 chat 最后一条消息之后静默 N 秒才分拣，并设最长等待上限。静默窗只是触发时机，正确性靠第 2 条（每次分拣都带整段上文和该 chat 之前的处理结果），不靠窗口长短。现状飞书 bridge 每到一条就路由，需要改。
4. **单次结构化调用，不用 agent 循环。** 引擎负责准备本人身份、整段对话、chat 绑定的项目、项目列表、相关记忆，以及该 chat 最近的分拣决定；模型只输出 `action_proposals`。分拣不加载技能和 Soul 全文。
5. **项目归属由引擎先决定。** chat 已绑定项目（`event.project_id`）的，直接沿用；未绑定的，模型从项目列表里选，并沿用 `require_project_confirmation`。

**授权：** 原稿认为"现有来源授权已经满足要求，不改"，核对代码后不成立（TD-3 第 2 节）：来源授权只覆盖 4 种动作，其他低风险动作从外部来源来也会自动执行；allowlist 没有可配置的存储；执行时的策略从动作 payload 读取。因此改为：

1. **放权规则表是 Inbox 动作授权的唯一依据**（TD-3）。类别 = 动作 + 来源 + 会话 / 人 / 来源 + 起因；默认问用户；只有用户的操作能写入（审批时"以后同类自动"、连续批准 N 次后的提示被采纳、授权页手动修改）；驳回或标记"做错了"即退回问用户。Inbox 提案执行时忽略 payload 里的一切授权字段。审批历史只产生计数和提示，记忆不参与授权。
2. **第一版不代用户自动发送外部消息**（2026-10-31 定）。`message.reply_send` 固定为问用户；先以影子评测积累准确率（TD-1 第 10.4 节），以后再另行设计放开条件。
3. **放权规则在记忆页呈现**（2026-10-31 定）：每条放开或禁止的规则同步为一条受管记忆，可在记忆页撤销；方向单向（规则 → 记忆），撤销经规则接口（TD-3 第 8 节、TD-4 第 9 节）。
4. **新增 `source_inferred` memory authority**（TD-4）。从 Inbox 推断出的记忆写成 `source_inferred`，不经审批写入（单段、每日有上限），只能使用人、项目、约定、情景四种 kind，检索时单独标注，不能覆盖 `user_explicit`，不能升级为指令或授权；用户在记忆页确认后才转成 `user_explicit`。它与现有的 `advisory`（迁移遗留的未分类记录）分开，不合并。

### 2.6 提醒与日历

- 提醒复用 `reminder.create`，触达复用通知 outbox 和对话入口。
- 日历是来源插件的能力：读日历走 `source`；建会议、接受邀请走 `send`，一律经提案和 Action Gate，且永远需要确认。

### 2.7 来自 Inbox 的 issue 完成后回复来源

由 Inbox 消息建出的 issue 记住来源会话和原消息。issue 完成（或进入需要对方补充信息的 Attention）时，引擎复用 `issue_completion_watch` 生成一条 `message.reply_draft`，回到原会话；内容取自 Handoff 摘要，不附代码和内部日志。是否自动发出，走 2.5 的来源授权，和其他代回复同一套 allowlist。这是工程流程的一部分，由引擎实现，不依赖 skill。

### 2.8 公开仓库与私有数据

公开仓库放通用机制和官方插件。用户的插件设置、本人身份、分拣规则、Soul、记忆都在数据目录，不进仓库。

## 3. 先改造玄武：吸收朱雀的五块

以下五块以朱雀的页面和设计为准改造玄武现有实现。每块单独立 issue；改变公开 contract 或 schema 的，按 ADR-XW-0001 第 6.2 节写明 source of truth、兼容窗、回滚和删除门禁，**不允许新旧两套并存而无人负责**。

| 块 | 朱雀的设计 | 玄武现状 | 改造方向 / 要先定的冲突 |
| --- | --- | --- | --- |
| 插件中心 | 官方目录、安装、设置、授权、随时启停；stream / poll；self / history / send / setup 协议 | 工具式 CLI connector manifest；飞书、GitHub 各有独立设置面板 | 按 2.4 扩 manifest、建统一插件中心；原生 channel（对话入口）不迁。飞书拆分：机器人留在原生 channel，"以用户本人身份读写飞书消息"做成插件 `feishu-user`（TD-2） |
| 记忆 | 事实 / 情景 / 程序三层；每条带来源（user / inferred）和置信度；可导出 markdown；从 Codex、Claude Code 导入时先列候选逐条筛选，像密钥的拦下 | `pi/memory/`：authority（`user_explicit` / `evidence_backed`）、scope、revision、反思队列；记忆面板 | 保留玄武的 authority / scope / revision 作为存储真值，补 `source_inferred`（2.5）；页面、分层展示、导入筛选流程迁自朱雀 |
| Soul | 一份用户亲手写的 `soul.md`，网页编辑；人格和偏好归它，规则和授权不归它；拼在各会话固定规则之后 | `PiPersona` 四个结构化字段，只影响最终回复的措辞 | **已定：Soul 替代 persona**（理由：persona 只能调措辞，表达不了用户是谁、在意什么、怎么做事，Pi 显得死板）。迁移时把现有 persona 的四个字段转写成 Soul 初稿；`language_mode` 这类需要确定性执行的设置留在系统设置，不进 Soul。保持「改变不了工具、风险、授权、状态真值和完成标准」的合同；分拣只用其中的称呼与偏好摘要，不注入全文。persona 的表、接口和面板按 ADR-XW-0001 第 6.2 节的删除门禁退役 |
| 模型与登录 | 凭据自己保管；网页上用 Pi SDK 各家 provider 的 OAuth / API Key 登录；可从本机 Pi 导入；换模型不写回 Pi 设置 | `credential_source` 只有 `stored` 和复用 Codex 登录 | 迁朱雀的多 provider 登录页面和流程；按用途分模型（对话、分拣、记忆整理）沿用玄武 `model_policy` |
| 技能 | **只要知识型**：只拷文字文件，只经 `skill_read` 读，不能执行；按需读取，不把列表全塞进提示词 | ADR-XW-0058 可执行 Skill Runtime（allowlisted handler + capability gateway）与技能库 | **暂定两类并存**，分开命名、分开展示：知识型 skill 用朱雀的导入和页面，只能读；可执行 skill 保持 0058 的门禁。分拣和对话都只注入当前相关的技能，不注入全量列表。长期是否合并成一类，等阶段 A 用过之后再定 |
| 分拣规则 | 用户手写 `triage-rules.md`，只给分拣看；审批时"这是闲聊"一键追加 | 无（只有结构化的来源策略） | **沿用朱雀**（2026-10-31 定），存数据目录（TD-1 第 8 节） |
| 联系我 | 经插件主动找用户、待决汇总、IM 里"批准 12 / 以后自动"、回声过滤、每日上限 | 机器人 channel 能对话、卡片审批；外发目标靠链接反推，无固定联系渠道，无文本指令 | **迁入**（2026-10-31 定），优先用原生 channel，也支持指定插件会话（TD-6） |
| 作息 / 值守 / 早晚报 | 用户级上下班；下班攒着不打扰；引擎取事实、Pi 写简报 | 项目级静默时段；项目通知日报 | **迁入**（2026-10-31 定）（TD-6） |

**不迁的部分**（2026-10-31 定）：成员与路由、经 OCS 派活（`dispatch.ts`、`ocs.ts`）——工程活完全由玄武 issue 驱动；管任务的 Pi（`steward.ts`）——用玄武现有的 Pi 与 issue supervisor。朱雀里"原文随任务保存"的做法并入 Inbox 建 issue 的流程（TD-1 第 7.3 节）。

## 4. 影响分析

| 维度 | 影响 |
| --- | --- |
| 权限 | 不新增自动执行的路径；新增的自动行为只有 `source_inferred` 记忆写入，且不参与授权 |
| 审计 | 全部经 `action_proposals` / `pi_action_events`；插件启停、会话三档变更、放权建议及其采纳都要落审计 |
| 数据 | `pi_memory_items.authority` 新增 `source_inferred`（与现有 `advisory` 分开），新增 `expires_at`、`managed_by` 列；`external_events` 新增 `inbox_chat_id`、`sender_key`、`is_self`、`inbox_status`、`inbox_decision_id` 列；新表 `inbox_chats`、`inbox_people`、`inbox_triage_runs`、`inbox_decisions`、`inbox_reply_shadow`、`source_plugins`、`pi_autonomy_rules`、`pi_contact_refs`、`pi_briefs`、`pi_soul`、`pi_memory_import_candidates` |
| 公开 contract / schema | memory authority 枚举扩展；connector manifest 新增 `source` 能力；connector 事件合同（ADR-XW-0064）新增字段；persona → Soul、技能分类、模型凭据来源扩展，各自需要迁移和回滚方案 |
| 迁移 | 朱雀数据不迁入：它的 25 条记忆全是推断出来的，且掺有身份混淆。只迁代码与设计（插件、页面、流程）、分拣规则文本和身份配置 |

## 5. 实施顺序与门禁

**阶段 A：改造玄武（第 3 节），不改变 Inbox 行为。**

1. 插件中心与 manifest `source` 能力；迁入钉钉、飞书、Gmail、jsonl-file 插件，先只收不分拣。
2. 模型与登录、Soul、技能（先定技能分类的冲突）、记忆页面与导入。

**阶段 B：Inbox 管理域（第 2 节）。**

3. 修复 context bundle 跨会话混入；加上 `is_self` 与本人身份；会话三档。
4. 常驻 intake、chat 级静默窗、单次结构化分拣，只出草稿（`action_mode=draft_only`）。
5. 用 jsonl-file 插件在朱雀已有的两天数据上离线回放，比较错误任务数、重复任务数和 token；达到以下标准才继续：不再出现针对用户本人的错误任务，项目归属错误为 0。
6. `source_inferred` memory 与放权建议。
7. 提醒；issue 完成后回复来源（2.7）；日历。

阶段 A 的第 1 步和阶段 B 的第 3 步互不依赖，可以并行。每一步都按 ADR-XW-0088 的状态合同标注 `preview / not live-tested` 或 `tested`。

## 6. 待决

- [x] Soul 与 `PiPersona`：Soul 替代 persona（2026-10-31 定）。
- [x] 技能：先让知识型与可执行两类并存（2026-10-31 定）；长期是否合并成一类待定。
- [x] 逐步放权：放权规则表，在记忆页呈现；第一版不自动代发外部消息（2026-10-31 定）。
- [x] 插件宿主：中心与钉钉 `dws` 都在 Mac mini 上，钉钉插件在中心本机运行；远程节点宿主推后（2026-10-31 定）。
- [ ] 静默窗的默认值与上限，以第 5 节第 5 步的回放数据为准。
- [x] 联系我渠道：已配置的飞书机器人或 Telegram（2026-10-31 定，TD-6 第 10 节）。
- [x] 主导航新页面名称："消息"（2026-10-31 定，TD-5 第 11 节）。
- [ ] 朱雀仓库是归档还是删除。

## 7. 技术设计

| 文档 | 内容 |
| --- | --- |
| [TD-0](0098-td0-zhuque-gap-inventory.md) | 朱雀 → 玄武差距盘点 |
| [TD-1](0098-td1-inbox-domain-and-triage.md) | Inbox 领域模型与分拣（含回放评测、影子评测） |
| [TD-2](0098-td2-source-plugin-runtime.md) | 来源插件运行时与合同 |
| [TD-3](0098-td3-autonomy-rules.md) | Inbox 授权与逐步放权 |
| [TD-4](0098-td4-memory-authority.md) | 记忆的权威等级与 Inbox 推断记忆 |
| [TD-5](0098-td5-pages.md) | 页面：消息、插件中心与相关设置 |
| [TD-6](0098-td6-contact-schedule-briefs.md) | 联系我、用户作息、值守与早晚报 |
| [TD-7](0098-td7-soul.md) | Soul 替代 persona |
| [TD-8](0098-td8-models-and-skills.md) | 模型与登录；知识型与可执行技能并存 |
| [TD-9](0098-td9-memory-page-and-import.md) | 记忆页面与导入 |
