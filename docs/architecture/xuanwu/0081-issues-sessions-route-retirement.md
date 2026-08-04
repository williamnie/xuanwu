# ADR-XW-0081：Issues/Sessions 用户路由退役与 compat v1

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P11.05 / Runner #740
- 硬依赖：P02.09 / #655、P03.07 / #662、P07.08 / #700、P07.09 / #701、P10.12 / #735（执行前均为 `done`）
- 迁移指南：[`docs/migrations/issues-sessions-compat-v1.md`](../../migrations/issues-sessions-compat-v1.md)

## Live reference 与退出边界

2026-07-18 对 launchd/3008 做只读检查：

- `GET /api/works?page=1&page_size=1` 返回 200、744 个 Work，声明 `read_authority=issues`、
  `write_authority=issues-via-work-adapter`、`dual_read=none`、`target_shadow=disabled`；
- `GET /api/runs?page=1&page_size=1` 返回 200、736 个 Run，声明 `read_authority=issue_runs`、
  `attempt_authority=run_attempts-child-facts`、`session_authority=agent_sessions-observation-only`；
- 旧 `GET /api/issues?projectId=xuanwu` 和 `GET /api/sessions?limit=1` 仍分别返回 200，
  证明 CLI、provider drill-down 和旧 client compatibility 不能静默删除；
- 前端已有 Work/Runs 一级导航，但 `issues` 仍能挂载旧 Issues 页面，Work 内部链接也会回到旧 Issue detail；
  `sessions` 虽已解析到 Runs，兼容视图仍缺少明确版本、截止期和可查询使用量。

因此本 issue 只退出旧**用户路由**并启动 API deprecation 观察，不删除 `/api/issues*`、`/api/sessions*`、
`Issues.jsx`、`Sessions.jsx`、表或 authority。旧组件仍是关闭 Work feature flag 时的可重部署 rollback artifact，
Sessions 组件继续承载 Runs 内的 provider observation/独立对话。

## Route、warning 与 telemetry

- Work flag 开启时，`issues` 确定性 redirect 到 `work`；`issues + issue_id` 映射为
  `xw:work:issues:<issue_id>` 并打开同一 Work detail。flag 关闭时仍回到旧 Issues 页面，不产生死入口。
- `sessions` 继续 redirect 到 `runs`；带 provider session ref 的旧链接进入明确标记的 Runs drill-down。
- 每次旧 route redirect 显示 compat warning，并向 `POST /api/compatibility/legacy/usage` 写一条
  `compatibility.legacy_used.v1` 审计事件。写 telemetry 失败不阻断 redirect。
- Runtime 对成功鉴权后的 `/api/issues*`、`/api/sessions*` 响应增加 `Deprecation`、`Sunset`、
  `Link`、`X-Codex-Compat-Version`、`X-Codex-Canonical-Resource` headers，body/status/error 语义不变。
- Web 与 CLI 分别发送 `X-Codex-Client: xuanwu-web`、`xuanwu-cli`。聚合使用量从
  `GET /api/compatibility/legacy` 查询，按 surface/family/client/method/normalized path/status 汇总；
  不创建 telemetry 表或第二 truth source。

compat contract 是 `xw.legacy-issues-sessions.compat.v1`。它覆盖到 `v0.3.x`，最早移除版本是
`v0.4.0`，HTTP `Sunset` 为 `2027-01-01T00:00:00Z`。日期/版本只是 not-before，不会自动授权删除。

## Authority、并存与回滚

- **Work：** `issues + issue_events` 仍是当前 source of truth；Work HTTP 与 compat Issue HTTP 共用同一确定性
  domain/adapter，不新增双写、双读或 shadow。本 issue 不宣称 Work storage 已切换。
- **Run：** `issue_runs + run_attempts` 是 lifecycle authority；`agent_sessions` 与 provider transcript 只作
  observation。旧 Session create/message 能力不写 Run lifecycle。
- **回滚：** 恢复前一 release artifact，或关闭 `VITE_WORK_BOARD_ENABLED` 重新构建前端。DB、event、Issue、Run、
  Session 都无需反向迁移；telemetry 是 append-only audit，可保留。
- **CLI：** `issue` 子命令在 compat v1 内保持 status、required fields、exit code 与 JSON body 语义；已有
  `work create/status/result/timeline` 可迁移的调用应优先迁移。没有 Work 等价命令的 final-status/retry/cancel
  仍使用 Issue CLI，直到后续 canonical CLI contract 落地，不能提前删除。

## 最终 removal checklist

以下项目必须全部有 retained Evidence，且由非 LLM actor 在 G7 精确审批后，才可在独立 change 删除 route/API/code：

- [ ] 至少一个完整正式 release 窗口中，`GET /api/compatibility/legacy` 证明 external/CLI legacy consumer 为零；
- [ ] Web 内部旧 page-id caller 为零，旧 Issues link 与 Sessions deep link contract snapshot 已留档；
- [ ] CLI 的 create/status/final-status/retry/cancel 等价 contract 已发布并完成 migration smoke；
- [ ] Work authority cutover、Run/Sessions observation 边界和 Golden Journey 无 parity drift；
- [ ] previous release artifact 可针对 unchanged authority 完成 rollback smoke；
- [ ] fresh backup、隔离 restore、API contract archive 与 source revision digest 已记录；
- [ ] 无 active Session/approval/interrupt 或 provider conversation 依赖待删除 route；
- [ ] P11.09、G7 和 item-specific destructive approval 已完成。

任一项失败，继续保留 compat v1 并重新开始观察窗；不得把 `Sunset` 日期当成删除授权，也不得返回静默 404。
