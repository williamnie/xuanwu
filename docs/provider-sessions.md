# Provider Sessions

当前 Sessions 能力由 Bun/TypeScript 后端提供，HTTP API 注册在 `backend-ts/src/http`，provider runtime 位于 `backend-ts/src/providers`。

## 目标

- Sessions 页面可以列出、创建、读取、继续和中断 provider session。
- Codex provider 使用 `codex app-server --listen stdio://` 的 thread/turn 能力。
- issue 执行和手动 session 共用 provider session 记录，便于 UI 追踪。

## API 概览

| API | 说明 |
| --- | --- |
| `GET /api/sessions?limit=&cursor=` | 列出最近 session |
| `GET /api/sessions/:id` | 读取 session 详情 |
| `POST /api/sessions` | 创建 session，可选立即发送 prompt |
| `POST /api/sessions/:id/messages` | 在已有 session 上继续发送消息 |
| `POST /api/sessions/:id/interrupt` | 中断运行中的 turn |

## Codex provider 映射

| Runner 行为 | Codex app-server RPC |
| --- | --- |
| 创建 session | `thread/start` |
| 列表 | `thread/list` |
| 读取 / 继续 | `thread/read` / `thread/resume` |
| 发送消息 | `turn/start` |
| 中断 | `turn/interrupt` |

## 持久化

Bun 后端会把 provider session / turn 信息写入 SQLite，用于 issue runs、session 列表、命令事件、引用摘要等 UI 功能。迁移后的默认 live DB 是 state dir 下的 `runner.db`。

## 验证

```bash
cd backend-ts
bun test src/http/sessionApi.test.ts src/http/sessionInterruptApi.test.ts src/providers/codex/adapter.test.ts
```
