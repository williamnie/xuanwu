# Provider Settings

Settings UI 不单独探测 provider；它消费 `/api/system/status.providers`。CLI `doctor` / `system status` 也消费同一个 endpoint，因此扩展 provider readiness 时优先更新 Bun 后端的 provider status 构造逻辑，再由 API、doctor、Settings 复用。

## 当前 provider

- `codex`：**tested**。默认 executor，命令默认为 `codex app-server --listen stdio://`；真实执行、
  Session、恢复、中断与交付主链已经过测试。
- `claude`：**preview / not live-tested**。没有显式 API / Anthropic Platform profile 配置时，默认复用
  同一系统用户的 Claude Code CLI 登录与本地配置；显式配置 API 或 Platform profile 时使用 Bun 进程内的
  `@anthropic-ai/claude-agent-sdk`。实现已有自动化测试，但真实账号端到端链路尚未完成 live acceptance。

Provider 状态以真实验收层级为准，adapter 存在、fixture 通过或能够保存配置都不等于 live-tested。

Claude SDK 与 Claude Code CLI 模式都声明 `issue_execution`、`sessions`、`resume_session`、`interrupt`。
当前没有接通 Claude 审批闭环或可靠 model list，因此不声明 `approvals` / `model_list`，UI 会允许手填
Claude model id。CLI 模式通过官方 `claude -p`、`--resume` 与 Claude 的本地 Session 索引实现这些能力。
新建数据库会幂等准备 Codex 与 Claude Code 两个内置 Agent Profile，因此新建 Issue/Work 可以直接选择
执行 Provider；已有同 ID Profile 不会被覆盖。

## 配置入口

常用环境变量：

```txt
XUANWU_CODEX_CMD
XUANWU_CODEX_CWD
XUANWU_CODEX_ENV
XUANWU_CODEX_ENABLED
XUANWU_CODEX_TIMEOUT_MS
XUANWU_CLAUDE_CMD
XUANWU_CLAUDE_CWD
XUANWU_CLAUDE_ENV
XUANWU_CLAUDE_ENABLED
XUANWU_CLAUDE_MODE
XUANWU_CLAUDE_AUTH_MODE
XUANWU_CLAUDE_API_BASE_URL
XUANWU_CLAUDE_API_PATH
XUANWU_CLAUDE_API_KEY
XUANWU_CLAUDE_API_KEY_FILE
XUANWU_CLAUDE_PLATFORM_CONFIG_DIR
XUANWU_CLAUDE_PLATFORM_PROFILE
XUANWU_CLAUDE_MODEL
XUANWU_CLAUDE_TIMEOUT_MS
XUANWU_PI_ENABLED
XUANWU_PI_CMD
```

`Connections → Code Agents` 会自动重新探测已注册执行器，并把启用状态写入
`${XUANWU_STATE_DIR}/runner-settings.local.json`。只有 `enabled && ready` 的 Code Agent
会出现在新建 Issue、Work、Project 与 Agent Profile 的选择器中；停用正在执行 Run 或持有活动进程的
Agent 会被拒绝。

### Claude Agent SDK live 配置

Claude 认证模式：

- `environment`：SDK 或 CLI 使用 API key / gateway auth token；这是 SDK 默认值。
- `platform-profile`：SDK 使用 `ant auth login` 创建的 Anthropic Platform OAuth profile，Runner 不读取或复制 access/refresh token。
- `local-cli`：与 `XUANWU_CLAUDE_MODE=cli-fallback` 配合，复用同一系统用户的 Claude Code CLI 登录、
  user/project/local settings 与持久化 Session；没有显式 Claude API/Profile 配置时这是默认组合。

#### API key / gateway environment

源码 launchd 部署可在仓库根目录执行：

```bash
export XUANWU_CLAUDE_MODE=sdk
export XUANWU_CLAUDE_API_BASE_URL='https://your-anthropic-compatible-endpoint.example'
export XUANWU_CLAUDE_API_PATH='/optional/path'
export XUANWU_CLAUDE_API_KEY='replace-at-live-smoke-time'
./redeploy.sh
```

- `XUANWU_CLAUDE_API_PATH` 可留空；非空时会规范化后拼到 base URL。
- Runner 将这三个值映射为 SDK 使用的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`。直接开发也兼容标准 Anthropic 变量和已有 `XUANWU_CLAUDE_ENV`。
- 部署脚本不会把 key 放到命令行、plist 或 systemd unit；它将 key 写入 `${XUANWU_STATE_DIR}/claude_api_key`（权限 `0600`），服务配置只保留 `XUANWU_CLAUDE_API_KEY_FILE`。可用同名变量覆盖文件位置。
- 只改凭据/endpoint 时仍需重新运行 installer/redeploy，让 Core 获得新环境并重启。源码 `./redeploy.sh` 会按现有安全流程重建并重启 Web/Core/Agentic；release 安装可用相同变量重新运行 installer。不要把真实 key 粘到 issue、日志、DB、浏览器或 status 截图中。

显式回退到既有 Claude CLI：

```bash
export XUANWU_CLAUDE_MODE=cli-fallback
export XUANWU_CLAUDE_CMD=/absolute/path/to/claude
./redeploy.sh
```

显式选择 SDK 但配置缺失时 `claude` 会显示 `configuration_required`，不会静默转到 Codex 或 CLI。

#### 复用本地 Claude Code CLI 登录

先用将运行 launchd/systemd user service 的同一系统用户确认登录：

```bash
claude auth status --json | jq '{loggedIn,authMethod,apiProvider}'
# 未登录时由用户在终端完成浏览器流程：
claude auth login
```

然后显式选择 fallback：

```bash
export XUANWU_CLAUDE_MODE=cli-fallback
export XUANWU_CLAUDE_AUTH_MODE=local-cli
./redeploy.sh
```

Runner 只用 `claude auth status --json` 检查认证摘要，并把执行、创建与恢复请求交给官方 Claude Code CLI；
不会读取、复制或输出 macOS Keychain/本地 credential。status 应显示 `auth_mode=local-cli`、
`auth_source=local_cli`、`auth_configured=true`、`local_cli.logged_in=true`，capabilities 包含
`issue_execution,sessions,resume_session,interrupt`。Runner 不再传 `--bare`，因为该参数会禁用本地
OAuth/keychain 与 settings 读取。

#### Anthropic Platform OAuth profile

在终端通过 Anthropic Platform CLI 创建 profile：

```bash
ant auth login --profile runner
ant auth status --profile runner
```

随后让 SDK 显式使用该 profile：

```bash
unset XUANWU_CLAUDE_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
export XUANWU_CLAUDE_MODE=sdk
export XUANWU_CLAUDE_AUTH_MODE=platform-profile
export XUANWU_CLAUDE_PLATFORM_CONFIG_DIR="$HOME/.config/anthropic"
export XUANWU_CLAUDE_PLATFORM_PROFILE=runner
./redeploy.sh
```

`XUANWU_CLAUDE_PLATFORM_CONFIG_DIR` 可省略，macOS/Linux 默认使用 `$HOME/.config/anthropic`；profile 可省略，此时按 `ANTHROPIC_PROFILE`、`active_config`、`default` 的顺序解析。Runner 只读取非敏感的 `configs/<profile>.json` 并检查 `credentials/<profile>.json` 是否存在且权限私有，不读取 credential 内容。SDK 自己负责 access token 使用与刷新。显式 profile 模式会从 SDK 子进程环境移除更高优先级的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`，防止请求被静默路由到其他 workspace。

status 应显示 `auth_mode=platform-profile`、`auth_source=platform_profile`、`auth_configured=true`，以及安全的 profile 名称、认证类型和 `credentials_file_ready`；不会返回 config 绝对路径或 token。

这里的 Platform OAuth profile 不等同于在 Runner 中嵌入 Claude.ai Pro/Max 登录。Runner 不提供 Claude.ai 登录 UI，也不会自动复用或导出 Claude Code 的订阅凭据；Claude.ai 本地登录只由显式 `local-cli` fallback 交给官方 Claude CLI 使用。

### Live smoke（等待操作者注入真实凭据）

1. 配置上面的 base URL、可选 path 和 key，然后重新部署/重启。
2. 检查服务和 provider status：

   ```bash
   ./scripts/status-launchd.sh
   ./dist/xuanwu system status \
     --token-file "$HOME/Library/Application Support/xuanwu-bun-live/state/auth_token" \
     --json | jq '.providers[] | select(.id == "claude")'
   ```

   预期 `mode == "sdk"`、`ready == true`、`status == "available"`、`sdk.installed == true`、`sdk.executable_ready == true`、`sdk.ready == true`、`sdk.version == "0.3.152"`、`api_key_configured == true`。`api_base_url_summary` 只显示安全 origin/路径占位，不应出现 key、query、userinfo 或私有 path。

   Bun 编译产物旁会同时生成 `xuanwu.claude-agent-sdk`。这是 SDK 自身要求的原生 Claude Code executable，不是 Node sidecar/daemon；build、release install 与 rollback 都会把它作为相邻运行时资产原子部署。若缺失，status 会明确返回 `sdk.executable_ready == false`，而不是假报 SDK 健康。
3. 在项目设置的 **Agent Profile（可选）** 中准备一个 `provider=claude` 的 profile；在 Work 新建/编辑弹窗选择它并启动一个最小 Work，例如“只读取 README 第一行并回复，不修改文件”。
4. 打开 **Run Detail → Provider**。确认引用形如 `claude:<session_id>`，能看到实时文本、工具调用/结果、usage/cost、终态；尝试 interrupt，并在同一 Runner transcript 中继续/恢复。Claude 页面不应出现 “Open in Codex App” 或 `codex resume`。
5. 路由回归：同一项目新建两个 Work，一个显式选 Codex profile，另一个显式选 Claude profile。确认 Work Detail 的 effective provider 分别正确，并确认两个 Run 的 current Attempt 实际 provider 保持 `codex` / `claude`；随后修改项目默认 profile，历史 Attempt 不应变化。

真实请求只在操作者注入凭据后执行；离线测试使用注入的 fake query/session factory，不需要也不读取真实 key。

## 验证

```bash
cd backend-ts
bun test --timeout 60000 \
  src/config/env.test.ts \
  src/providers/claude/auth.test.ts \
  src/providers/claude/provider.test.ts \
  src/providers/claude/sdkProvider.test.ts \
  src/http/systemStatus.test.ts \
  src/http/sessionApi.test.ts \
  src/http/workApi.test.ts \
  src/runner/interrupt.test.ts \
  src/runner/projectLoop.test.ts \
  src/runner/providerRuntime.test.ts \
  src/pi/roleProfileSelector.test.ts
bun run build:binary

cd ../frontend
bun test \
  src/pages/providerAvailabilityModel.test.js \
  src/pages/sessions/sessionMarkdownExport.test.js \
  src/pages/sessions/codexAppLink.test.js \
  src/pages/sessions/newSessionGuards.test.js \
  src/pages/sessions/sessionPageRuntime.test.js \
  src/pages/sessions/sessionTranscriptItems.test.js \
  src/pages/runs/runDetailModel.test.js \
  src/pages/work/workProfileRouting.test.js
npm run build
npm run lint
```
