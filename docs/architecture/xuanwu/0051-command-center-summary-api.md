# Command Center 聚合 API 合同

- 状态：Accepted
- 日期：2026-07-17
- 依赖：[Work HTTP API](0016-work-http-api.md)、[Run progress projection](0025-run-progress-projection.md)、[Handoff API](0043-handoff-api-page-notification.md)、[产品导航合同](0050-product-navigation-compatibility.md)
- canonical 级别：`backend-ts/src/http/commandCenterApi.ts` 的 `xw.command-center.summary.v1` 是 Command Center request-time summary 的唯一 HTTP contract；它只投影现有 authority，不新增存储或状态机

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
| `attention` | `new/triaged/proposal_created/failed`，映射为 canonical `open/acknowledged/waiting`，保留 `legacy_status` | `attention_inbox_items` 是 P08.07 前的兼容 carrier；链接回现有 `/api/pi/attention-inbox/*`，不创建第二套 Attention 表 |
| `active_work` | `todo/in_progress/pending_verification`，按 Work `updated_at` 取最多 limit 条，并批量附加每个 Work 最新 Run 的 progress/stalled | Work 读取仍由 Issues + Work adapter authoritative；Run 由 `issue_runs`、`run_attempts`、`issue_events` read-through projection authoritative |
| `recent_deliveries` | 当前 revision 的非 superseded `draft/ready/delivered` Handoff | `issue_events:handoff.*.v1` authoritative；保留 API self link 和 `#/handoffs/:id` deep link |
| `system_health` | DB 可读、event projection lag 与 Run 状态分布 | 只读当前 runner DB/projection；完整 provider、connector、doctor 事实仍由 `/api/system/status` 与 `/api/system/doctor` authoritative |

聚合 API 不执行 action、不改变 Work/Run/Handoff/Attention 状态，也不访问外部 provider。后续 P07.03–P07.05 UI 必须使用返回的 domain/API link，不得从标题、prose 或 provider session id 重建身份。

## 3. Bounded query 与大库行为

- item limit 在 HTTP 边界封顶为 25；Active Work 只对这批 Work 批量读取最新 Run，Run progress timeline 固定为 0，避免把长日志/时间线带入首页。
- Work 与 Attention 的总数使用 repository count；Handoff 总数只统计每个 Handoff 当前 revision；System Health 用一次 grouped Run status count，不逐 Run 重建全部 progress。
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

- 本期双写为 0、双读为 0；summary 是对当前 repository authority 的 request-time projection，不持久化 cache/shadow 数据。
- `attention_inbox_items` 仅是 P08.07 前的显式兼容 carrier；切换统一 Attention 时必须在后续 issue 定义 parity window，不能在本 API 内静默改 authority。
- 回滚是从 `READ_API_ROUTE_REGISTRY` 注销 Command Center route，并恢复此前 bounded Dashboard reads；不删除 Issue、Run、Handoff、Attention 或 projection 数据。
- 旧 Dashboard 读取删除必须同时满足 P07.03/P07.04/P07.05 已迁移、一个正式 release 的 zero-consumer 证据和对应 P11/G7 门禁。LLM prose、UI 可见或单次 smoke 都不能替代这些确定性门禁。

## 6. 验证门禁

`commandCenterApi.test.ts` 必须覆盖四分区 contract、counts/freshness/links、分区选择与 limit、大库 bounded 行为，以及注入一个分区失败时其他分区仍成功。`readApiContract.test.ts` 锁定 route registry、方法/path 和 compatibility authority。
