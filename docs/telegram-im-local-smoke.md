# Telegram IM connector 本地接入与 smoke

本文用于接入 Telegram Bot API，并验证：

`getUpdates long polling → durable update cursor → external_events → Supervisor → reaction/reply → inline approval callback`

代码与 fake HTTP 测试通过不等于真实 Telegram 已验收。只有完成本文第 4 节并保留脱敏证据后，才能标记 live smoke 成功。

## 1. 创建 Bot 与权限边界

1. 在 Telegram 中通过 BotFather 创建 Bot，保存 Bot Token；Token 只写入本地 SecretService、设置页或未提交的环境变量。
2. 把 Bot 加入目标私聊/群组；论坛群的 topic 会映射为 `message_thread_id`。
3. BotFather privacy mode 决定群内 Bot 能收到哪些消息。allowlist 只能过滤 Telegram 已投递的 update，不能让 Bot 收到被 privacy mode 隐藏的普通群消息。默认用 mention、command 或回复 Bot 验收。
4. 本实现只使用 Bot API，不使用 MTProto user client；附件只记录受限 metadata，不下载文件内容。

## 2. 配置

推荐在 Settings → Integrations → Telegram Bot 完成首次接入：

1. 只填写 BotFather 提供的 Bot Token。
2. 在 Telegram 私聊 Bot 发送 `/start`；群聊中发送 mention、command 或回复 Bot。
3. 点击“自动识别 ID”。只有一个来源时页面会直接填入 Chat ID、User ID 和默认 Chat；检测到多个来源时由用户明确选择，避免误授权群聊。
4. 保存配置并测试连接。

自动识别响应只返回来源 metadata，不返回消息正文，也不会因识别操作额外持久化正文。首次配置尚未启动 receiver 时，接口读取 pending updates 但不提交 cursor；receiver 已运行时改读 durable recent events，避免与主 long-poll consumer 竞争。高级设置仍可手动维护 allowlist、默认 Chat、项目映射与 polling 参数。

Bot Token 写入 SecretService，GET 接口只返回 `bot_token_configured`，不回读明文。

也可使用环境变量：

```bash
export TELEGRAM_ENABLED="true"
export TELEGRAM_BOT_TOKEN="123456:replace-me"
export TELEGRAM_ALLOWED_CHAT_IDS="123456789,-1001234567890"
export TELEGRAM_ALLOWED_USER_IDS="123456789"
export TELEGRAM_DEFAULT_CHAT_ID="-1001234567890"
export TELEGRAM_PROJECT_MAPPINGS="chat:-1001234567890=xuanwu,user:123456789=xuanwu"
export TELEGRAM_POLL_TIMEOUT_SECONDS="25"
export TELEGRAM_GET_ME_CACHE_TTL_SECONDS="300"
```

Chat/User ID 先按 Telegram safe-integer 规则验证，再作为 opaque string 保存；负群组 ID 不转成业务数字。`enabled=true` 时 Bot Token、chat allowlist 与 user allowlist 都是必需门禁。普通用户消息必须同时匹配 chat 与 user allowlist；仅 mention Bot 不能绕过来源授权。匿名管理员 `sender_chat` 使用 chat allowlist 并保留 `sender.kind=chat`。

设置页更新 Token 时只写 SecretService 引用；若检测到早期 `runner-settings.local.json` 遗留的明文 Token，下一次保存会迁移到 SecretService 并从设置文件移除明文。

接收器启动前会调用 `getMe` 和 `getWebhookInfo`。若 Bot 已配置 webhook，会 fail closed；Runner 不会自动执行 `deleteWebhook`，也不会丢弃 pending updates。一个 Bot Token 在部署层只能有一个 active long-poll consumer，409 conflict 会停止重连风暴并显示失败状态。

## 3. 离线验证

```bash
cd backend-ts
bun test src/integrations/telegram.test.ts \
  src/integrations/telegramReceiver.test.ts \
  src/integrations/imGuardianAlerts.test.ts \
  src/integrations/connectorDiagnostics.test.ts \
  src/integrations/feishuApprovalNotifications.test.ts \
  src/integrations/feishuNotificationLifecycle.test.ts \
  src/runner/watchAutomationRuntime.test.ts \
  src/http/telegramSettingsApi.test.ts
```

这些测试使用 fake HTTP，覆盖 token 不泄露与旧明文迁移、safe-integer ID/source allowlist、匿名 sender/附件 metadata、`edited_message` inbox audit、callback 1/64/65-byte 门禁与单次稳定确认、消息/topic normalizer、cursor restart、webhook/409 冲突、plain-text 发送、按 chat 的 429 `retry_after` 暂停、Unicode 分段与部分成功后的持久分段回执、callback 最终结果经 durable outbox 投递，以及 Approval、生命周期、Guardian、Watch 到 Telegram 的通用 outbox 路由。它们不能作为真实 Bot 证据。

## 4. 真实 Bot smoke

1. 在设置页保存 Token 与 allowlist，先点“测试连接”；记录 Bot ID/username 和 `long_polling_ready=true`，不要记录 Token 或完整 Bot API URL。
2. 启动或重启 Runner，确认 IM registry 中 `telegram` receiver 为 `connected`。
3. 从 allowlisted 用户在 allowlisted chat 发送 `@bot_username /new` 或回复 Bot；确认：
   - `external_events.source='telegram'` 只有一条对应 update；
   - 原消息出现 best-effort 👍 reaction，或出现已分类的 permanent/capability 错误；
   - Supervisor plain-text 回复回到同一 chat/topic。
   - 从未授权 user 或 chat mention Bot，不触发 Supervisor；对应 event/audit 显示 ignored/rejected。
4. 发送超过 4096 字符的测试回复，确认按固定边界串行发送，`sync_outbox.result_json.provider_message_refs` 保存全部分段消息 ID；重试不重复已成功分段。
5. 触发一次项目歧义选择和一次 approval/PI action，确认 inline keyboard 只含 opaque token，按钮只消费一次，重复点击不重复执行。
   - 过期按钮只返回一次稳定“已过期”提示，不先显示“正在处理”；有效 approval/PI action 的最终结果经 `sync_outbox` 回到同一 chat/topic。
6. 创建 Telegram 通知偏好及 completion watch/digest，确认 outbox 的 `source='telegram'`、provider-neutral receipt 与目标 chat/thread 正确。
7. 重启 Runner，确认下一次 `getUpdates.offset` 高于已提交 cursor，旧 update 不再触发 Supervisor。
8. 临时启动第二个同 Token consumer，确认 409 被分类并停止重连；停止第二个 consumer 后再显式重启主 receiver。
9. 检查日志、诊断响应、`pi_action_events`、`connector_update_audits` 与 `sync_outbox.result_json`，不得出现 Bot Token。

### 4.1 本机验收记录（2026-08-16）

真实 Bot smoke 已在本机 live runtime 通过，运行构建标记为 `20260816T134507Z-d6b610e6328a-dirty`。证据已脱敏，不记录 Bot Token、完整 Bot API URL、个人 Chat/User ID 或测试群 ID。

- `getMe` 与 webhook 检查通过，receiver 为 `connected`，`long_polling_ready=true`。
- Token-only 引导与“自动识别 ID”已在 live 设置页验证；receiver 运行时从 durable recent events 识别来源，不会启动第二个 long-poll consumer，响应不包含消息正文或 Bot Token。
- allowlisted 私聊完成入站、reaction、plain-text 回复；超过 4096 字符的回复拆成 2 段并保存全部 provider message refs。
- 项目歧义选择使用 opaque callback token，binding 只消费一次并清除 inline keyboard。
- completion watch 经 provider-neutral outbox 投递到 Telegram；显式 watch 不再被 Agent 的普通通知抑制决策吞掉。
- PI action 的拒绝分支完成单次决策、单次 callback audit 和最终结果回执；确定性 4xx resolver 失败会被持久化并结束 callback，不再无限显示“正在处理”。
- Core 重启后从 durable cursor 继续；第二 consumer 触发的 409 被分类并停止重连，显式重启后恢复。
- 未授权测试群的 mention/command 只写 ignored audit，不进入 Supervisor，也不生成 Telegram outbox。
- 临时项目映射已清空，测试通知偏好已禁用；设置文件、运行日志、诊断响应及相关 DB 文本字段的 Token 命中数均为 0。

本记录证明当前本机部署的真实集成链通过；它不等于正式版本发布或回滚演练。

只读核验示例：

```sql
select connector_id, scope, position, updated_at
from connector_cursors where connector_id='telegram';

select update_id, outcome, reason, created_at
from connector_update_audits where connector_id='telegram'
order by cast(update_id as integer) desc limit 20;

select id, status, provider_request_ref, result_json
from sync_outbox where source='telegram'
order by id desc limit 20;
```

## 5. 回滚

关闭 `TELEGRAM_ENABLED` 或在设置页禁用后重启 receiver。不要删除 `external_events`、cursor、interaction binding、pending/retry outbox 或 delivery-part receipt；这些是恢复、幂等与审计依据。禁用 Telegram 不影响 Feishu channel。
