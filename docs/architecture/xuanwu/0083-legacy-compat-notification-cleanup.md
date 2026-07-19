# ADR-XW-0083：legacy/compat 引用审计与通知单写路径收敛

- 状态：Accepted
- 日期：2026-07-19
- 路线 issue：XW P11.06 / Runner #741
- 硬依赖：XW P09.02 / #718、XW P08.10 / #716、XW P10.08 / #731（执行前均为 `done`）
- canonical 写路径：`backend-ts/src/notifications/unifiedNotificationPipeline.ts` → `notificationOutbox.ts`

## Live/reference map 与删除边界

本次先对与 source revision `a9c0649` 一致的 launchd/3008 runtime、served web、live SQLite 和当前
`codex-cli 0.142.3` app-server schema 做只读审计，再决定删除范围：

| 区域 | live/source 证据 | 结论 |
| --- | --- | --- |
| 通知 producer | source 中 lifecycle、digest、completion watch 已部分进入统一 pipeline，但 memory candidate、PI Action、needs-user 和 Automation Watch 仍可经 `feishuNotificationDrafts.ts` 直接写 draft/outbox | 删除 wrapper；所有 notification external write 只经统一 pipeline/outbox |
| 历史通知 | live `external_links(relationship='notification')` 有 206 条 Feishu 关系投影，`sync_outbox` 有 206 条已发送记录；按 `(source, external_type, external_id)` 审计重复数为 0 | 不 backfill、不删除历史行；统一 pipeline 读取既有 link 做 replay dedupe |
| provider approval | 当前 app-server 生成的 `ServerRequest` 同时声明 `item/*/requestApproval`、`execCommandApproval` 和 `applyPatchApproval` | 旧方法仍是当前 provider contract，不能删除；broker 仅删除“未知 method 走默认 legacy decision”的 bypass，改为 fail closed |
| 前端 event adapter | live `issue_events` 中仍有大量只带 `raw_method`、不带 `agent_event_type` 的历史/兼容日志；当前 served bundle 仍消费映射 | 保留 `issueDetailEventAdapters.js` 和 Approval 展示兼容，保证历史数据可读 |
| Issues/Sessions compat API | live `GET /api/compatibility/legacy` 仍记录 CLI/HTTP/browser consumer，served bundle 仍引用 `/api/compatibility/legacy/usage` | P11.05 观察窗未达到 consumer-zero；保留 compat API、telemetry 与前端 route adapter |
| Feishu carrier/mapping | `migrateLegacyFeishuOutboxEnvelope` 仍是生产 dispatcher 的运行边界，receipt 仍落在 `sync_outbox.feishu_message_id` | provider-neutral receipt schema 尚未迁移；本 issue 不改 public schema/provider adapter |

可复核命令（只读；DB 路径必须取自当前 launchd 参数，不得使用仓库内空 `data/runner.db`）：

```bash
./scripts/status-launchd.sh
rg -n "createFeishuNotificationDraft|alreadyQueuedFeishuNotification|feishuNotificationDrafts" backend-ts/src
rg -n "queueNotificationOutbox\(|routeNotification\(|queueExistingNotificationIntent\(" backend-ts/src --glob '!**/*.test.ts'

codex app-server generate-ts --out /tmp/xw-p11-06-codex-schema
rg -n "execCommandApproval|applyPatchApproval|item/.+/requestApproval" /tmp/xw-p11-06-codex-schema/ServerRequest.ts

curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  http://127.0.0.1:3008/api/compatibility/legacy
```

## Single write path 与 event dedupe

`pi_notification_intents` 继续是通知意图 authority；`im_reply_drafts + sync_outbox(operation_kind='im_reply')`
继续是唯一外部投递 authority；`external_links(relationship='notification')` 继续是 provider/channel delivery
关系投影与跨版本 dedupe authority。本次不新增表、shadow writer、双写或第二 outbox。

- `feishuNotifications.ts` 的 memory candidate、PI Action pending、needs-user 和 Approval 全部调用
  `routeNotification`；lifecycle、digest、completion watch 与 Automation Watch 的既有 intent 调用
  `queueExistingNotificationIntent`。
- `feishuNotificationDrafts.ts` 及其 producer-side pre-check 被删除。只有 `notificationOutbox.ts` 可以把
  notification intent 转成 draft/outbox/link 三件套。
- replay 先复用 intent idempotency key；若旧 release 只有 `external_links`、没有统一 intent，新 pipeline
  读取历史 link 后把新 intent 确定性标成 `suppressed/duplicate_notification_link`，不会留下 ready intent，
  也不会创建第二条 outbox。
- `approvalBroker` 只接受显式列出的当前 schema method；未知 method 在 policy evaluation 和 pending mutation
  前直接报错，不再落到 legacy response default。LLM 仍不能成为 approval/action gate authority。

## 数据迁移、兼容期限与回滚

本次是 **W2 writer cutover**：双写=0、双读=0，不做 schema migration 或历史 backfill。既有 intent、draft、
outbox、receipt 与 notification link 原样保留；旧行继续由相同 repository 和 dispatcher 读取。删除的是无状态的
Feishu wrapper，不是 carrier 或历史数据。

回滚使用本 issue 前一 release artifact：它仍能读取完全相同的表和 row shape，无需 DB downgrade。回滚前不得
删除 pending/retry outbox；若新旧 binary 交替运行，`external_links` 与 intent idempotency key 仍阻止重复投递。

以下路径继续保留，直到各自门禁满足后由独立、精确审批的 change 删除：

1. `execCommandApproval` / `applyPatchApproval`：当前 app-server schema 移除且支持矩阵、fixture replay 通过；
2. `migrateLegacyFeishuOutboxEnvelope` / `sync_outbox.feishu_message_id`：provider-neutral receipt schema 完成
   backup、隔离 restore、live callback/websocket 和一个正式 release consumer-zero；
3. frontend historical event adapter：归档 reader 能覆盖 retained logs，正式 release 内 fallback hit 为 0；
4. Issues/Sessions compat API：遵循 ADR-XW-0081 的 `v0.4.0` not-before、一个正式 release consumer-zero、
   rollback artifact、fresh backup/restore、P11.09/G7 和非 LLM destructive approval。

## 最小验证

```bash
cd backend-ts
bun test src/providers/codex/approvalBroker.test.ts \
  src/notifications/unifiedNotificationPipeline.test.ts \
  src/integrations/feishuLifecycleNotifications.test.ts \
  src/integrations/feishuLifecycleNotificationPreferences.test.ts \
  src/integrations/feishuDigestNotifications.test.ts \
  src/integrations/feishuCompletionWatchNotifications.test.ts \
  src/integrations/feishuNotifications.test.ts \
  src/integrations/feishuNotificationLifecycle.test.ts \
  src/integrations/feishuApprovalNotifications.test.ts \
  src/integrations/feishuPiActionCards.test.ts \
  src/runner/watchAutomationRuntime.test.ts
```

覆盖重复通知、历史 link replay、intent/outbox 单写、retry、quiet/digest、Approval fail-closed 与 Automation Watch。
