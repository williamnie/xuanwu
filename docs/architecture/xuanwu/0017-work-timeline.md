# ADR-XW-0017：Work timeline 与统一事件视图

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.07 / Runner #653
- 依赖：XW P02.05（#651，`done`）、XW P01.05（#641，`done`）
- 实现：`backend-ts/src/domain/work/timeline.ts`、`GET /api/works/:id/timeline`

## 1. authority 与边界

本期只建立统一的 **read projection**，不新增 timeline 表、不双写、不改变 Issue/Run/PI 状态机：

- Work 与 Work history：G4 前仍以 `issues` / `issue_events` 为运行态 authority；`work_events` 只作为 target audit source 展示，不能覆盖 Issue 事实；
- Issue event：读取 P01.05 的 `event_summary_projection`，raw `issue_events` 仍是 source of truth；
- Run：`issue_runs`；Session 只作为 drill-down link；
- Evidence：`issue_events` 的 log/verification projection，以及 P02.05 关系定位到的 `pi_action_events`；
- Handoff：当前没有独立表，只从 authoritative `pending_verification` event 投影 `draft + legacy_incomplete`，不猜测 Git revision、changed files 或 delivery 结果；
- Approval：`pi_approval_requests`，请求和最终 resolution 分别形成不可移动的 timeline node。

因此重复 rebuild 只会重建可丢弃的 Issue event summary；timeline node 始终由 source authority + immutable local identity 确定性生成，不产生新事实或外部写。

## 2. node contract

公开 envelope 为 `xuanwu.work-timeline.v1`。每个 node 至少包含：

- `id` / `dedupe_key`：`timeline:<kind>:<authority>:<encoded-source-id>`；
- `kind`：`work_event | issue_event | run | evidence | handoff | approval`；
- `event_name`、`occurred_at`、`status`、`title`、`summary`；
- `work_id`；
- `source.authority | external_id | projection`，其中 projection 为 `authority | summary | derived`；
- `source_links`：至少包含 Work、Issue，并按 source 增加 raw/summary event、Run、PI Activity 或 Approval 查询入口；
- `payload`：只保留现有 summary/typed repository 的脱敏字段，不暴露 approval raw payload 或 Run runtime metadata。

Issue event 的确定性语义映射为：

| source | timeline kind / event |
| --- | --- |
| `issue.created` | `work_event / work.created.v1` |
| `issue.status_changed` | `work_event / work.status_changed.v1` |
| `issue.status_changed -> pending_verification` | `handoff / handoff.prepared.v1`，固定 `draft + legacy_incomplete` |
| log / verification report / review | `evidence / evidence.recorded.v1` |
| 其他 Issue event | `issue_event / 原 type` |
| `issue_runs` start/end | `run.created.v1` / `run.status_changed.v1` |
| `pi_action_events` | `evidence.recorded.v1` |
| Approval create/resolve | `attention.opened.v1` / `attention.status_changed.v1`，node kind 保留 `approval` |

内部 `work_ledger.*` audit type 保持原名，不冒充尚未批准的公共 Work domain event。

## 3. 排序、游标与去重

- 排序固定为 `(occurred_at DESC, node.id DESC)`；所有时间先规范为 UTC ISO-8601。
- cursor 是不透明 base64url v1 envelope，只包含最后 node 的规范时间和 ID。下一页只读取严格更旧的位置，所以同时间跨源排序稳定，新到达的更晚事件不会挤进已开始的旧页。
- `limit` 默认 50，最大 500；非法/未知版本 cursor 返回稳定 `400 invalid_cursor`。
- 构建阶段按 `dedupe_key` 去重。Run start/end、Approval request/resolve 使用不同 phase identity；同一 source rebuild 保持相同 node ID。
- `summary_projection` 明确是 **当前 page** 的 kind 计数、最新时间和 Issue event projection 状态，不伪装成全量统计。

## 4. HTTP contract

```text
GET /api/works/:id/timeline?limit=50&cursor=<opaque>
```

响应包含 `items`、`has_more`、`next_cursor`、`limit`、`summary_projection`、`source_of_truth`、现有 Work `compatibility` policy 和 `work_id`。Work ID、auth 和错误边界复用现有 Work HTTP API；该 route 无 mutation、LLM gate 或 destructive side effect。

## 5. 兼容、迁移、回滚与删除门禁

- **双写：无。** 所有 source 保持原 authority。
- **双读：有边界。** 新 Work client 使用统一 endpoint；legacy Issue event/Run/PI APIs 继续作为 drill-down 和 rollback path。W1/W2 合计仍不得超过两个正式 release observation window。
- **冲突：** G4 前 Issue/Run/PI authority 获胜；`work_events` 只能显示审计，不能反向改 Issue。
- **回滚：** 注销 timeline route 与 query module；不迁移、不删除任何 source/projection row。
- **最终删除：** 仍要求 P11.05/P11.09、G7、零 legacy consumer、正式库 rebuild/parity、备份恢复演练和观察窗全部通过。任一门禁缺失都保留旧 API 和 source tables。

## 6. 验证

定向测试覆盖：

1. Work/Issue/Run/Evidence/Handoff/Approval 跨源排序与 source links；
2. opaque keyset cursor、同时间 tie-break 和分页期间新增更晚事件；
3. summary projection 全量 rebuild 前后 node ID 完全一致且无重复；
4. HTTP 正常分页、非法 cursor/limit；
5. 12,000 条 Issue event 首屏 benchmark，并断言查询计划使用 `idx_event_summary_projection_issue`。
