# Codex 后端 Server 对接说明

本文说明 Codex Issue Runner 的 Bun/TypeScript 后端如何对接 Codex 后端 server（`codex app-server`），以及 issue 自动执行、Sessions 页面、审批和事件流在两边之间如何流转。

## 术语边界

- **Issue Runner Bun 后端**：本仓库的 HTTP API、SQLite、runner loop 和 SSE 服务，入口在 `backend-ts/src/main.ts`。
- **Codex 后端 server**：由 Bun 后端拉起的子进程，默认命令是 `codex app-server --listen stdio://`。
- **Codex provider adapter**：`backend-ts/src/providers/codex`，负责把内部 provider 调用转换为 Codex app-server 的 JSON-RPC 请求，并把 Codex notification 规范化为内部事件。
- **CLI 客户端模式**：同一个 `codex-issue-runner` Bun 二进制在非 `serve` 子命令下会作为短命令 CLI，调用 Issue Runner HTTP API 创建、查询、更新 issue。

## 启动与配置

Bun 后端启动时会创建 provider adapter，但不会立刻拉起 Codex app-server；第一次需要 Codex 能力时才 lazy start。

默认配置来自 `backend-ts/src/config/env.ts`：

```txt
CODEX_RUNNER_ADDR             默认 127.0.0.1:3008（源码 launchd 使用 0.0.0.0:3008）
CODEX_RUNNER_STATE_DIR        默认 data-bun
CODEX_RUNNER_DB               默认 <state-dir>/runner.db
CODEX_RUNNER_AUTH_TOKEN_FILE  默认 <state-dir>/auth_token
CODEX_RUNNER_CODEX_CMD        默认 codex app-server --listen stdio://
CODEX_RUNNER_WEB_DIR          默认空；源码/Release 部署会传入已构建 web 目录
```

等价启动示例：

```bash
./dist/codex-issue-runner serve \
  --addr 0.0.0.0:3008 \
  --state-dir data-bun \
  --db data-bun/runner.db \
  --web-dir frontend/dist \
  --codex-cmd codex
```

服务装配顺序：

1. 解析配置并打开 SQLite。
2. 创建 provider runtime（Codex / Claude）。
3. 注册 HTTP API、SSE、system status/logs、静态前端。
4. 恢复 in-progress issue 状态。
5. 启动 auto-run project loop 和 PI auto-manage scheduler。

## Codex app-server 协议

当前对接方式是 **stdio JSON-RPC line protocol**：

- Bun 后端通过子进程启动 `codex app-server --listen stdio://`。
- 每个请求是一行 JSON，写入 Codex 进程 stdin。
- Codex 的 stdout 每行是一条 JSON message，stderr 会作为 provider/runtime 事件暴露。
- adapter 用递增 `id` 维护 pending request；收到同 id response 后唤醒对应调用。

主要 RPC 能力包括：

- `initialize`
- `model/list`
- `thread/start`
- `thread/list`
- `thread/read`
- `thread/resume`
- `thread/name/set`
- `turn/start`
- `turn/interrupt`
- approval / server request response

## Issue 自动执行链路

```mermaid
sequenceDiagram
  participant CLI as codex-issue-runner CLI / Web
  participant API as Bun HTTP API
  participant DB as SQLite
  participant Runner as Runner Loop
  participant Provider as Codex Provider
  participant Codex as codex app-server
  participant SSE as /api/events

  CLI->>API: POST /api/issues
  API->>DB: insert issue(status=triage 或 todo)
  CLI->>API: POST /api/issues/{id}/enqueue (--run)
  API->>DB: status=todo
  API->>Runner: kick project loop
  Runner->>DB: ClaimNextIssue(todo -> in_progress)
  Runner->>Provider: create/resume thread + start turn
  Provider->>Codex: initialize + thread/start + turn/start
  Codex-->>Provider: thread id / turn id / notifications
  Runner->>DB: 写 issue_runs / issue_events
  Runner->>SSE: issue.log / agent events
  Codex->>CLI: agent/provider 执行状态回写
  CLI->>API: PATCH /api/issues/{id} status=done/failed
```

关键行为：

1. `issue create --run` 实际是先 `POST /api/issues`，再 `POST /api/issues/{id}/enqueue`。
2. runner loop 只 claim `todo` issue；`triage` 默认不自动执行。
3. 每个 issue 会创建或绑定独立 provider session，避免不同任务上下文互相污染。
4. agent/provider 输出不会直接改 issue 状态；它必须在验证完成后按执行契约显式回写最终状态。
5. 如果 provider run completed 但 issue 仍不是 `done` / `failed` / `cancelled`，runner 会把 issue 标为 failed，避免“模型说做完了但没有真实验收/回写状态”的假完成。

更多 provider-neutral 契约见 `docs/agent-execution-contract.md`。

## Sessions API 与 Codex threads

Sessions 页面直接消费 provider session/thread 能力。Codex provider 支持：

| HTTP API | Codex RPC |
| --- | --- |
| `GET /api/sessions?limit=&cursor=` | `thread/list` |
| `GET /api/sessions/{threadId}` | `thread/read` / `thread/resume` |
| `POST /api/sessions` | `thread/start`，有 prompt 时再 `turn/start` |
| `POST /api/sessions/{threadId}/messages` | `thread/resume` + `turn/start` |
| `POST /api/sessions/{threadId}/interrupt` | `turn/interrupt` |

## Agent/provider 通过 CLI 或 API 反向更新 Runner

agent/provider 在执行 issue 时不直接访问 SQLite，而是通过短命令 CLI 调 Runner API。CLI 默认读取 `CODEX_RUNNER_ADDR`，未设置时连接 `127.0.0.1:3008`。

示例（只传 token file 路径，不输出实际 token）：

```bash
./dist/codex-issue-runner issue status --addr 127.0.0.1:3008 --id <issue-id> --token-file <state-dir>/auth_token --json
./dist/codex-issue-runner issue update --addr 127.0.0.1:3008 --id <issue-id> --status done --token-file <state-dir>/auth_token --json
./dist/codex-issue-runner system status --addr 127.0.0.1:3008 --token-file <state-dir>/auth_token --json
```

如果 CLI 不可用，provider 必须使用 API 等价更新：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

确认 project id 时，当前 CLI 没有 `project list`，直接查 API：

```bash
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/projects"
```

Runtime 状态：

```bash
curl -fsS http://127.0.0.1:3008/health
./dist/codex-issue-runner system status --addr 127.0.0.1:3008 --token-file <state-dir>/auth_token --json
```

`/api/system/status` 只返回只读健康摘要：API/DB、脱敏后的配置、provider command 是否存在、runner loop/hold/in_progress 计数；不会返回 token 值，也不会为 status 主动拉起新的 Codex 深度探针。

## 本地 / 远程 transport 安全

- `/health` 免鉴权，供 launchd / systemd / 反代健康检查使用。
- `/api/*`（包括 `/api/system/status`、`/api/system/doctor`、SSE `/api/events`）属于敏感 API；启用 token 时必须携带 `Authorization: Bearer ...` 或 UI cookie。
- 默认浏览器 Origin 策略只允许本机 origin（`localhost` / `127.0.0.1` / `::1`）。
- 远程访问必须启用 token。推荐保留默认生成的 state dir `auth_token`（权限 `0600`），或用 `CODEX_RUNNER_AUTH_TOKEN_FILE` 指向权限受限文件；不要提交 token 文件。
- 对公网暴露时优先绑定 `127.0.0.1` 并通过 SSH tunnel、Caddy 或 nginx 反代终止 HTTPS。
