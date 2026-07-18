# Issues/Sessions compat v1 迁移指南

`xw.legacy-issues-sessions.compat.v1` 从玄武 `v0.2.x` 开始标记旧 Issues/Sessions 用户路由和 HTTP API。
兼容保留到 `v0.3.x`；最早移除版本是 `v0.4.0`，且仍需 ADR-XW-0081 的 consumer-zero/G7 门禁。

## 前端 route

| 旧调用 | canonical 调用 |
| --- | --- |
| `navigateTo('issues')` | `navigateTo('work')` |
| `navigateTo('issues', 740)` | `navigateTo('work', 'xw:work:issues:740')` |
| `navigateTo('sessions', null, sessionRef)` | `navigateTo('runs', null, runId)`；只有 provider observation 没有 Run 时才保留旧 session ref drill-down |

旧 route 不会 404：Work flag 开启时 redirect 并显示 warning；关闭时恢复旧 Issues rollback surface。

## HTTP client

- Work list/detail/create/update/control 改用 `/api/works*`；Issue-backed Work ID 固定为
  `xw:work:issues:<issue_id>`。当前 storage authority 仍是 Issues，但两个 API 共用同一 adapter，client 不应直接依赖表。
- Work execution list/detail/control 改用 `/api/runs*`。`/api/sessions*` 只保留 provider transcript observation 和
  不属于 Work 的独立 provider conversation。
- 兼容响应会包含：

  ```text
  Deprecation: true
  Sunset: Fri, 01 Jan 2027 00:00:00 GMT
  X-Codex-Compat-Version: xw.legacy-issues-sessions.compat.v1
  X-Codex-Canonical-Resource: /api/works  # 或 /api/runs
  Link: </api/compatibility/legacy>; rel="deprecation"; type="application/json"
  ```

status code、required fields、JSON body 与错误语义在 compat v1 内保持不变。未知新增 header 必须被旧 client 忽略。

## CLI

新自动化优先使用：

```bash
codex-issue-runner work create \
  --project demo --title 'Example' --goal 'Deliver example' \
  --occurred-at '2026-07-18T00:00:00Z' --idempotency-key example-1 --json
codex-issue-runner work status --id 'xw:work:issues:740' --json
codex-issue-runner work timeline --id 'xw:work:issues:740' --json
```

`issue create/status/update/retry/cancel/logs/verification` 在 compat v1 内继续工作。现阶段 Work CLI 尚未覆盖的
final-status、retry、cancel 等调用不要自行拼接新状态机；继续使用 Issue CLI，直到发布等价 canonical contract。

## 验证与观察

```bash
curl -fsS -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/compatibility/legacy"
```

按 `usage[].client` 区分 `xuanwu-web`、`codex-issue-runner-cli` 与未知 HTTP client。移除观察只统计 external/CLI
consumer；Web 对底层 authority 的受控 adapter 调用必须与旧 page-id redirect 分开审计。没有一个完整正式 release
的零消费者 Evidence 时，不得删除 compatibility route 或返回 404。
