# Provider settings / secrets v1

> 目标：Settings 与 `doctor/status` 只展示 provider 是否可用和 secret 是否已配置，不接管第三方账号，也不在 HTTP JSON、日志或 DOM 中暴露 secret 明文。

## v1 边界

- 生产执行仍只启用 Codex provider；Claude Code / opencode 只展示本机配置状态。
- 不实现完整 secret manager，不写入 Keychain，不接云端账户。
- 不读取或枚举用户 credential store；只做本进程环境变量 presence 检查与 CLI `LookPath`。
- provider-specific project 配置（model / approval / sandbox / provider_config_json）仍属于项目 DB；secret 不进入 SQLite。

## 配置归属

| 配置 | v1 存放位置 | API/UI 展示 | 说明 |
| --- | --- | --- | --- |
| CLI 路径 | env / serve flag：`CODEX_RUNNER_CODEX_CMD`、`CODEX_RUNNER_CLAUDE_CMD`、`CODEX_RUNNER_OPENCODE_CMD` | 可展示 command 与 resolved path | 非 secret，可用于 doctor/status 复用。 |
| Runner API token | `CODEX_RUNNER_AUTH_TOKEN` 或 `CODEX_RUNNER_AUTH_TOKEN_FILE`，默认 `data/auth_token` 且 `0600` | 只展示 `auth_enabled` | 不返回 token 内容。 |
| Browser Origin allowlist | `CODEX_RUNNER_ALLOWED_ORIGINS` 或 `--allowed-origins`，逗号分隔 | 只展示策略名与安全 warning | 默认为本机 origin（`localhost` / `127.0.0.1` / `::1`）可访问；远程 Web UI 需显式加入 origin。 |
| Provider API key/token | provider 官方 env / 本机登录态 / 后续 Keychain 或本机权限文件 | 只展示 `configured: true/false` | v1 不返回 env var 名称和 secret 值，避免泄露部署细节。 |
| 默认模型/权限策略 | project DB 或 provider 自身 config | model/approval/sandbox 可展示 | 这些不是 secret，但语义 provider-specific。 |
| provider raw config | provider 自己的本机配置文件 | v1 不读取 | 后续如读取，只能输出 redacted summary。 |

## API shape

`GET /api/system/status` 与 `GET /api/system/doctor` 共用同一份只读探测结果：

```json
{
  "providers": [
    {
      "id": "codex",
      "label": "Codex",
      "status": "available",
      "available": true,
      "enabled": true,
      "cli": { "command": "codex", "available": true, "path": "/usr/local/bin/codex" },
      "secrets": { "api_key": { "configured": false } },
      "settings_mode": "env_or_codex_config"
    }
  ]
}
```

约束：

- `cli.command` / `cli.path` 可以返回。
- `secrets.*.configured` 只能是布尔值；不得返回 token/API key 值。
- v1 不返回 secret source（例如具体 env var 名称），减少 HTTP JSON / DOM 泄露面。
- `status` 取值：`available` / `missing` / `unknown`。
- `security.warnings` 可返回 `bind_all_interfaces`、`auth_disabled`、`origin_wildcard` 等非 secret 诊断，不包含 token 文件路径或 token 原文。

## 本地 / 远程安全配置建议

- 本机单人使用优先绑定 `127.0.0.1:3008`；需要局域网或反代时才绑定 `0.0.0.0`。
- 远程访问必须启用 bearer token。推荐使用默认 token 文件或 `CODEX_RUNNER_AUTH_TOKEN_FILE`，不要把 `data/auth_token` 提交到 Git，也不要把 token 写进 issue、日志或截图。
- 浏览器 Origin 默认只接受本机 origin；远程 Web UI / 反代域名需设置 `CODEX_RUNNER_ALLOWED_ORIGINS=https://runner.example.com`。不要使用 `*`，除非只做临时隔离测试。
- `/health` 保持免鉴权用于 supervisor / load balancer；`/api/*`（包括 `/api/system/status`、`/api/system/doctor`、SSE `/api/events`）都应走 token + origin 检查。
- 对公网或跨机器使用，推荐 `127.0.0.1` 绑定 + SSH tunnel / Caddy / nginx 反代，并在反代层终止 HTTPS；v1 不自动安装自签 CA 或 Keychain 信任。
- Settings / `system status` / `doctor` 出现 `bind_all_interfaces`、`auth_disabled` 或 `origin_wildcard` 时，先收紧监听地址、启用 token、设置精确 Origin allowlist。

## 当前 provider 判定

- Codex：`codex-cmd` 可 `LookPath` 即 `available`；secret presence 检查 `CODEX_API_KEY` / `OPENAI_API_KEY`，但不要求其存在，因为 Codex 也可走本机登录态。
- Claude Code：`claude-cmd` 可 `LookPath` 即 `available`；secret presence 检查 `ANTHROPIC_API_KEY`，但 v1 仍 `enabled=false`。
- opencode：v1 不读取 opencode config、不启动 server；无论 CLI 是否存在，provider `status` 都保持 `unknown`，避免把 CLI presence 误判为账号/模型可用；CLI 路径仍在 `cli` 字段中单独展示。

## 复用原则

Settings UI 不单独探测 provider；它只消费 `/api/system/status.providers`。CLI `doctor` / `system status` 也消费同一个 endpoint，因此后续扩展 provider readiness 必须优先补 `backend/internal/config/provider_settings.go`，再由 API、doctor、Settings 自然复用。

## Secret 防泄漏检查

开发验收至少确认：

1. `go test ./backend/internal/config ./backend/internal/api`。
2. 如改前端，`npm --prefix frontend run build`。
3. 在设置了测试 secret 的场景下，`/api/system/status` 响应不包含 secret 原文。
4. Settings DOM 只出现“已配置/未配置”，不显示 token/API key。
