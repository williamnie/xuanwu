# 玄武 (Xuanwu)

**玄武**是本地优先、验证优先的 AI Engineering Control Plane：把工程目标变成可追踪的工作，交给 Coding Agents 长时间执行，并以可审计的监督、恢复、验证和交付闭环收口。Codex Issue Runner 是当前仓库、CLI 与兼容 API 的名称。

产品定位、用户承诺、非目标和迁移原则以 [ADR-XW-0001](docs/architecture/xuanwu/0001-product-positioning.md) 为准；产品、Supervisor、Runner 与兼容标识的命名以 [玄武品牌术语合同](docs/architecture/xuanwu/0002-brand-terminology.md) 为准。

当前后端已经切到 Bun/TypeScript，live 默认监听 `0.0.0.0:3008`，CLI 默认连接 `127.0.0.1:3008`。

当前已具备：

- Bun API Server（默认 `0.0.0.0:3008`，支持局域网访问）
- SQLite 持久化（默认 live state 下的 `runner.db`）
- Projects / Issues REST API
- 全局 SSE：`GET /api/events`
- 项目 auto-run / loop start-stop
- issue enqueue / retry / cancel
- Triage cron：到点批量将 Triage issue 切到 Todo 并启动运行
- 通过 `codex app-server --listen stdio://` 执行 todo issue
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
cd backend-ts
bun run src/main.ts serve --addr 0.0.0.0:3008 --state-dir ../data-bun --db ../data-bun/runner.db
```

前端：

```bash
cd frontend
npm run dev
```

前端 Vite proxy 默认指向 live API `http://127.0.0.1:3008`。如果需要临时指向其他 API，可显式指定：

```bash
cd frontend
VITE_API_TARGET=http://127.0.0.1:3999 npm run dev
```

生产/部署模式下后端直接托管已构建前端产物：

```bash
cd frontend && npm run build
cd ../backend-ts && bun run build:binary
../dist/codex-issue-runner serve \
  --addr 0.0.0.0:3008 \
  --state-dir ../data-bun \
  --db ../data-bun/runner.db \
  --web-dir ../frontend/dist
```

## 一键安装部署（推荐）

如果只是使用玄武，推荐直接安装当前仍以 `codex-issue-runner` 兼容名发布的预构建二进制；脚本会自动下载当前系统架构的 release，并注册为后台服务（macOS 使用 launchd，Linux 使用 user systemd）：

```bash
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

常用覆盖项：

```bash
export CODEX_RUNNER_ADDR=0.0.0.0:3008
export CODEX_RUNNER_STATE_DIR=$HOME/.local/state/codex-issue-runner
export CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex
export CODEX_RUNNER_CODEX_SERVER_MODE=cli  # cli 或 app；也可在 Settings 页面切换
export CODEX_RUNNER_AUTH_TOKEN=your_custom_token  # 自定义 API 访问令牌（可选）
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

默认安装位置：

```txt
二进制: ~/.local/bin/codex-issue-runner
数据:   ~/.local/state/codex-issue-runner/runner.db
访问:   http://127.0.0.1:3008/（局域网使用 http://<本机LAN-IP>:3008/）
```

## 从源码后台部署（macOS launchd）

本仓库提供 macOS LaunchAgent 源码部署脚本，会构建前端与 Bun 单文件二进制，并把服务注册为后台长期运行：

```bash
./deploy.sh
```

如果只是想把当前源码重新构建并切到 live 服务，同时做部署后验活，可以执行：

```bash
./redeploy.sh
```

常用运维命令：

```bash
# 查看 launchd / 端口 / API 状态
./scripts/status-launchd.sh

# 查看产品内 runtime doctor/status（需要 API token）
./dist/codex-issue-runner system status --token-file "$HOME/Library/Application Support/codex-issue-runner-bun-live/state/auth_token" --json

# 停止并移除后台服务
./scripts/uninstall-launchd.sh
```

默认配置：

```txt
服务名: com.xiaobei.codex-issue-runner
监听:   0.0.0.0:3008
State:  ~/Library/Application Support/codex-issue-runner-bun-live/state
DB:     ~/Library/Application Support/codex-issue-runner-bun-live/state/runner.db
Web:    state/web
二进制: dist/codex-issue-runner
日志:   ~/Library/Application Support/codex-issue-runner-bun-live/logs/launchd.out.log / launchd.err.log
Token:  默认在服务首次启动时自动生成并写入 state/auth_token 文件中
```

可通过环境变量覆盖：

```bash
CODEX_RUNNER_ADDR=0.0.0.0:3008 \
CODEX_RUNNER_DB=/absolute/path/runner.db \
CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex \
CODEX_RUNNER_CODEX_SERVER_MODE=cli \
CODEX_RUNNER_AUTH_TOKEN=your_custom_token \
./deploy.sh
```

## 首次使用启动器与 Codex Server 选择

Dashboard 的 Settings → Runtime 里有 “首次使用启动器” 和 “Codex server 接入方式”：

- `cli`：默认模式，Runner 独立拉起 `codex app-server --listen stdio://`，适合稳定后台自动执行。
- `app`：使用 Codex App bundled server command 和 App/Chrome 集成环境，适合需要 Codex App / Chrome 能力的任务。

选择是显式的，不做智能 fallback；如果选择 `app` 后 Codex App 或对应集成不可用，新 issue/session 会按当前配置失败。切换设置会保存到 `runner-settings.local.json`，空闲时立即重启 Codex transport；有运行中的 issue/session 时只保存配置，不迁移当前 session，等运行结束后再保存一次或重启服务即可让新任务使用新 server。

### 本地 / 远程安全建议

- 本机使用优先监听 `127.0.0.1`；需要局域网或反代时才监听 `0.0.0.0`。
- 远程访问必须启用 bearer token。默认 token 文件会自动生成在 state dir `auth_token`，权限为 `0600`；不要提交 token 文件，也不要把 token 写入日志、issue 或截图。
- 浏览器 Origin 默认只允许本机 origin（`localhost` / `127.0.0.1` / `::1`）。
- `/health` 免鉴权用于健康检查；`/api/*`、`/api/system/status`、`/api/system/doctor`、SSE `/api/events` 都会走 token / origin 检查。

## GitHub Release 发布

推送 `v*` tag 后，GitHub Actions 会自动运行 Bun 后端测试、前端 lint/build，并发布 Release 资产：

```bash
git tag v0.1.0
git push origin v0.1.0
```

本地也可以手动打包：

```bash
./scripts/package-release.sh
```

## CLI 调用

同一个 Bun 二进制同时支持后端服务和短命令 CLI：

```bash
# 后台服务
./dist/codex-issue-runner serve --addr 0.0.0.0:3008 --state-dir data-bun --db data-bun/runner.db

# 创建项目并开启 auto-run
./dist/codex-issue-runner project create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --id movo-web \
  --cwd /Users/xiaobei/Documents/rcrai/movo-web \
  --auto-run \
  --json

# 创建 Triage/backlog issue；不加 --run 时不会自动执行
./dist/codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project movo-web \
  --title "修复 ChatInput Stop 按钮" \
  --body-file /tmp/issue.md \
  --status triage \
  --json

# 查询状态 / 日志 / 重试 / 取消 / 删除
./dist/codex-issue-runner issue status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42
./dist/codex-issue-runner issue logs --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42
./dist/codex-issue-runner issue update --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --status done --json
./dist/codex-issue-runner issue retry --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json
./dist/codex-issue-runner issue cancel --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json
./dist/codex-issue-runner issue delete --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json

# 查看 runner / DB / Codex command 只读健康摘要
./dist/codex-issue-runner system status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --json
```

`issue delete` 会物理删除 issue，并级联清理其日志、运行记录和评论；运行中的 `in_progress` issue 有保护，必须先 cancel 后才能 delete。

CLI 默认连接 `CODEX_RUNNER_ADDR`，未设置时使用 `127.0.0.1:3008`；也可以对任意命令传 `--addr http://127.0.0.1:3008`。
当前 CLI 子命令不实现 `--help`，`--json` 输出是完整 JSON 文档且可能跨多行。

## Codex Skill（可选）

仓库内置了一个 Codex skill，方便 Codex 在会话里创建、查询、重试、取消和显式完成 runner issue：

```bash
./scripts/install-codex-skill.sh
```

安装后 skill 会写入 `${CODEX_HOME:-$HOME/.codex}/skills/codex-issue-runner/SKILL.md`。源码位于 `skills/codex-issue-runner/SKILL.md`，可随仓库一起开源和审查。

## Triage Cron

可以在 Issues 看板右上角点「定时运行 Triage」，或在 Settings 里统一管理 cron 任务。

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
cd backend-ts && bun test
cd frontend && npm run build
```

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，仅允许非商业目的使用。
商业使用、商业部署或将本项目作为商业产品/服务的一部分使用，需要获得项目作者的单独商业授权。

项目所有者保留对本项目进行商业化、专有版本发布或闭源发行的权利。

分发本项目或其衍生版本时，请同时保留 `LICENSE` 与 `NOTICE`。
