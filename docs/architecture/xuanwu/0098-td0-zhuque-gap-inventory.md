# TD-0：朱雀 → 玄武差距盘点

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098
- 用途：后续技术设计（TD-1 起）的共同输入。逐个模块、页面、插件说明朱雀的实现在玄武里对应什么，结论是**复用 / 改造 / 新建 / 不要**，以及由哪份 TD 负责。
- 盘点基准：朱雀 `~/Documents/xiaobei/zhuque`（`src/` 23 个模块约 8.1k 行，`plugins/` 4 个，`web/src/pages` 14 页，`DESIGN.md` v0.1）；玄武 `main@49fc931d`。
- 标注：**[已核]** 表示读过代码确认；**[待核]** 表示只看了文件名或注释，需要在对应 TD 里确认。

## 1. 已定的方向（2026-10-31 用户确认）

| # | 问题 | 结论 | 影响 |
| --- | --- | --- | --- |
| D1 | 成员与路由 | 工程活完全由玄武 issue 驱动；不再经 OCS 派给在线会话 | 朱雀 `dispatch.ts` / `ocs.ts` / 路由表不迁 |
| D2 | 管任务的 Pi（steward） | 用玄武的 Pi，不另起一个 steward 会话 | `steward.ts` 不迁；它的有用部分（原文入任务、从用户修正里学派活方法）并入 issue 创建与 supervisor |
| D3 | 联系我 | 玄武已有主动发 IM，需核对限制条件（见 5.4） | TD-6 |
| D4 | 上下班、值守、早晚报 | 三项都要 | TD-6 |
| D5 | 分拣规则 | 沿用朱雀的 `triage-rules.md` 机制 | TD-1 |
| D6 | 逐步放权 | 采用放权规则表：只有用户的审批操作能写入，在记忆页呈现、可撤销（第 6 节）。**第一版不开放代用户自动发送外部消息**：`message.reply_send` 一律等用户确认，先做"影子评测"积累准确率证据（第 6.1 节） | TD-3 |

## 2. 后端模块对照

| 朱雀模块 | 行数 | 职责 | 玄武对应 | 结论 | 归属 |
| --- | --- | --- | --- | --- | --- |
| `sources.ts` | 881 | 信息源池：插件协议（JSONL、cursor、`replyTo`/`owner`/`self`）、去重、预过滤、攒批与静默窗（`quietSec`，最多等 5 倍） | `external_events` + `pi/intake/cliRawEventSync.ts`、`manualSourcePull.ts`、`cliConnectorProvider.ts`（工具式按需拉） | **改造**：玄武没有常驻采集、没有会话（chat）实体、没有会话级分拣状态 | TD-1、TD-2 |
| `plugins.ts` | 497 | 插件中心：目录、安装、`setup`、依赖检测、`auth.check/login`、设置（走环境变量）、启停 | `pi/intake/cliConnectorManifest.ts`、`cliConnectorHealth.ts`、`integrations/connectorDiagnostics*` | **改造**：manifest 扩 `source` 能力；插件进程管理新建 | TD-2 |
| `triage.ts` | 622 | 分拣：每批一个新的内存 Pi 会话，agent 循环，工具 `memory_search` / `memory_note` / `task_propose` / `conversation_context` | `pi/intake/llmIntake.ts`（单次结构化调用）、`contextBundleBuilder.ts`、`eventRouter.ts` | **改造**：保留玄武的单次结构化形状；上下文改为引擎按 chat 准备（ADR 1.1 的证据） | TD-1 |
| `triage-rules.ts` | 71 | 用户手写的 `triage-rules.md`，只给分拣看；审批时"这是闲聊"会追加一行 | 无；最近的是 `intakeSourcePolicy.ts`（结构化策略，不是自由文本规则） | **新建**（D5），存数据目录 | TD-1 |
| `classifier.ts` | 191 | Jev 预分类（off / shadow / skip），按会话分组 | `skills/jev/`（ADR-XW-0097，可选 Jev skill，MCP 形式） | **复用** 0097 的凭据与调用；在 TD-1 里决定是否作为分拣前置 | TD-1 |
| `policy.ts` | 369 | 授权：类别 = 动作 + 对象 + 来源；ask/auto/deny；连续批准 N 次提示放开；"批准，以后同类自动"；驳回或"做错了"退回；敏感词兜底；每日自动上限；总开关 | `pi/actions/actionGate.ts`、`actionEngine.ts`、`sourcePermissionPolicy.ts`（按来源的 `auto_reply_enabled` + chat/person allowlist）、`approvalGrantScope.ts`（只有 turn/session 两档） | **改造**：玄武没有"同类以后自动"、没有做错回退、没有每日自动上限 | TD-3（见第 6 节） |
| `engine.ts` | 328 | 动作执行：`task.create` / `room.post` / `task.close` / `message.send` / `user.notify`；每条消息最多回 2 次 | `action_proposals` + `http/pi/piActionProposalExecution.ts`、`piActionDispatch*` | **复用**；`room.post` / `task.close` 由 issue 流程替代（D1） | TD-3 |
| `tasks.ts` / `task-tools.ts` | 257 / 103 | 任务（接手人、原文、来源） | issue + `pi/issues/*` + Pi issue 工具 | **复用 issue**；补"由 Inbox 消息建出"的来源链接 | TD-1 |
| `dispatch.ts` / `ocs.ts` | 554 / 123 | 经 OCS 派活、room、令牌、对账 | runner / providers | **不要**（D1） | — |
| `steward.ts` | 324 | 管任务的 Pi：派前附注、核对复述、审回报、巡查卡住、从修正里学 | `pi/supervisor/*`（issue supervisor）、`pi/guardian/*`、`issueCompletionAutomation.ts` | **不要**（D2）；"原文随 issue 保存"和"学派活方法记成程序记忆"两点并入 | TD-1、TD-4 |
| `contact.ts` | 175 | 联系我：经插件主动找你、30 秒汇总、IM 里"批准 12 / 以后自动"、IM 里跟 Pi 对话、回声过滤、每日上限、下班攒着 | `notifications/unifiedNotificationPipeline*`、`agentCommunicationGateway*`、`integrations/im/*`、飞书卡片审批、Telegram callback | **改造**，见 5.4 | TD-6 |
| `schedule.ts` | 124 | 上下班、值守、早晚报触发 | `project_pi_policies.working_hours_json / quiet_hours_json`（按项目）、`schedule/cronSchedule.ts`、`pi/heartbeat/*` | **改造**：玄武只有项目级作息，没有用户级 | TD-6 |
| `brief.ts` | 202 | 早晚报：引擎取事实、Pi 只写、没模型时发事实清单 | `notifications/dailyDigest.ts`、`pi/notifications/digest*`、`pi/reports/*`、`guardianOperationsDailyReport.ts` | **改造**：玄武的 digest 以通知 intent 为单位，不含 Inbox 事实 | TD-6 |
| `memory.ts` | 159 | 三层（fact / episode / procedure）+ 来源（user / inferred）+ 置信度；中文二元组检索 | `pi/memory/*`、`pi_memory_items`：authority（`advisory` / `user_explicit` / `evidence_backed`）、scope、revision、反思队列 | **玄武为存储真值**；补 kind 维度与 `source_inferred` | TD-4 |
| `memory-tools.ts` | 94 | `memory_search` / `memory_note`（分拣固定 inferred） | `pi/memory/memoryTools.ts` | **复用** | TD-4 |
| `memory-import.ts` | 430 | 从 Codex / Claude Code 导入：候选、逐条筛、像密钥的拦下、源更新后回到待筛选 | 无（只有 `codexImportPreview.js` 针对配置） | **新建** | TD-9 |
| `soul.ts` | 94 | `soul.md`，拼在各会话固定规则之后 | `pi/runtime/personaPrompt.ts`、`PiPersona` 四字段、`PersonaSettingsPanel.jsx` | **替代**（ADR 已定） | TD-7 |
| `models.ts` | 342 | 多 provider OAuth / API Key、从本机 Pi 导入、换模型不写回 | `pi/runtime/piModelRuntime.ts`（`credential_source = stored | codex_login`）、`PiProviderConnectionFlow.jsx`（API Key / OAuth / 复用 Codex） | **改造** | TD-8 |
| `skills.ts` | 356 | 知识型 skill：只拷文字、`skill_read`、启停、导入 | `skills/libraryService.ts`、`managedStore.ts`（技能库）、`skills/runtime*`（0058 可执行） | **改造**：两类并存（ADR 已定） | TD-8 |
| `agent.ts` | 341 | Pi SDK 会话装配 | `http/pi/piRuntime.ts` `createPiRuntimeSession`、`pi/runtime/*` | **复用玄武**（D2） | — |
| `settings.ts` / `config.ts` | 242 / 100 | 系统设置、路由表 | 玄武设置 + 项目 | 路由表**不要**；作息、联系我设置进 TD-6 | TD-6 |
| `triage-debug.ts` | 69 | 分拣调试（看提示词与结果） | `piChatDiagnostics`（对话侧） | **新建**，与回放评测合并 | TD-1 |
| `server.ts` / `cli.ts` | 779 / 280 | HTTP、CLI | 玄武 HTTP / CLI | 不迁，按需加接口 | — |

## 3. 插件对照

| 朱雀插件 | 模式 | 能力 | 玄武现状 | 结论 |
| --- | --- | --- | --- | --- |
| `dingtalk` | stream（`dws` 个人事件长连接） | read、send、history；设置含 `DWS_SELF_ID`、"联系我"会话 | 无 | **迁入**，第一个跑通的官方插件 |
| `feishu` | 机器人长连接 + 本人身份定时拉（`lark-cli`） | read、send（机器人 / 本人两条路，授权键分开）、history | `integrations/feishu/*`：机器人 = 对话入口（ADR-0064 channel），另有 `feishuIntakeBridge.ts`、`feishuSourceDiscovery.ts` | **拆分**：机器人那条留在原生 channel；本人身份读写做成插件 |
| `gmail` | poll（Gmail API + 回环 OAuth/PKCE） | read、send（按发件人授权，原线程回） | 无 | **迁入** |
| `jsonl-file` | poll | read | `fixtureCliE2e` 有类似夹具 | **迁入**，作为回放与测试的标准来源 |

朱雀 `data-export-20261031-202325/` 里有两天的表导出与会话，作为 TD-1 回放评测的数据。

## 4. 页面对照

| 朱雀页面 | 玄武现有 | 结论 | 归属 |
| --- | --- | --- | --- |
| Plugins（插件中心） | `IntegrationConnectionList`、`FeishuSettingsPanel`、`GitHubSettingsPanel`、`TelegramSettingsPanel`、`ConnectorDiagnosticsPanel`、`SourcePoliciesPanel` | 统一成插件中心；原生 channel 面板保留在"对话入口" | TD-5 |
| Inbox（收件箱） | `piAttentionInboxApi`（Attention） | 新建 Inbox 页（按会话看消息与分拣结论），与 Attention 的关系在 TD-1 定 | TD-1、TD-5 |
| TriageDebug | 无 | 新建，与回放合并 | TD-1 |
| Autonomy（授权与动作） | `PermissionsSettingsPanel`、`ActivityTimelinePanel`、动作审批 | 改造 | TD-3 |
| Memory / ImportMemory | `PiMemoryPanel` | 以朱雀为准改造 | TD-9 |
| Soul | `PersonaSettingsPanel` | 替代 | TD-7 |
| Models | `PiProviderConnection*`、`PiAgentSettingsPanel` | 改造 | TD-8 |
| Skills | `SkillLibraryPanel`、`SkillsRuntimePanel`、`JevSkillSettings` | 两类分开展示 | TD-8 |
| Settings（作息、联系我） | `NotificationSettingsPanel`、项目策略 | 改造 | TD-6 |
| Dashboard（含简报） | `Dashboard` | 加简报卡片 | TD-6 |
| Chat | `PiChat` | 复用玄武 | — |
| Tasks / Agents | WorkBoard、Projects | 不迁（D1） | — |

所有页面改动遵守 `docs/design-system/`，朱雀只提供信息架构和交互流程，不带入它的视觉。

## 5. 重点差距

### 5.1 消息与会话的模型 [已核]

- 玄武以**单条外部事件**为锚点：`eventRouter.routeRawEventToIntake` 接一条事件，`contextBundleBuilder` 围绕锚点在时间窗内挑上下文。
- `contextBundleBuilder.ts:104`：锚点没有 thread 时 `isRelated` 直接返回 `true`，同一来源、时间窗内所有会话都会混进上下文。
- 没有 chat 实体：`chat_id` 只出现在 `normalized_message_json` 里，没有"这个会话分拣到哪了、上次结论是什么、绑定哪个项目、属于三档里的哪一档"的持久状态。
- 没有 `is_self`：intake 这一侧完全没有本人身份；`is_self` 只出现在 telegram 和 IM 合同里，用于对话入口。
- 朱雀以 `conversationKey = source + channel + sender` 攒批，这正是 ADR 1.1 里"一来一回被拆开"的根因。玄武要做的是以 chat（或 thread）为单位，而不是照搬朱雀的 key。

**TD-1 要解决**：chat 实体与状态表、本人身份、会话级分拣游标、静默窗状态机、context bundle 按 chat 组装。

### 5.2 采集方式 [已核]

- 玄武的 CLI connector 是工具式的：Pi 或手动触发时调用命令拉数据（`manualSourcePull.ts`、`cliConnectorToolCall.ts`）。
- 朱雀是常驻的：stream 插件长连接、poll 插件定时拉，游标由宿主保存，崩溃重启。
- 玄武需要一个**插件进程管理器**（启动、重启退避、stopGrace、日志、健康），这是全新的运行时组件。和 ADR-0076 诊断、ADR-0064 channel 生命周期的关系在 TD-2 定。

### 5.3 授权粒度 [已核]

- 玄武 `sourcePermissionPolicy.ts` 按来源配置 `auto_reply_enabled`，自动回复要求命中 `allowed_chats` / `allowed_people`；`approvalGrantScope.ts` 的放权只有 turn / session 两档，而且 session grant 对 provider 默认禁用。
- 朱雀的类别是动作 + 对象 + 来源（如 `message.send:dingtalk/chat-x@external`），默认 ask，可以放开成 auto，也能一键收回。
- 差距：玄武没有"以后同类自动"、没有"做错了"回退、没有每日自动动作上限、没有总开关。

### 5.4 主动发 IM（联系我）[已核，部分待核]

玄武现状：

1. **只走机器人身份的原生 channel**（飞书应用机器人、Telegram），不能用用户本人账号发。
2. **每条外发都是一个 notification intent**（`pi_notification_intents`），经 `unifiedNotificationPipeline` 统一路由、去重、经 `sync_outbox` 投递。
3. **发给谁靠已有链接反推**：`imNotificationTargets.resolveImNotificationTarget` 按 issue → conversation → project 找 `external_links` 里关联过的外部事件，用它的 chat / thread 当目标。飞书没找到时退回 `defaultChatId` / `defaultUserId`（`feishuNotificationTargets.feishuFallbackTargetForProject`）。也就是说，没有固定的"联系我"会话概念。
4. **每条外发都先过一个"通知 Agent"**（`agentCommunicationGateway.decision.ts`）：LLM 决定 send 或 suppress 并重写措辞；`requires_user=1` 时必须发。
5. **免打扰按项目**：`project_pi_policies.quiet_hours_json`，安静时段内聚合，结束后发（`quietResumeAt`）。没有用户级作息。
6. **IM 内审批**：飞书卡片按钮（`feishuPiActionCards`）、Telegram callback（`telegramCallbackCodec`），都经 `imApprovalResolve` 校验回调令牌。没有朱雀那种文本"批准 12 / 以后自动"。
7. 没有找到全局每日外发上限 [待核]。
8. Pi 没有自由发起的"找你"动作，只有 `piNeedsUserAction` 一类的升级通知 [待核细节]。

结论：机制（intent → outbox → channel）可以复用；要补的是固定的"联系我"目标、用户级作息、待决事项汇总、IM 内文本指令（批准 / 驳回 / 以后自动）、每日上限，以及 Pi 主动"找你"的动作。朱雀用钉钉本人账号的"自己建群"当联系我会话；在玄武里更自然的是优先用机器人 channel，插件 send 作为备选。TD-6 定。

### 5.5 作息与简报 [已核]

- 玄武作息挂在项目上（`working_hours_json`、`quiet_hours_json`），用于 heartbeat 和通知聚合；`dailyDigest.ts` 默认 09:00 按项目汇总通知 intent。
- 朱雀作息是用户级的：上下班切换整个系统的行为（下班不替你回别人、攒着找你的话、每小时巡查卡住的活），早晚报的事实来自动作日志、任务和收件箱。
- 差距：用户级作息；值守模式对授权的影响（下班时已放开的回复也改成等你决定）；简报事实源加入 Inbox 与动作日志。

### 5.6 记忆 [已核]

- 玄武 authority 已有三个取值：`advisory`（只是提示）、`user_explicit`、`evidence_backed`（`memoryItemsModel.ts:14`）；提示词里明写"没有任何记忆对权限有权威"（`memoryContext.ts:116`）。
- `memoryTools.ts:168`：除了 manager cycle 和 reflection，Pi 写入的记忆一律记成 `user_explicit`。这正是 ADR 2.5 说要改的地方。
- 朱雀有 kind（fact / episode / procedure），玄武没有对应维度。
- ADR 要新增的 `source_inferred` 和现有 `advisory` 语义接近，TD-4 必须先说明两者关系（合并，还是 `advisory` 表示弱权威、`source_inferred` 表示来自外部）。

### 5.7 派活（D1、D2 之后）

朱雀经 OCS 派活这一层整体不要。保留两个产品点，落到 issue：

1. **原文随 issue 保存**：Inbox 建出的 issue 带原消息与会话链接（`external_links` 已有 issue ↔ event 的关系，可复用），worker 看原文，不只看 Pi 的转述。
2. **从用户修正里学**：用户改了 Pi 写的 issue 描述，差异记成 procedure 类记忆。TD-4 决定是否做。

## 6. 需要再定：D6"通过记忆逐步放权"

朱雀 DESIGN 3.4 和 ADR-0098 2.5 都明确：**放权只看用户的审批记录，记忆不参与**。原因是推断记忆可能来自外部消息，拿它扩权等于让外部消息给自己授权，是一条提示注入路径。玄武现有提示词也写着"没有任何记忆对权限有权威"。

我理解你要的体验是"批过几次，同类以后自动；而且能在一个地方看到、管理这些放权"。这可以做到，但不应该让记忆成为授权依据。建议：

- **授权真值**：一张放权规则表（类别 = 动作 + 来源插件 + 会话或人 + 来源 user/external），只能由用户的审批操作写入："批准，以后同类自动"，或连续批准 N 次后点"放开"。Pi、分拣、`source_inferred` 记忆都写不了。
- **在记忆系统里呈现**：每条放权规则在记忆页里显示成一条 `user_explicit` 的 procedure 记忆（例如"张三在项目群里问进度，可以直接回"），可以在记忆页撤销。撤销会同步改规则表。分拣时这些记忆作为上下文给模型看，让它知道哪些会自动执行。
- **方向是单向的**：规则表 → 记忆展示。记忆 → 规则表只能由用户在页面上确认。

两种做法的区别：

| | 记忆直接当授权 | 规则表为真值，记忆只负责展示和管理（建议） |
| --- | --- | --- |
| 用户体验 | 同类自动 | 同类自动，记忆页可见、可撤销 |
| 提示注入时 | 外部消息诱导写入推断记忆，就可能扩权 | 只有用户点击能扩权 |
| 与 ADR 2.5 | 冲突，需改 ADR | 一致，只需补充"在记忆页呈现" |

2026-10-31 用户确认采用规则表方案。

### 6.1 代回复：第一版不自动发送

担心回错，第一版对外部消息的回复只做到草稿：

1. **草稿 + 一键发送**：分拣给出回复草稿，用户可以原样发、改了再发，或丢弃。发送仍然经 Action Gate，由用户点击触发。
2. **影子评测**：朱雀数据里，113 条他人消息中有 51 条在 15 分钟内被用户亲自回复。对这类消息，Pi 照样起草但不展示打扰；用户自己回复后，把草稿和真实回复对比（要不要回、意图是否一致、事实是否冲突），按"来源 + 会话 / 人 + 消息类型"积累命中率。草稿被原样发送、小改、大改、丢弃，同样计入。
3. **放开门槛（以后再定，不在第一版）**：某一类的命中率连续达标后，才在 Attention 里建议放开；放开时附带延迟发送（发出前留撤回窗口并通知用户）、每日上限、下班自动收回。

规则表在第一版仍然要建，用于其他低风险动作（提醒、triage issue、`source_inferred` 记忆写入上限之外的确认等），`message.reply_send` 的类别在规则表里固定为 ask。

## 7. ADR-0098 需要修订的点

（2026-10-31 已全部写入 ADR-0098 第 2.5、3、4、6、7 节。）

1. 第 3 节"吸收五块"补上：分拣规则（D5）、联系我（D3）、作息 / 值守 / 简报（D4）；写明不迁的部分：成员路由、OCS 派活、steward（D1、D2）。
2. 第 2.5 节补充 D6 的结论。
3. 第 2.5 节第 1 条"本人回复后，之前未分拣的消息视为已处理"太宽，交给 TD-1 用回放数据决定。
4. 第 4 节"数据"一行：`pi_memory_items.authority` 新增取值之前先说明和 `advisory` 的关系。
5. 飞书拆分：机器人留在原生 channel，本人身份读写进插件（第 3 节表格已隐含，写明）。

## 8. 后续 TD 清单（据本盘点调整）

| TD | 主题 | 主要输入 | 依赖 |
| --- | --- | --- | --- |
| TD-1 | Inbox 领域模型与分拣：chat 实体、本人身份、会话三档、静默窗、按 chat 组装 context、单次结构化分拣、分拣规则、Jev 前置、Inbox 与 Attention 的关系、回放评测 | 5.1、5.7、`triage.ts`、`triage-rules.ts`、`classifier.ts` | — |
| TD-2 | 来源插件运行时与合同：manifest `source` 能力、进程管理、标准事件、history / send 幂等、与 CLI connector 和原生 channel 的边界 | 5.2、第 3 节 | TD-1 |
| TD-3 | 授权与逐步放权：放权规则表、会话 / 人粒度、做错回退、每日上限、总开关、值守模式对授权的影响、在记忆页呈现（D6） | 5.3、第 6 节 | TD-1 |
| TD-4 | 记忆 authority 与 kind：`source_inferred` 与 `advisory`、fact / episode / procedure、写入上限、确认流程 | 5.6 | TD-1 |
| TD-5 | 插件中心与 Inbox 页面 | 第 4 节 | TD-2、TD-3 |
| TD-6 | 联系我、用户级作息、值守、早晚报 | 5.4、5.5 | TD-3 |
| TD-7 | Soul 替代 persona | — | 独立 |
| TD-8 | 模型与登录；知识型与可执行技能并存 | — | 独立 |
| TD-9 | 记忆页面与导入 | `memory-import.ts` | TD-4 |
