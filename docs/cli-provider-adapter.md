# CLI Provider Adapter

本文记录当前 Bun/TypeScript 后端里的 provider adapter 边界。

## 现状

- Runner issue 执行不直接假设某个 CLI 的输出等于成功；provider run completed 之后仍必须由 agent/provider 显式回写 issue 终态。
- Codex provider 通过 `codex app-server --listen stdio://` 走 JSON-RPC。
- Claude provider 通过 `claude` CLI 的 stream 输出接入 execution-only 能力。
- CLI 短命令统一调用 Runner HTTP API，默认地址 `127.0.0.1:3008`。

## 最小事件语义

Provider adapter 应尽量归一化下列事件：

- `agent.turn.started`
- `agent.tool.started`
- `agent.tool.output`
- `agent.message.delta`
- `agent.turn.completed`
- `agent.error`

## 完成态门禁

Provider turn/run completed 不等于 issue done。runner 端保持兜底：agent run completed 但 issue 未 terminal 时，应进入 failed/pending verification 路径，避免假完成。

## 验证

```bash
cd backend-ts
bun test src/providers src/runner src/cli
```
