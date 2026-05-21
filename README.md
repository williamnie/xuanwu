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

## CLI 调用

同一个二进制同时支持后端服务和短命令 CLI：

```bash
# 后台服务；不写子命令时也保持兼容，默认等价于 serve
go run ./backend/cmd/codex-issue-runner serve --addr 127.0.0.1:3008 --db data/app.db

# 创建项目并开启 auto-run
codex-issue-runner project create \
  --id movo-web \
  --cwd /Users/xiaobei/Documents/rcrai/movo-web \
  --auto-run \
  --json

# 创建 issue，并立即 enqueue 进入自动化执行
codex-issue-runner issue create \
  --project movo-web \
  --title "修复 ChatInput Stop 按钮" \
  --body-file /tmp/issue.md \
  --run \
  --json

# 查询状态 / 日志 / 重试 / 取消
codex-issue-runner issue status --id 42
codex-issue-runner issue logs --id 42
codex-issue-runner issue retry --id 42 --json
codex-issue-runner issue cancel --id 42 --json
```

CLI 默认连接 `CODEX_RUNNER_ADDR`，未设置时使用 `127.0.0.1:3008`；也可以对任意命令传 `--addr http://127.0.0.1:3008`。

## 验证

```bash
go test ./backend/...
cd frontend && npm run build
```
