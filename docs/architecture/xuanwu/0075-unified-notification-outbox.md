# ADR-XW-0075：统一通知 Intent、Outbox 与 Daily Digest

- 状态：Accepted（W1 additive compatibility）
- 日期：2026-07-18
- 路线 issue：XW P08.10 / Runner #716
- 硬依赖：P08.06 / #712、P08.07 / #713、P05.08 / #679（均为 `done`）
- 可执行实现：`backend-ts/src/notifications/unifiedNotificationPipeline.ts`、`notificationOutbox.ts`、`dailyDigest.ts`

## 决策与根因

现有完成/失败与 run-group digest 已写 `pi_notification_intents`，但 Approval、Handoff 和若干 Feishu producer 仍直接创建 draft；发送、去重、重试和 deep link 分散在 Feishu helper、`external_links` 与 `sync_outbox`。这会让新 channel 复制一套 outbox，也使 quiet hours 后的普通消息缺少统一汇总出口。

本阶段不新建通知表或第二套状态机：

| 事实 | 唯一 source of truth |
| --- | --- |
| 是否应通知、按 channel 的幂等键、偏好决策 | `pi_notification_intents` |
| 本地 UI 未读投影 | `notifications` |
| 外部消息 draft、claim、retry、receipt | `im_reply_drafts` + `sync_outbox(operation_kind='im_reply')` |
| provider/channel 投递关系审计与 dedupe | `external_links(relationship='notification')` |
| Handoff 交付事实 | 既有 Handoff record；notification 只引用 deep link，不反写 Handoff |

`routeNotification` 为每个 channel 生成稳定 child idempotency key，确定性读取既有 run-group/conversation/project/global preference；`digest_policy_json.channels` 可收窄 channel。`needs_user`、approval 与 urgent 仍立即入 outbox，普通消息在项目 quiet hours 或 digest/quiet preference 下保持为 `aggregated` intent。`queueDailyNotificationDigests` 在项目 timezone 的 `daily_at`（默认 09:00）后聚合无 run-group 的 deferred intent；run-group digest 继续由既有 scheduler 负责，二者不竞争。

`notificationOutbox.ts` 只抽取既有 draft/outbox 写入与 retry policy。Feishu wrapper 已调用该 core，生产 Feishu 的 card-aware dispatch 仍由 `imReplyOutboxDispatcher` 承担；多 channel sender 合同用于 fixture 和后续 connector adapter，不解析 provider payload，也不绕过 approval/action gate。

## 兼容、回滚与删除门禁

- **W1 双读=0、双写=0：** intent、draft、outbox 和 external link 都只写既有 authority；旧 Feishu API/row shape 保持不变。`sync_outbox.feishu_message_id` 在 W1 对 generic fixture 仅承载 provider receipt，正式非 Feishu adapter 应在 P09 cutover 前完成字段映射。
- **回滚：** 停止 scheduler 的 daily digest 调用并让 Feishu wrapper 回到原 helper 即可；既有 intent/outbox row 可继续由原 dispatcher 恢复，不删除数据、不反写业务状态。
- **最终删除门禁：** P09 channel adapter 完成 receipt/cursor/idempotency/audit parity；连续两个正式 release legacy-only producer/consumer 为 0；restart/retry、quiet hours、多 channel、backup/restore rehearsal 通过；有新鲜备份、隔离恢复证据和非 LLM cutover approval。缺一项不得删除 legacy Feishu carrier 或字段。

## 最小验证

```bash
cd backend-ts
bun test src/notifications/unifiedNotificationPipeline.test.ts \
  src/integrations/feishuApprovalNotifications.test.ts \
  src/integrations/feishuLifecycleNotifications.test.ts \
  src/integrations/feishuDigestNotifications.test.ts \
  src/http/handoffApi.test.ts
```

覆盖重复事件一次、多 channel fixture、失败 retry/backoff、quiet hours、Daily Digest、deep link、Approval 与 Handoff intent/outbox。
