# Command Center 聚合 API 合同

- 状态：Accepted
- 日期：2026-07-17
- 依赖：[Work HTTP API](0016-work-http-api.md)、[Run progress projection](0025-run-progress-projection.md)、[Handoff API](0043-handoff-api-page-notification.md)、[产品导航合同](0050-product-navigation-compatibility.md)
- canonical 级别：`backend-ts/src/http/commandCenterApi.ts` 的 `xw.command-center.summary.v1` 是 Command Center request-time summary 的唯一 HTTP contract；它投影既有 authority，并只通过 P07.03 的 append-only command overlay 持久化人工 acknowledge/snooze 审计

## 1. HTTP 与 summary contract

`GET /api/command-center/summary` 一次返回 `attention`、`active_work`、`recent_deliveries`、`system_health` 四个分区。调用方可用重复或逗号分隔的 `sections` 只读取所需分区，例如：

```text
GET /api/command-center/summary?sections=attention,active_work&limit=10
```

`limit` 默认 10，允许 1–25，只限制有 item list 的分区；未知分区或越界 limit 返回带稳定 `code` 的 400。响应顶层固定包含：

- `contract: xw.command-center.summary.v1`；
- `generated_at`、`requested_sections` 与实际 `limits`；
- `partial` 和 `failed_sections`；
- 仅包含请求分区的 `sections`；
- 明确 authority、双读/双写、回滚和删除门禁的 `compatibility`。

每个成功分区包含 `status=ok`、`counts`、`freshness`、`links`，列表分区另含 bounded `items`。`freshness` 同时给出本次 `queried_at`、最新 authoritative source 的 `source_updated_at`、`stale_after_seconds` 和 `current/stale/empty` 状态；不能把“本次刚查询”误写成“源事实刚更新”。

## 2. 分区语义与 authority

| 分区 | 当前选择 | authority / 链接 |
| --- | --- | --- |
| `attention` | 从 Inbox、Guardian 和 Approval legacy adapter 投影为 P08.07 canonical Attention，按 `p0` 到 `p3` 排序 | `attention_inbox_items`、`pi_guardian_alerts`、`pi_approval_requests` 分别仍是原始事实的唯一 authority；summary 返回 source/API link 和 Inbox UI deep link |
| `active_work` | `todo/in_progress/pending_verification`，按 Work `updated_at` 取最多 limit 条，并批量附加每个 Work 最新 Run 的 progress/stalled | Work 读取仍由 Issues + Work adapter authoritative；Run 由 `issue_runs`、`run_attempts`、`issue_events` read-through projection authoritative |
| `recent_deliveries` | 当前 revision 的非 superseded `draft/ready/delivered` Handoff | `issue_events:handoff.*.v1` authoritative；保留 API self link 和 `#/handoffs/:id` deep link |
| `system_health` | DB 可读、event projection lag 与 Run 状态分布 | 只读当前 runner DB/projection；完整 provider、connector、doctor 事实仍由 `/api/system/status` 与 `/api/system/doctor` authoritative |

`POST /api/command-center/attention/:id/actions/acknowledge|snooze` 是 Command Center 唯一的 Attention mutation seam。每个 command 必须携带 P08.07 的 human/deterministic `allow` gate、actor、reason、correlation/event ID、timestamp 和 revision CAS；成功后 UI 立即重读 summary。它只向 `attention_command_events` 写入 append-only audit/overlay，**不**双写或复制 Inbox、Guardian、Approval 业务对象，也不访问外部 provider。后续 P07.03–P07.05 UI 必须使用返回的 domain/API link，不得从标题、prose 或 provider session id 重建身份。

## 3. Bounded query 与大库行为

- item limit 在 HTTP 边界封顶为 25；Active Work 只对这批 Work 批量读取最新 Run，Run progress timeline 固定为 0，避免把长日志/时间线带入首页。
- Work 与 Attention 的总数使用 authority-adapter projection count；Handoff 总数只统计每个 Handoff 当前 revision；System Health 用一次 grouped Run status count，不逐 Run 重建全部 progress。
- Handoff repository 为解析坏记录保留 `skipped_invalid`，聚合响应不会把坏 payload 当作 delivery。
- 自动化测试必须保留至少 12,000 Work 的分区查询，断言 total 准确、items 不超过 limit，并以宽松上限捕获意外全量 hydrate/N+1 回归。

## 4. Partial failure

四个分区在 handler 内独立执行。任一 repository/projection 抛错时，该分区返回：

```json
{
  "status": "error",
  "error": { "code": "section_unavailable", "message": "active_work query failed" },
  "freshness": { "state": "unknown", "is_stale": true },
  "links": { "collection": "/api/works" }
}
```

同一响应内其他已请求分区仍为 `ok`，HTTP 保持 200，顶层 `partial=true` 并列出 `failed_sections`。错误消息不回显 SQLite、路径、payload 或 secret。只有整个 request contract 非法时才返回 400；单分区失败不能拖垮首页。

## 5. 兼容、回滚与删除门禁

- 本期双写为 0、双读为 0；summary 是对当前 legacy authority 的 request-time projection。`attention_command_events` 仅保存可重放的 command/audit overlay，不是 Attention business-object cache、第二 writer 或 shadow source。
- Inbox、Guardian、Approval 各自保持 source of truth；acknowledge/snooze 不改变其 underlying alert/approval/inbox fact。源事实进入 terminal 时，projection 忽略旧 overlay 并回到 source resolution，避免误重开。
- 回滚是停止 Command Center Attention mutation route/read overlay、恢复此前 bounded Dashboard reads；migration 为 additive，无需回填或双写。删除 command overlay 的门禁是 P08.08/P08.09 parity、P10 restart recovery、一个正式 release 的 legacy consumer-zero，以及完成 restore/rollback rehearsal；门禁前不得删除审计行。
- 旧 Dashboard 读取删除必须同时满足 P07.03/P07.04/P07.05 已迁移、一个正式 release 的 zero-consumer 证据和对应 P11/G7 门禁。LLM prose、UI 可见或单次 smoke 都不能替代这些确定性门禁。

## 6. 验证门禁

`commandCenterApi.test.ts` 必须覆盖四分区 contract、counts/freshness/links、分区选择与 limit、大库 bounded 行为，以及注入一个分区失败时其他分区仍成功。`readApiContract.test.ts` 锁定 route registry、方法/path 和 compatibility authority。
