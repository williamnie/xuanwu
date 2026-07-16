# ADR-XW-0025：Run progress read projection 与紧凑时间线

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.06 / Runner #661
- 依赖：[ADR-XW-0022](0022-provider-run-event-contract.md)、[ADR-XW-0009](0009-event-summary-projection.md)
- 可执行实现：`backend-ts/src/events/runProgressProjector.ts`、`backend-ts/src/db/repositories/runProgress.ts`

## 1. source of truth 与边界

Run lifecycle authority 继续是 `issue_runs`，Attempt child facts 继续是 `run_attempts`。P03.03 持久化在
`issue_events(type=issue.log).payload.run_event` 的 `xw.run-event.v1` 是 provider progress Evidence；
`agent_sessions.updated_at` 仅作为当前 Session observation 的活跃时间补充。projection 不根据 LLM 文本猜百分比，
provider terminal Evidence 也不能反向关闭 Run 或绕过 P03.04 command gate。

本期使用 `read_through_rebuild`，不新增 progress 表或第二套 Run 状态机。`rebuildRunProgressProjection()`
每次从上述 authority / Evidence 确定性重放，因此没有 projection 双写、游标或 destructive rebuild。
P01.05 的 raw-event authority、保留分级和可重建约束继续适用；raw `issue_events` 未满足删除门禁前不得以本时间线替代审计事实。

## 2. projection 规则

- provider event 先按 `created_at + issue_events.id` 稳定排序，再按 provider session / turn / Attempt 时间窗映射；
- 相同 Attempt、provider source、kind/outcome、metadata 和安全摘要的重复 Evidence 只推进一次，并保留 duplicate count；
- `started → progress → approval requested → approval resolved → terminal` 形成 phase summary；generic progress 不会越过 waiting approval，terminal 后的迟到 progress 被计为 ignored，进度不倒退；
- timeline 只保存连续 phase segment，默认最多 64 段；完整 raw Evidence 仍通过 Issue event links 读取；
- `latest` 只来自合法的 `xw.run-event.v1`。未知或损坏 event 不改变 phase，分别进入 ignored / invalid 计数；
- `stalled` 是只读 signal：active Run 在 15 分钟内没有 provider、Attempt 或 Session activity 时置位；waiting approval 单独标识，不冒充 stalled，更不自动触发 retry/interruption。

## 3. 查询与 system status

`GET /api/runs` 保留原有 authoritative `progress.phase/attempt_status`，附加紧凑 projection summary；列表不返回 timeline segment。
`GET /api/runs/:id` 同一 `progress` 返回 phase summary、latest、stalled、replay counters 和 bounded timeline。

`/api/system/status.run_progress_projection` 暴露 projector version、source of truth、active/stalled/waiting-approval
计数与最新 normalized source event id。该状态表示 read-through projector 可用性，不把 stalled Run 误报成 projector 故障。

## 4. 兼容、回滚与删除门禁

| window | authority / 读写 |
| --- | --- |
| W1（当前） | `issue_runs` lifecycle primary；Run API 读取 read-through progress；legacy Issue/Session 页面不变 |
| W2（最多一个正式 release） | 新 Run 时间线 primary，旧 Issue logs / Session timeline 保留 drill-down 与 parity fallback |

- **双写期限：** 0；本期没有 progress 持久化写入。
- **双读期限：** W2 最多一个正式 release；发现 Attempt 关联、phase 或 stalled parity drift 时回滚到 P03.05 基础 progress。
- **代码回滚：** 从 `runs.ts` / `systemStatus.ts` 移除 projection 调用即可；不删除或修改 raw event、Attempt、Session。
- **最终删除门禁：** P11.05、G7、一个 W2 parity release、乱序/重复 fixture parity、备份恢复演练、所有旧 timeline consumer 清零及 raw retention hold/reference gate 全部通过后，才可独立评估旧读取路径；本 issue 不删除数据或 route。

## 5. 最小验证

```bash
cd backend-ts
bun test \
  src/events/runProgressProjector.test.ts \
  src/db/repositories/runProgress.test.ts \
  src/http/runApi.test.ts \
  src/http/systemStatus.test.ts
```

fixture 覆盖乱序/重复 replay、terminal 后迟到 progress、approval wait、20,000 条 progress 的有界聚合、
repository rebuild、Run detail 接线和 system status signal。
