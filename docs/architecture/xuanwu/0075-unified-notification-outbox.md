# ADR-XW-0075：统一通知 Intent、Outbox 与 Daily Digest

- 状态：Accepted（W2 single-writer cutover；见 ADR-XW-0083）
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

`routeNotification` 为每个 channel 生成稳定 child idempotency key，确定性读取既有 run-group/conversation/project/global preference；`digest_policy_json.channels` 可收窄 channel。普通消息在项目 quiet hours 或 digest/quiet preference 下保持为 `aggregated` intent；所有准备外发的通知（包括 `needs_user`、approval 与 urgent）先进入 `agent_pending`，由 `agentCommunicationGateway.ts` 调用项目配置的 Agent 判断是否打扰用户、合并关联事件并生成最终措辞，之后才写入 outbox。`queueDailyNotificationDigests` 在项目 timezone 的 `daily_at`（默认 09:00）后聚合无 run-group 的 deferred intent；run-group digest 继续由既有 scheduler 负责，二者不竞争。

Agent 调用失败、返回无效结果，或错误压制 `requires_user` 事项时，gateway 会停止原始自动状态消息，并按项目与会话 30 分钟限流发送一条 `agent_communication_fallback`，明确告知用户 Agent 当前不可用及应检查 provider。该 fallback 是 Agent-first 边界的唯一确定性通知例外；Guardian 自身不可用/漏报告警继续保留既有直达兜底。此变更不新增 authority、表或迁移，`pi_notification_intents`、`im_reply_drafts`、`sync_outbox` 与 `external_links` 的职责不变。

`notificationOutbox.ts` 只承载既有 draft/outbox 写入与 retry policy。P11.06 已删除 Feishu notification draft wrapper，所有 notification producer 经 `unifiedNotificationPipeline.ts` 进入该 core；生产 Feishu 的 card-aware dispatch 仍由 `imReplyOutboxDispatcher` 承担。多 channel sender 合同不解析 provider payload，也不绕过 approval/action gate。

## Guardian 运维日报与 Attention 降噪

Guardian 运行告警不再默认等同于“用户待办”。`guardianAlertPresentation.ts` 在读取时明确投影故障组件、范围、首次/最近发现时间、PI 已执行动作以及用户下一步，并把事件分为 `pi_handling`、`user_action_required` 和 `historical`：可自动恢复的告警只进入 Command Center 的紧凑运维摘要；仅审批、缺少输入、验收、连接/调度配置问题或已耗尽确定性恢复预算的事件进入用户 Attention。用户 acknowledge 后不再显示，snooze 在到期前不再显示；来源恢复时 `open`/`acked` 告警都自动归档，历史记录不会重新冒充当前故障。

`guardianOperationsDailyReport.ts` 仅在用户通过活动通知偏好显式设置 `digest_policy_json.operations_daily_report=true` 时，才按项目 timezone 与 `daily_at` 汇总过去 24 小时发现/恢复的告警、恢复会话和恢复 Issue 数量；历史 intent 的投递地址不能反向推断为日报订阅。日报调用 `routeNotification` 写入 `pi_notification_intents`，由既有 Agent communication gateway、draft/outbox 与 receipt 链路发送；`pi_reports(type='daily_operations_digest')` 只保存可审计报告快照和幂等日桶，不构成第二通知 authority。没有显式订阅或可用通知目标时不发送，也不会凭空创建旁路目标。

Guardian 告警可以先写入 UI/Attention 供 PI 持续消化，但 direct Feishu 发送前必须复用 `guardianAlertPresentation(...).requires_user` 的确定性投影。短暂 scheduler、coordinator、digest、outbox、inbox 或 missed-digest 异常在恢复预算和等待窗口内只保留运行记录；只有缺少人工输入/配置、审批门禁、恢复预算耗尽，或异常持续达到升级阈值时才允许打扰用户。

## 兼容、回滚与删除门禁

- **W2 双读=0、双写=0：** intent、draft、outbox 和 external link 都只写既有 authority；旧 Feishu API/row shape 保持不变。P11.06 只删除无状态 wrapper，不 backfill 或删除历史 row；`sync_outbox.feishu_message_id` 继续作为 compatibility receipt carrier，直至独立 provider-neutral schema migration 完成。
- **回滚：** 停止 scheduler 的 daily digest 调用并让 Feishu wrapper 回到原 helper 即可；既有 intent/outbox row 可继续由原 dispatcher 恢复，不删除数据、不反写业务状态。
- **最终删除门禁：** P09 channel adapter 完成 receipt/cursor/idempotency/audit parity；连续两个正式 release legacy-only producer/consumer 为 0；restart/retry、quiet hours、多 channel、backup/restore rehearsal 通过；有新鲜备份、隔离恢复证据和非 LLM cutover approval。缺一项不得删除 legacy Feishu carrier 或字段。

## 最小验证

```bash
cd backend-ts
bun test src/notifications/unifiedNotificationPipeline.test.ts \
  src/notifications/agentCommunicationGateway.test.ts \
  src/integrations/feishuApprovalNotifications.test.ts \
  src/integrations/feishuLifecycleNotifications.test.ts \
  src/integrations/feishuDigestNotifications.test.ts \
  src/http/handoffApi.test.ts
```

覆盖重复事件一次、多 channel fixture、失败 retry/backoff、quiet hours、Daily Digest、deep link、Approval 与 Handoff intent/outbox。
