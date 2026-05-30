# Codex Issue Runner

本地 Codex App Server 驱动的 Issue Loop Runner，用于管理多个本地项目的 issue 队列，并自动调用 Codex 执行任务。

第一版目标见 [`docs/design.md`](docs/design.md)；Go 后端与 Codex app-server 的运行时对接见 [`docs/codex-integration.md`](docs/codex-integration.md)。当前已具备：

- Go API Server（默认 `0.0.0.0:3008`，支持局域网访问）
- SQLite 持久化（默认 `data/app.db`）
- Projects / Issues REST API
- 全局 SSE：`GET /api/events`
- 项目 auto-run / loop start-stop
- issue enqueue / retry / cancel
- Triage cron：到点批量将 Triage issue 切到 Todo 并启动运行
- 通过 `codex app-server --listen stdio://` 执行 todo issue
- 前端 Vite proxy 默认指向 Go stable `/api -> http://127.0.0.1:3008`；可通过 `VITE_API_TARGET` 显式切到 Bun preview
- Dashboard Codex token 用量统计：今日/周/月 token、最近 7 天趋势、5 小时/周限额剩余量

## Dashboard 用量统计

Dashboard 会从本机 Codex session JSONL 里的 `token_count` 事件聚合用量，展示每日、周、月 token 统计，以及最新 5 小时限额和周限额的已用/剩余百分比。

![Dashboard Codex token 用量统计](docs/assets/codex-usage-dashboard.jpg)

## 本地启动

一键启动前后端：

```bash
./dev.sh
```

后端默认监听 `0.0.0.0:3008`，前端默认监听 `0.0.0.0:3568`；本机可访问 `http://127.0.0.1:3008` / `http://127.0.0.1:3568`，局域网设备可用本机 LAN IP 访问。
`./dev.sh` 是前台开发模式：终端退出后服务会停止，不适合作为长期后台服务。

也可以分别启动。后端：

```bash
go run ./backend/cmd/codex-issue-runner
```

前端：

```bash
cd frontend
npm run dev
```

默认前端开发代理会访问 Go stable `http://127.0.0.1:3008`。如需本地验证 Bun preview，不改默认配置，显式指定 API target：

```bash
cd frontend
VITE_API_TARGET=http://127.0.0.1:3018 npm run dev
```

如果要用 `vite preview` 预览已构建产物，也使用同一个 target：

```bash
cd frontend
npm run build
VITE_API_TARGET=http://127.0.0.1:3018 npm run preview
```

可选后端配置：

```bash
CODEX_RUNNER_ADDR=0.0.0.0:3008 \
CODEX_RUNNER_DB=data/app.db \
CODEX_RUNNER_CODEX_CMD=codex \
go run ./backend/cmd/codex-issue-runner
```

生产/部署模式下后端也可以直接托管前端构建产物：

```bash
cd frontend && npm run build
cd ..
go run ./backend/cmd/codex-issue-runner serve \
  --addr 0.0.0.0:3008 \
  --db data/app.db \
  --web-dir frontend/dist
```

## 一键安装部署（推荐）

如果只是使用 Codex Issue Runner，推荐直接安装 GitHub Release 里的预构建二进制；脚本会自动下载当前系统架构的 release，并注册为后台服务（macOS 使用 launchd，Linux 使用 user systemd）：

```bash
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

固定版本安装：

```bash
export CODEX_RUNNER_VERSION=v0.1.0
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

常用覆盖项：

```bash
export CODEX_RUNNER_ADDR=0.0.0.0:3018
export CODEX_RUNNER_STATE_DIR=$HOME/.local/state/codex-issue-runner
export CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex
export CODEX_RUNNER_AUTH_TOKEN=your_custom_token  # 自定义 API 访问令牌 (可选)
export CODEX_RUNNER_ALLOWED_ORIGINS=https://runner.example.com  # 远程 Web UI / 反代 origin allowlist（可选）
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

默认安装位置：

```txt
二进制: ~/.local/bin/codex-issue-runner
数据:   ~/.local/state/codex-issue-runner/app.db
访问:   http://127.0.0.1:3008/（局域网使用 http://<本机LAN-IP>:3008/）
```

## 从源码后台部署（macOS launchd）

本仓库也提供 macOS LaunchAgent 源码部署脚本，会构建前端与 Go 二进制，并把服务注册为后台长期运行：

```bash
./deploy.sh
```

如果只是想把当前源码重新构建并切到 live 服务，同时做部署后验活，可以执行：

```bash
./redeploy.sh
```

部署后访问：

```txt
http://127.0.0.1:3008/（局域网使用 http://<本机LAN-IP>:3008/）
```

常用运维命令：

```bash
# 查看 launchd / 端口 / API 状态
./scripts/status-launchd.sh

# 查看产品内 runtime doctor/status（需要 API token）
codex-issue-runner system status --token "$(cat data/auth_token)" --json

# 停止并移除后台服务
./scripts/uninstall-launchd.sh
```

默认配置：

```txt
服务名: com.xiaobei.codex-issue-runner
监听:   0.0.0.0:3008
DB:     data/app.db
Web:    内嵌在二进制中（可用 CODEX_RUNNER_WEB_DIR 覆盖）
二进制: dist/codex-issue-runner
日志:   data/logs/launchd.out.log / data/logs/launchd.err.log
Token:  默认在服务首次启动时自动生成并写入 data/auth_token 文件中
```

macOS 会按二进制代码签名身份记录“文稿/Documents”等隐私授权。源码部署默认会优先使用本机 `Apple Development` 证书和固定 bundle id `com.xiaobei.codex-issue-runner` 签名，避免每次 build 后被当成新的 ad-hoc 程序；如需指定其他证书：

```bash
CODEX_RUNNER_CODESIGN_IDENTITY="Apple Development: Your Name (TEAMID)" ./redeploy.sh
```

可通过环境变量覆盖：

```bash
CODEX_RUNNER_ADDR=0.0.0.0:3018 \
CODEX_RUNNER_DEPLOY_DB=/absolute/path/app.db \
CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex \
CODEX_RUNNER_AUTH_TOKEN=your_custom_token \
CODEX_RUNNER_ALLOWED_ORIGINS=https://runner.example.com \
./deploy.sh
```

### 本地 / 远程安全建议

- 本机使用优先监听 `127.0.0.1`；需要局域网或反代时才监听 `0.0.0.0`。
- 远程访问必须启用 bearer token。默认 token 文件会自动生成在 `data/auth_token` 或 release state dir `auth_token`，权限为 `0600`；不要提交 token 文件，也不要把 token 写入日志、issue 或截图。
- 浏览器 Origin 默认只允许本机 origin（`localhost` / `127.0.0.1` / `::1`）。远程 Web UI 或反代域名需设置 `CODEX_RUNNER_ALLOWED_ORIGINS` / `--allowed-origins`，不要使用 `*` 作为长期配置。
- `/health` 免鉴权用于健康检查；`/api/*`、`/api/system/status`、`/api/system/doctor`、SSE `/api/events` 都会走 token / origin 检查。
- 对公网访问推荐 `127.0.0.1` 绑定 + SSH tunnel / Caddy / nginx 反代并在反代层启用 HTTPS；当前 v1 不自动安装自签 CA / Keychain 信任。


## GitHub Release 发布

推送 `v*` tag 后，GitHub Actions 会自动运行后端测试、构建内嵌前端的单文件二进制，并发布 Release 资产：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Release 默认包含：

```txt
codex-issue-runner_darwin_arm64.tar.gz
codex-issue-runner_darwin_amd64.tar.gz
codex-issue-runner_linux_arm64.tar.gz
codex-issue-runner_linux_amd64.tar.gz
checksums.txt
```

本地也可以手动打包：

```bash
./scripts/package-release.sh
```

本地 release/package 会先做发布前门禁：`go test ./backend/...`、`frontend` 的 `npm run lint` / `npm run build`，然后再打包并校验产物；任一步失败都会直接退出并阻断发布。

## CLI 调用

同一个二进制同时支持后端服务和短命令 CLI：

```bash
# 后台服务；不写子命令时也保持兼容，默认等价于 serve
go run ./backend/cmd/codex-issue-runner serve --addr 0.0.0.0:3008 --db data/app.db

# 创建项目并开启 auto-run
codex-issue-runner project create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --id movo-web \
  --cwd /Users/xiaobei/Documents/rcrai/movo-web \
  --auto-run \
  --json

# 创建 Triage/backlog issue；不加 --run 时不会自动执行
codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project movo-web \
  --title "修复 ChatInput Stop 按钮" \
  --body-file /tmp/issue.md \
  --status triage \
  --json

# 创建 issue，并立即 enqueue 进入自动化执行
codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project movo-web \
  --title "修复 ChatInput Stop 按钮" \
  --body-file /tmp/issue.md \
  --status todo \
  --run \
  --json

# 查询状态 / 日志 / 重试 / 取消
codex-issue-runner issue status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42
codex-issue-runner issue logs --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42
codex-issue-runner issue update --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --status done --json
codex-issue-runner issue retry --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json
codex-issue-runner issue cancel --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json

# 查看 runner / DB / Codex command 只读健康摘要
codex-issue-runner system status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --json

# macOS launchd 本机服务生命周期 v1
codex-issue-runner daemon status --json
codex-issue-runner daemon logs --lines 80
codex-issue-runner daemon restart --json
```

CLI 默认连接 `CODEX_RUNNER_ADDR`，未设置时使用 `127.0.0.1:3008`；也可以对任意命令传 `--addr http://127.0.0.1:3008`。
`daemon status/restart/logs` 第一版只支持当前 `scripts/install-launchd.sh` 安装出的 macOS launchd 服务；`status/restart --json` 会输出 `loaded/running/pid/label/listen_addr/version/build_stamp/http_ok/db_ok/log_paths`，`restart` 在 `launchctl kickstart -k` 后会重新验证 `/api/system/status`。`logs` 只 tail launchd stdout/stderr 路径，并会隐藏包含 token/Authorization 的敏感行。
当前 CLI 子命令不实现 `--help`，`--json` 输出是完整 JSON 文档且可能跨多行。

## Codex Skill（可选）

仓库内置了一个 Codex skill，方便 Codex 在会话里创建、查询、重试、取消和显式完成 runner issue：

```bash
./scripts/install-codex-skill.sh
```

安装后 skill 会写入 `${CODEX_HOME:-$HOME/.codex}/skills/codex-issue-runner/SKILL.md`。源码位于 `skills/codex-issue-runner/SKILL.md`，可随仓库一起开源和审查。

## Triage Cron

可以在 Issues 看板右上角点「定时运行 Triage」，或在 Settings 里统一管理 cron 任务。

- `once`：到指定时间运行一次，完成后状态变为 `done`
- `daily`：每天在指定 `HH:MM` 运行一次
- `project_id` 为空时处理所有项目；填写项目 id 时只处理该项目
- 触发后会把匹配范围内所有 `triage` issue 更新为 `todo`，记录状态事件，并启动受影响项目的 runner loop

API 示例：

```bash
curl -X POST http://127.0.0.1:3008/api/cron-tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "12点运行所有 Triage",
    "mode": "once",
    "next_run_at": "2026-05-21T04:00:00Z"
  }'
```

## 验证

```bash
go test ./backend/...
cd frontend && npm run build
```

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，仅允许非商业目的使用。
商业使用、商业部署或将本项目作为商业产品/服务的一部分使用，需要获得项目作者的单独商业授权。

项目所有者保留对本项目进行商业化、专有版本发布或闭源发行的权利。

分发本项目或其衍生版本时，请同时保留 `LICENSE` 与 `NOTICE`。
