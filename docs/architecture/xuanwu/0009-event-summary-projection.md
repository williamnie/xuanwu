# XW P01.05：事件摘要 projection 与游标重建

状态：accepted（2026-07-16）

依赖：XW P01.02（issue 638，`done`）、XW P01.04（issue 640，`done`）

## 1. 决策与 source of truth

`issues`、`issue_runs`、`issue_events` 继续是 Work/provider timeline 的唯一 source of truth。`event_summary_projection` 是可丢弃、可重建的 R0 derived projection；它不能反向更新 Issue/Run 状态，不能替代 Guardian、权限审计、verification 或 Handoff Evidence。

默认读取切换如下：

- Dashboard 首屏历史通过 `GET /api/event-summaries?limit=20` 读取 projection；SSE 仍只承载进程内 live tail，不扫描数据库。
- PI Activity 的 issue child nodes 从每个 issue 最近 500 条 projection 构建，不再调用 `listIssueEvents()` 并 hydrate 全量 `issue.log` artifact；最终 timeline 仍保留既有 100/500 result limit。
- Issue Detail 的 Activity/Work timeline 通过 `GET /api/issues/:id/event-summaries?exclude_type=issue.log` 读取完整的非 log projection；Logs tab 仍按需读取原 `/api/issues/:id/events?type=issue.log`，以保留完整诊断和回放行为。

旧 `/api/issues/:id/events` contract 不变。全局新查询默认 `limit=100`、显式分页最大 500；issue-scoped 查询不传 limit 时保留完整 Work timeline。响应返回 `xuanwu.event-summary-query.v1` envelope、items、source-of-truth 和 watermark；items 保留原 event 的 `id/issue_id/type/payload/created_at` 兼容字段，并增加 project/run、retention classification、source/summary hash 和摘要。

## 2. Schema 与摘要边界

Migration `040_event_summary_projection` 新增：

- `event_summary_projection`：以 `(source, source_event_id)` 唯一定位原 event，记录 issue/project/run、event type、raw method、P01.02 policy/tier、摘要 payload、source bytes、source SHA-256、summary SHA-256 和时间；
- `event_projection_watermarks`：以 `projection_id=issue_events_summary_v1` 记录 projector version、最后成功提交的 source event ID、projection row count 和更新时间；
- issue/project + source event ID 索引服务 timeline/cursor 查询。

非 `issue.log` payload 原样复制，保证 comment、status、verification 等现有 Work timeline 行为不变。`issue.log` 只保留确定性 allowlist：`type/provider/raw_method/text/command/path/status/error`，单字段最多 16 KiB；不复制 `raw_payload`、artifact body 或任意未知 envelope。原 event ID、source hash 和 raw API 仍可用于审计与按需诊断。

## 3. 幂等 projector 与 watermark

`eventSummaryProjector.ts` 按 `issue_events.id > watermark.last_event_id`、ID 升序读取固定 batch。每个 batch 在同一 SQLite immediate transaction 内：

1. 确定性解析 stored payload、关联当时的 issue run、计算 retention classification；
2. 以 `(source, source_event_id)` upsert；source/summary hash 均未变化时不更新 projection row；
3. 最后推进 watermark 到该 batch 的末 event ID。

因此进程在 batch 前/中失败不会推进 cursor；已提交 batch 重放不会产生重复行或改变摘要。查询服务会先 catch up 未投影尾部，然后只扫描 projection。首次切读前应先运行 rebuild 命令完成历史 backfill，避免首个页面请求承担全量 backfill。

这里的 `event_projection_watermarks` 是 **读取 projection 的 cursor watermark**，不是 P01.02 的 destructive retention authorization。它不会自动生成或推进 `xuanwu.summary-watermark.v1` 删除证据；raw row 删除仍必须通过 archive、per-scope summary watermark、hold/reference check、restore rehearsal 和 destructive gate。

## 4. 可执行重建与审计

`maintenance events rebuild-projection` 只清空 derived projection/watermark，不修改 `issue_events`。命令必须显式提供 `actor`、`actor-kind=user|system|retention_worker`、reason 和 audit ref；`actor=llm` 与未知 actor kind 确定性拒绝。started/paused/completed/failed 均写入既有 `pi_action_events`。

`--max-batches` 可制造受控断点；再次执行时加 `--resume` 从已提交 watermark 继续。不带 `--resume` 会重新清空 derived rows 后从 0 重建。

## 5. 并存期限、回滚与删除门禁

- **双写：无。** authority 仍只写 `issue_events`；projection 由确定性 cursor projector catch up。
- **双读：有边界。** Dashboard/Activity/Work timeline 默认读 projection；Logs、Session replay、Guardian/terminal detection、审计与 legacy API 继续读 raw authority。
- **期限：** raw compatibility read 至少保留两个正式 release observation window，并持续保留到 Session/Guardian/verification parity、正式库副本 rebuild、断点续跑和抽样 hash 核对全部通过；P01.02 raw deletion gate 未满足前不得缩短。
- **回滚：** 停止/回退三个默认调用方到既有 raw API/read repository；projection 可原样保留或删除后重建。回滚不需要改写 raw rows，也不需要 provider adapter/schema 降级。
- **低 ID restore/repair：** 正常 authority 只 append。若 archive restore 或人工修复以显式 ID 插入 `id <= watermark` 的 source row，增量 catch-up 不会倒退 cursor，必须执行不带 `--resume` 的完整 rebuild 后再做 parity check。
- **最终删除门禁：** 只有明确列出的 raw consumer 全部迁移或保留例外、两 release 无 parity mismatch、归档/恢复演练成功、per-scope retention summary watermark 与 hold/reference/destructive gate 全部有效后，才能由独立 maintenance issue 删除候选 raw。P01.05 本身不删除任何 raw event 或 artifact。

## 6. 验证合同

自动化测试必须覆盖：

1. 同一 source batch 重放后 projection rows 完全一致；
2. `maxBatches` 暂停后 watermark 精确停在已提交 batch，并能继续；
3. 非 log payload 与 raw 完全相等，log allowlist/截断与 source sample/hash 一致；
4. query API 返回 cursor metadata 和过滤结果；
5. rebuild/resume 的 audit events 完整。

## 7. MEM-06 紧凑投影与消费者盘点

Migration `054_compact_event_summary_projection` 新增 shadow-only V2。V1 不会由 migration
自动 backfill、切读或删除；首次历史重建仍必须在 SQLite online backup 副本以及对应的
`artifacts/issue-logs` companion snapshot 上执行。

运行态消费者与读取字段如下：

| 消费者 | 查询/排序 | 实际读取 |
| --- | --- | --- |
| `/api/event-summaries`、Dashboard/Supervisor Activity | project/type、`source_event_id desc`、limit | summary + bounded payload |
| `/api/issues/:id/event-summaries`、PI Activity、Work timeline | issue/type/exclude type、before/after cursor、`source_event_id` | summary + bounded payload + run/hash metadata |
| Runtime Observability diagnostics | event type aggregate；全局最近 50 条 | aggregate 不读 payload；最近项读 summary + bounded payload |
| Logs、Session/Guardian、legacy `/events` | 不读 summary projection | 继续读取 `issue_events` authority |

V2 的逐事件行只保留 source event/issue 与 project/run/type/payload 的整数引用、原 payload
byte count 和 32-byte source SHA-256 BLOB。project/run/type 使用低基数字典；summary payload
使用 SHA-256 前 128 bit content-addressed key 的字典，key 冲突会对完整 payload 复核并 fail
closed。payload 以 UTF-8 BLOB 或 `deflate-raw` BLOB 存储（`payload_codec=0|1`），只有物理
变小时才压缩。summary、raw method、retention policy/tier 与 summary hash 在 bounded payload
上确定性重建，不重复落 TEXT。V2 只保留：

- rowid/主键支持全局 cursor；
- `(issue_id, source_event_id)` 支持 Issue/Work timeline；
- `(project_ref, source_event_id)` 支持低基数 project filter。

V1 的 `(source, source_event_id)` auto index 及 TEXT project index 只随 V1 保留；V2 不复制
source 常量，也不建立 raw method、policy、tier、payload 或 event type 的低价值逐行索引。

MEM-05 对少量 `issue.log` 做过 artifact 外置。V2 对这些行沿用 V1 的 stored-reference
source hash/byte count 和 bounded inline summary，不把 artifact body 再复制进 projection；
cutover report 仍单列 `representation_differences`。逐项 parity 严格比较 cursor、
issue/project/run/type、summary、bounded payload、classification、source/summary hash 和时间，
任一差异都 fail closed。

## 8. Shadow、dual-read、cutover 与删除门禁

1. `rebuild-compact-projection` 只从 `issue_events` 重建 V2，并以独立 watermark 断点续跑；
   非 resume 清空仅允许在 V1 读且无 active observation 时执行；
2. `verify-compact-projection` 必须证明 row coverage、cursor/max ID、lag=0、逐项 parity、
   V2 table+dictionary+index 不超过 100 MiB，以及三类关键 SQL P95 不劣于 V1 20%；
3. `observe-compact-projection` 在有期限窗口内保持 V1 返回、每次同时读取 V2；任何差异
   拒绝请求，不静默 fallback；
4. `cutover-compact-projection` 在同一 transaction/revision compare 中将 read version 切到
   V2。它要求 fresh verification、backup/restore 与 no-writer confirmations、非 LLM actor、
   audit ref/reason 和已满足的 observation duration；
5. `rollback-compact-projection` 原子恢复 V1 read version，且要求 V1 lag=0。数据库级回滚
   使用 fresh backup restore，不执行 generic down migration。

旧表和索引的物理删除不属于 MEM-06。只有 consumer-zero、fresh backup checksum 与隔离
restore、served-runtime observation window、保留 rollback artifact、明确 non-LLM approval
全部满足时，后续独立 issue 才能删除；所有 MEM-06 report 固定返回
`legacy_rows_deleted=0` / `authorized=false`。
