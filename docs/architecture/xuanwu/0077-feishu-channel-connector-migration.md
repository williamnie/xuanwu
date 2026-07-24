# ADR-XW-0077：Feishu 迁移到统一 Channel / Connector 契约

- 状态：Accepted（W1 compatibility adapter）
- 日期：2026-07-18
- 路线 issue：XW P09.02 / Runner #718
- 硬依赖：XW P09.01 / #717、XW P08.10 / #716（均为 `done`）
- 可执行适配器：`backend-ts/src/integrations/feishuChannelConnector.ts`
- fixture E2E：`backend-ts/src/integrations/feishuChannelConnector.test.ts`

## 根因与决策

Feishu 已有真实 callback/websocket、PI conversation、Issue、Watch、Notification 与 approval 能力，但 provider normalizer、直接聊天回复、project selection card、Guardian fallback 和 outbox dispatcher 分别直接调用 Feishu 类型/client。P09.01 的 `ChannelConnector` 只出现在 diagnostics，运行链没有经过其 envelope、capability 与 deterministic authorization 校验，因此增加新 channel 时仍可能复制 Feishu 旁路。

本迁移增加一个薄适配层，不复制任何 core 状态机：

| 能力 | P09.02 路径 | 唯一 source of truth |
| --- | --- | --- |
| inbound normalizer / cursor | raw Feishu event → `normalizeFeishuInboundEnvelope` → validated `message.receive` envelope | 原始配置与 `external_events`；cursor 只是 message/chat/thread 的 opaque 投影 |
| conversation routing / project hints | envelope 校验后继续调用 `decidePiAttention`、`routeFeishuConversation`、`resolveFeishuProjectContextFromDatabase` | `external_events.project_hint/project_id`、既有 conversation/project-selection repositories |
| Notification / Watch / approval outbox | `sync_outbox(operation_kind='im_reply')` legacy row → `migrateLegacyFeishuOutboxEnvelope` → connector `deliver` | `pi_notification_intents` + `im_reply_drafts` + `sync_outbox`；adapter 不建 outbox、不改状态 |
| cards / approval callback | approval/PI action card 由既有 builder 生成，投递前映射为 `card.send`；callback 仍先验签、allowlist，再进入既有 deterministic resolver | `pi_actions` / `pi_approval_requests` 与其 event audit |
| 即时聊天、project selection、Guardian fallback | 既有 reply/selection/Guardian gate 生成带稳定 audit/idempotency ref 的 outbound envelope，再调用统一 adapter | `external_links`、pending project selection、`pi_guardian_alerts`；不伪装成 Notification intent |
| settings / credentials | diagnostics 与 runtime 共用 `feishuChannelConnectorManifest`；adapter 继续读取现有 config/client | local settings + SecretService refs；legacy env/plain local config 仍由 `buildFeishuConnectorConfig` 兼容读取 |

callback 的 signature/token/allowlist 校验发生在 inbound normalizer **之前**。outbound 的 operation 必须在 manifest 声明，target 必须通过 chat/user allowlist，且 envelope authority 只能是 `deterministic_policy` 或 `human_approval`；`llm` 无法成为授权主体。实际 provider receipt 继续写既有 `sync_outbox.feishu_message_id` compatibility carrier 或对应现有审计记录。

## 并存期限、回滚与删除门禁

- **W1（本次，最多保留两个正式 release）：** 新 contract 是运行边界；旧 Feishu config、client、database row shape 是 transport/state compatibility carrier。双写=0、双读=0：每个 inbound 仍只写一次 `external_events`，每个 notification 仍只由 `sync_outbox` claim/send/receipt 一次。
- **回滚：** 将调用点退回既有 Feishu normalizer/client 与原 dispatcher；不需要数据回填或 schema downgrade，已存在的 external event、draft、outbox、selection、Guardian row 均可继续处理。不得删除或重置 pending/retry row。
- **W2 cutover：** 所有 Feishu runtime 调用点和 diagnostics 连续一个正式 release 只使用 adapter；fixture replay、duplicate、callback signature、permission、retry/restart 与 legacy config compatibility 通过。
- **最终删除门禁：** 连续一个正式 release legacy direct-client consumer=0；`sync_outbox` provider-neutral receipt schema 已由后续独立 schema issue 明确迁移并完成 backup/isolated restore；live callback 与 websocket 各有成功证据；有非 LLM cutover approval 和可恢复 artifact。缺任一项不得删除 legacy config/client/carrier，也不得在本 issue 修改 public schema。

## 最小验证

```bash
cd backend-ts
bun test src/integrations/feishuChannelConnector.test.ts \
  src/integrations/feishu.test.ts \
  src/integrations/feishuCallback.test.ts \
  src/integrations/feishuReceiver.test.ts \
  src/integrations/feishuAgentBridge.test.ts \
  src/integrations/feishuAgentBridgePiFirst.test.ts \
  src/integrations/feishuGuardianAlerts.test.ts \
  src/integrations/feishuApprovalNotifications.test.ts \
  src/integrations/feishuLifecycleNotificationPreferences.test.ts
```

覆盖 fixture inbound→external event→conversation route、重复消息、project hint、manifest conformance、text/card/reaction、LLM authority fail-closed、target permission、旧 env config，以及现有 callback 签名、receiver、聊天、Watch、Notification/approval 回归。
