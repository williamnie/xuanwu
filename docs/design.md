# Design Notes

> [!WARNING]
> **历史概览（2026-07-19 归档）**：本文只保留早期五节点概览，不再完整描述当前玄武架构。当前 source of truth 见 [canonical 架构文档索引](architecture/README.md)、根 [README](../README.md) 与 [运行可观测性合同](architecture/xuanwu/0078-runtime-observability-diagnostics.md)。

当前实现已经迁移到 Bun/TypeScript 后端，入口在 `backend-ts/src/main.ts`，默认 live 端口为 `3008`。

## 高层结构

```mermaid
flowchart LR
  UI["Web UI"] --> API["Bun API Server"]
  CLI["codex-issue-runner CLI"] --> API
  API --> DB[(SQLite runner.db)]
  API --> Runner["Runner Loop"]
  Runner --> Providers["Codex / Claude Providers"]
  Providers --> Codex["codex app-server"]
```

## 运行目标

- Live API：`127.0.0.1:3008`
- 源码后端：`backend-ts/`
- 构建产物：`dist/codex-issue-runner`
- SQLite：部署 state dir 下的 `runner.db`
- 前端静态资源：部署 state dir 下的 `web/`

## 构建

```bash
npm --prefix frontend run build
cd backend-ts && bun run build:binary
```

## 验证

```bash
cd backend-ts && bun test
npm --prefix frontend run build
```
