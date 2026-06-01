# Provider Settings

Settings UI 不单独探测 provider；它消费 `/api/system/status.providers`。CLI `doctor` / `system status` 也消费同一个 endpoint，因此扩展 provider readiness 时优先更新 Bun 后端的 provider status 构造逻辑，再由 API、doctor、Settings 复用。

## 当前 provider

- `codex`：默认 executor，命令默认为 `codex app-server --listen stdio://`。
- `claude`：可选 executor，命令默认为 `claude`。

## 配置入口

常用环境变量：

```txt
CODEX_RUNNER_CODEX_CMD
CODEX_RUNNER_CODEX_CWD
CODEX_RUNNER_CODEX_ENV
CODEX_RUNNER_CODEX_TIMEOUT_MS
CODEX_RUNNER_CLAUDE_CMD
CODEX_RUNNER_CLAUDE_CWD
CODEX_RUNNER_CLAUDE_ENV
CODEX_RUNNER_CLAUDE_MODEL
CODEX_RUNNER_CLAUDE_TIMEOUT_MS
```

## 验证

```bash
cd backend-ts
bun test src/config/env.test.ts src/http/systemStatus.test.ts
```
