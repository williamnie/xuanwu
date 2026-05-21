# Codex Issue Runner

本地 Codex App Server 驱动的 Issue Loop Runner，用于管理多个本地项目的 issue 队列，并自动调用 Codex 执行任务。

第一版目标见 [`docs/design.md`](docs/design.md)。当前已具备：

- Go API Server（默认 `127.0.0.1:3008`）
- SQLite 持久化（默认 `data/app.db`）
- Projects / Issues REST API
- 全局 SSE：`GET /api/events`
- 项目 auto-run / loop start-stop
- issue enqueue / retry / cancel
- 通过 `codex app-server --listen stdio://` 执行 todo issue
- 前端 Vite proxy 已指向后端 `/api -> http://127.0.0.1:3008`

## 本地启动

一键启动前后端：

```bash
./dev.sh
```

后端默认启动在 `http://127.0.0.1:3008`，前端默认启动在 `http://127.0.0.1:3568`。

也可以分别启动。后端：

```bash
go run ./backend/cmd/codex-issue-runner
```

前端：

```bash
cd frontend
npm run dev
```

可选后端配置：

```bash
CODEX_RUNNER_ADDR=127.0.0.1:3008 \
CODEX_RUNNER_DB=data/app.db \
CODEX_RUNNER_CODEX_CMD=codex \
go run ./backend/cmd/codex-issue-runner
```

## 验证

```bash
go test ./backend/...
cd frontend && npm run build
```
