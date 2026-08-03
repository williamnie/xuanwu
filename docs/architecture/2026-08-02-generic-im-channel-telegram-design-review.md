# Review 意见：通用 IM Channel 底座与 Telegram 接入设计

> 状态：Review，基于 `2026-08-02-generic-im-channel-telegram-design.md`（Draft）的评审意见；不修改原文档
>
> 日期：2026-08-02
>
> 方法：对原文档引用的既有事实（§2.1、§8、§13）逐一对照代码（`channelConnectorContracts.ts`、`feishuChannelConnector.ts`、`feishuAgentBridge.ts`、`imReplyOutboxDispatcher.ts`、`notificationOutbox.ts`、`imReplyOutboxDispatch.ts`、schema 021/022/023/024/026/043、`feishuConversationRouting.ts`、`feishuProjectContext.ts`），并对照 Telegram Bot API 官方约束。

## 1. 总评

设计整体质量高：以已落地的 P09.01 / 0075 / 0076 / 0077 为锚点，双读双写纪律、回滚门禁、W0/W1/W2 分层和 §18 决策项都是对仓库既有 ADR 风格的延续。**文档中的"已有事实"大部分与代码一致**（见 §2），不存在方向性错误。以下是按严重程度排序的意见：1 个 P0（sender 路径二义性）、1 个待修正后定级的批量不变量（P0-1，初版误判已更正）、8 个 P1（实现前必须写清楚契约）、若干 P2（协议层与工程层补充）。Telegram 侧最大的缺口集中在 **Bot API 的 callback 与批量确认语义**，通用侧最大的缺口是 **sender 入口三重性**。

## 2. 已核实的设计前提（与代码对照）

| 文档声称 | 代码证据 | 结论 |
| --- | --- | --- |
| `sync_outbox` 已有 `provider_request_ref`/`result_json`/`correlation_id`/`payload_json` | `schema/043_tracker_update_outbox.ts` 的 `addColumn` 目标是 `sync_outbox` | ✅ 属实。**但**：这些列由 tracker 场景引入，`im_reply` 行从未写入过，语义契约需按 `operation_kind` 区分（见 P1-8） |
| `external_events` 支持 `provider`/`normalized_message_json`/`dedupe_key`/`raw_json` | `schema/021_external_events.ts` | ✅ 属实 |
| `notificationOutbox.ts` 已有 channel-neutral sender + fixture dispatcher，生产未 cutover | `notificationOutbox.dispatchNotificationOutbox` 存在；生产由 `pi/imReplyOutboxDispatcher.dispatchFeishuOutbox` 承担（`piAutoManageScheduler`/`imReplyOutboxApi`/`feishuNotifications` 调用） | ✅ 属实 |
| `feishu_message_id` 被 claim、preflight、context、watchdog 消费 | `imReplyOutboxDispatch.ts`：`listDispatchableSyncOutbox` WHERE `feishu_message_id=''`、`deliveryPolicyError` 判空；`feishuConversationContext`/`guardianWatchdog` 读取 | ✅ 属实。**A4 必须把这些 SQL/判断全部换到 `provider_request_ref`**，原文档 §8.2 未逐点列出（见 P1-10） |
| `feishu_conversation_state` 的 `active_project_id` 可安全不迁移 | `feishuConversationRouting.ts` 只在 legacy adoption 时读取后原样写回；`routeFeishuConversation` 输出不含 project；`feishuAgentBridge` 的项目解析走 config mapping + one-shot，不读 state 表 | ✅ 判断正确。建议补一条 consumer-scan 回归（查询确认无 writer 依赖该字段）再物理停写 |
| `feishu_project_selections`（026）与 `im_project_selections` 草案映射合理 | `schema/026_feishu_project_selection.ts` 字段集与 §13.2 草案一一对应 | ✅ 属实 |

## 3. P0：必须修正

### P0-1. 批量处理不变量必须写清（修正版：逐条事务安全，危险的是"跳过未 durable 的 update"）

> 修正说明：本文档初版误判 Telegram 确认语义（"update 出现在响应中即确认"）。按官方文档，**确认发生在下次调用 `getUpdates` 且 `offset` 高于其 `update_id` 时**（"An update is considered confirmed as soon as getUpdates is called with an offset higher than its update_id"）。因此逐条 event+cursor 同事务在崩溃场景下是安全的：
>
> 设 cursor=100，`getUpdates(offset=101)` 返回 101/102/103；处理 101 提交事务（event + cursor=101）后崩溃。重启后 `getUpdates(offset=102)` 只确认 101，102/103 仍会原样重投——**不丢后半批**。

真正会丢消息的模式是：批内 102 发生 transient/DB 故障，实现**继续处理 103 并把 cursor 推到 103**，之后 `getUpdates(offset=104)` 的调用会按 offset 累积确认 102（及其之前全部 update），102 被永久跳过。

因此 §6.2 应把提交粒度写为如下**不变量**（逐条事务即可，不必整批单事务）：

1. 按 `update_id` 升序处理；
2. 每条 event + cursor 同一事务提交（与 §6.1.5 一致）；
3. malformed/确定不可处理（permanent rejection）的 update 记审计后**可以**推进；
4. transient/unknown failure **不推进 cursor**，并立即停止本批后续处理；
5. **永远不能跨过一个未形成 durable 结果的 update**（即 cursor 推进必须是连续的，跳号即永久丢失）；
6. 即使 event 已写而 cursor 提交失败（罕见），重投由 `external_events` 的 `dedupe_key` 兜底去重，不会重复执行 PI——同事务 + dedupe 两者都仍必要。

整批单事务也可行但事务更大、一个临时错误回滚整个批次，不应被定为唯一正确方案。建议在 §15.2 补测试：批内 transient 失败时停止后续处理，重启后未处理 update 重投且不丢；以及"跳过未 durable 的 update 推进 cursor"作为 fail-closed 防护测试。

### P0-2. Sender 三重入口必须收敛为一条

当前代码已有两条发送路径，原设计又引入第三条，且内部自相矛盾：

| 入口 | 现状 |
| --- | --- |
| `NotificationChannelSender.send`（`notificationOutbox.ts`） | fixture dispatcher 用，写 `feishu_message_id` |
| `ChannelConnector.deliver(OutboundEnvelope)`（P09.01 + `feishuChannelConnector`） | 生产 `dispatchFeishuOutbox` 用（`migrateLegacyFeishuOutboxEnvelope` → deliver） |
| `ImChannelSender`（原设计 §5.2 `createSender`） | 原设计新增，未定义与上面两者的关系 |

原文档 §4.1 架构图显示 Dispatcher → Registry → `ChannelConnector.deliver`，但 §8.2 写"从 registry 查 sender"，§5.2 的 module 又同时持有 `connector` 和 `createSender`——实现者无法确定 outbox 到底调谁。

建议：**唯一投递路径 = `ChannelConnector.deliver(OutboundEnvelope)`**（保留 envelope/capability/authorization 校验，这也是 0064 的既有边界）；`ImChannelSender` 降级为 transport 层原语（provider SDK 封装，仅被 module 内部和 `connector.deliver` 调用，不暴露给 dispatcher）；`NotificationChannelSender` 在 A4 cutover 后废弃。并在 A1 中写明每个接口的"谁调用、被谁调用、生命周期归属"，否则会在 A4 出现第二 dispatcher。

## 4. P1：实现前必须写清楚的契约

### P1-3. `callback_data` 的 64 字节硬限制

Telegram inline keyboard 的 `callback_data` 限制 **1–64 字节**。§5.6 的 opaque token 若装 `interaction_id + action_id + revision`，UUID 形式必然超限。建议：canonical `interaction_id` 使用短 token（如 16 字节 hex/Base64url），并在 §5.6 明确 callback_data 的编码预算与超限 fail-closed 规则；§15.4 补一条"callback data 长度边界"测试。

### P1-4. `answerCallbackQuery` 未出现在任何运行链

`callback_query` 到达后若不及时 `answerCallbackQuery`，用户端按钮会一直转圈（约 10 秒后超时显示失败）。异步处理下应"**先 answer 再处理**"，结果通过 `editMessageText`/`sendMessage` 送达。原设计只讲了 binding consume，没讲回执与 UI 反馈。建议在 §11.4/§11.5 补充 answer 语义及失败分类。

### P1-5. interaction consume/过期后的按钮清理

binding 有 `expires_at` 和 consume-once，但 provider 侧没有清理动作：consume 后应 best-effort `editMessageReplyMarkup` 清掉按钮，防止过期交互残留可点、也避免二次点击歧义。建议作为 adapter 的确定性 fallback 之一（失败只记 redacted warning，同 ack 语义）。

### P1-6. 文本 fallback 的 binding 消歧规则未定义

§5.6 说"不支持交互的渠道发送编号文本；用户文本回复仍进入同一个 binding resolver"，但同一 scope 可能同时存在多个 pending binding（多张卡片/多轮选择）。用户回 "2" 到底命中哪个？规则必须明确，例如：

- 只匹配该 scope **最近一个** pending binding；
- 严格格式（整行数字或 `#N`），普通聊天文本不误触发；
- 命中后需要二次确认（或至少在 reply 中回显"你将选择 X，回复确认"）；
- 与正常 PI 消息的裁决顺序（binding 优先还是 conversation 优先）。

### P1-7. 历史 Feishu card 的 callback 兼容窗口

§5.5 说 W1 保留 `card.send` compatibility、新 core 不再生成 card。但**已经发到用户聊天里的历史 card 在 W1 之后仍会被点击**，其 callback payload 是旧格式（`normalizeFeishuPiActionCardAction`/`normalizeFeishuApprovalAction` 期望的旧字段）。W1 切到新 resolver 后这些旧 callback 必须仍能解析。建议在 §10.3 parity gate 显式加一条"历史 card callback 在 cutover 后仍可消费"，并给旧 card 一个过期窗口（到期后提示重发）。

### P1-8. `result_json` 的列级契约（与 tracker 行共用一列）

043 引入的 `payload_json`/`result_json`/`correlation_id`/`provider_request_ref` 是 tracker 语义先行者。切到 IM receipt 后，同一列要承载两种 schema：

- 按 `operation_kind` 区分校验（`im_reply` 行必须过 `xuanwu.im-delivery-receipt.v1` schema，白名单只含 §8.3 列出的字段；tracker 行不受影响）；
- `provider_request_ref` 的 backfill/claim 判断与 tracker 现有使用（如 `trackerUpdateOutbox.ts`）不冲突——需在 §13 补一条显式声明。

### P1-9. draft/outbox 三列 ↔ `ImTargetV1` ↔ target URI 的列映射表

`im_reply_drafts`/`sync_outbox` 是 `target_chat_id`/`target_thread_id`/`target_message_id` 三列，`ImTargetV1` 是 `conversation_id`/`thread_id`/`reply_to_message_id`/`actor_id`，`ImTargetCodec` 又映射到 `feishu://`/`telegram://` URI。这是实现者最容易踩坑的地方，原设计只有口头描述。建议在 §8 补一张显式映射表：

| draft 列 | ImTargetV1 字段 | Feishu URI | Telegram 参数 |
| --- | --- | --- | --- |
| `target_chat_id` | `conversation_id` | `feishu://chat_id/<id>` | `chat_id` |
| `target_thread_id` | `thread_id` | 空（Feishu 无 topic） | `message_thread_id` |
| `target_message_id` | `reply_to_message_id` | 空（reply 语义待定） | `reply_parameters.message_id` |

并注明 Feishu 现状 reply 只发 `chat_id`（`sendTextMessage`），与 Telegram 的 `reply_to_message_id` 语义不对等——`message.reply` capability 在两端的能力差异要在 manifest/fallback 中体现。

### P1-10. `feishu_message_id` 的消费点清单

§8.3 只概括了"claim/dedupe/context/watchdog/action-target 读取"，实现时是多个分散文件。建议在 A4 issue 里列出完整清单（我已核实的主要消费点）：

- `imReplyOutboxDispatch.ts`：`listDispatchableSyncOutbox` WHERE 子句、`deliveryPolicyError` 判空、`markSyncOutboxSent` 入参；
- `notificationOutbox.ts`：`dispatchOne` 写 `feishu_message_id`；
- `feishuConversationContext.ts`：出站 message ID 读取；
- `guardianWatchdog.ts` / `guardianMissedIntentSweep`：sent 判断；
- `feishuActionTarget.ts`：action target 消费。

## 5. P2：协议层与通用层补充

### 5.1 Telegram 协议层

1. **`sender_chat`（群组匿名管理员）**：群消息可能没有 `from`（匿名管理员用 `sender_chat`）。§11.4 的 normalizer 若要求 `sender.id` 必填会误拒。建议明确：`sender` 缺失但 `sender_chat` 存在时如何映射（或 fail closed + rejection audit）。
2. **privacy mode 操作说明**：BotFather 的 privacy mode 决定群内 bot 默认只收到 mention/command/reply 消息。§6.1.4 的"群聊默认需要明确 mention"与默认隐私模式一致，但这是 BotFather 侧配置，allowlist 无法改变——建议在 Telegram 配置/UI 文案中写明，避免用户以为开了 allowlist 就能收到全量群消息。
3. **`allowed_updates` 过滤**：`getUpdates` 显式传 `allowed_updates=["message","callback_query","edited_message"]`，减少噪声与审计垃圾（当前设计靠"忽略或拒绝"被动处理）。
4. **出站节流**：Bot API 有每 chat ~1 msg/s、全局 ~30 msg/s 限制。§11.5 的分段发送可能自造 429 风暴（分段本身就该限速）。建议 sender 内置简单队列/间隔，且 429 retry-after 计入分段派生 ref。
5. **reaction 时间窗（验证项）**：Telegram 对"太老的消息"加 reaction 会失败（官方未给精确阈值，社区经验约 48h）。建议列为 live smoke 的"已分类 capability/permanent error"验证项，不当作能力缺失。
6. **单 bot 单消费者**：一个 token 同时两个 getUpdates 消费者会 409 Conflict。§5.7 的"每 module 一个 active generation"只约束进程内；**跨进程**（多 runner 实例）没有分布式锁，只能靠部署约定，建议在配置文档写明。
7. **`getMe` 结果缓存**：receiver start 时 `getMe` 验证 token 并缓存 bot ID/username，避免每次 restart 重复打 API（§11.6 smoke 已有，但建议作为 start 常驻步骤）。

### 5.2 通用层

8. **message 级退化 scope**：Feishu 现状有 `feishu-message-<id>` 退化 scope（无 chat/thread 时）。`im_conversation_state` 草案没有 message 级 scope 的处理——message 级天然是 one-shot，写 state 表没有意义。建议明确：退化 scope 不写 state 表，直接 one-shot 会话。
9. **callback 的审计落点**：§5.6 说 callback 只进 interaction resolver，但没有说是否写 `external_events`。现有 Feishu callback 走 `pi_action_events`/approval resolver，不写 external_events。建议明确：callback 审计落在 `pi_action_events` + `im_interaction_bindings`，**不重复写 `external_events`**（避免与 §6.1 的"一个外部事件只写一次"冲突）。
10. **receiver status 的内存态定位**：`ImReceiverStatus`（§5.7）是内存态，与 0076 的"health 是 projection、不建状态表"需要对齐。建议明确：内存 status 是 health projection 的一个输入，不落库、不成为第二事实表。
11. **A5 拆分**：A5（Feishu cutover）横跨入站/出站/卡片/设置四条链，回滚面不同。建议拆 A5a（inbound/receiver/context 切 generic）与 A5b（outbox/card/notification 切 generic），各自独立 parity 门禁，降低单次回归半径。
12. **`sender.is_bot` 默认值**：Feishu `FeishuSender` 无 is_bot 字段，normalizer 迁移到 `ImInboundMessageV1.sender.is_bot` 时要默认 `false` 并注明。
13. **`occurred_at` 统一**：Telegram `message.date` 是 unix 秒，Feishu 是字符串/毫秒，normalizer 统一 ISO 字符串（文档未写单位换算）。
14. **新增测试项**：多段文本分段的幂等重试（同 idempotency key 不重复发送、段 ref 稳定派生）；callback_data 64 字节边界；批量 update 的 transient 失败停止 + 崩溃重投（§P0-1 不变量 1–6）。

## 6. §18 决策项逐条建议

| # | 决策项 | 建议 |
| --- | --- | --- |
| 1 | 阶段 A 全链覆盖 | 同意。否则 Telegram 必然再改 core |
| 2 | 编译期 built-in registry | 同意 |
| 3 | 新建 `im_conversation_state` + compatibility projection | 同意新建中性表；compatibility projection 期限要写死（1 release） |
| 4 | IM conversation 永不保存 current project | 同意。已核实现有代码 `active_project_id` 为 vestigial，补充 consumer-scan 回归即可 |
| 5 | `provider_request_ref` 提升为 authoritative receipt | 同意，但 A4 必须列出全部消费点换列清单（见 P1-10），且 `result_json` 需按 `operation_kind` 定义 schema（见 P1-8） |
| 6 | `interaction.send/receive` 取代 core `card.send` | 同意，`card.send` 仅兼容期；补历史 card callback 兼容窗口（见 P1-7） |
| 7 | MVP 只做 long polling | 同意 |
| 8 | B2/B3 拆分 vs 等价宣称 | 建议把决策项改明确：B2、B3 分 PR 合并，但"TG 与 Feishu 能力等价"的宣称 gate = B3 完成 |
| 9 | 服务端 registry + 前端显式 registry | 同意 |
| 10 | live gate | 同意，阶段 A 真实 Feishu parity 是 B 的前置 |

**建议新增的决策项：**

- **sender 唯一路径**：确认 dispatcher 只走 `ChannelConnector.deliver(OutboundEnvelope)`，`ImChannelSender` 仅作 transport 原语、废弃 `NotificationChannelSender`（P0-2）。
- **批量处理不变量**：确认逐条 event+cursor 同事务、升序处理、transient 失败不推进并停止本批、永不跨过未 durable 的 update（§P0-1 修正版）。
- **callback 反馈契约**：确认 `answerCallbackQuery` 先应答、异步处理后用消息/编辑送达结果、consume 后清理按钮（P1-4/P1-5）。
- **文本 fallback 消歧**：确认"最近一个 pending binding + 严格格式 + 回显确认"规则（P1-6）。

## 7. 结论

设计方向正确、与仓库既有 ADR 体系兼容，**可以进入决策确认流程**；但建议在冻结 contract（A1）之前先明确批量处理不变量（§P0-1 修正版）与 sender 唯一路径（P0-2），并在 A1 文档中补齐 P1-3~P1-10 的契约细节。Telegram 特有的 callback_data 64 字节、answerCallbackQuery、批量 update 确认语义是本设计对 Bot API 理解上仅有的实质性缺口；通用侧则集中在一个问题：**发送路径与 receipt 列语义必须收敛为单一权威**。
