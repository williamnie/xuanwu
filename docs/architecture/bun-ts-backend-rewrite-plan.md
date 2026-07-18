# Bun/TypeScript Backend Migration

> [!WARNING]
> **已完成迁移记录（2026-07-19 归档）**：本文保留迁移 provenance，不再是当前构建、发布或运行规范。当前入口见 [canonical 架构文档索引](README.md)、根 [README](../../README.md) 与 [发布/升级/回滚 runbook](../runbooks/release-upgrade-rollback.md)。

> 状态：已完成。Go 后端源码、Go module、Go release/build 脚本已经移除；live 后端由 Bun/TypeScript 提供。

## 当前运行态

- Live API：`127.0.0.1:3008`
- 后端源码：`backend-ts/`
- 单文件二进制：`dist/codex-issue-runner`
- macOS launchd label：`com.xiaobei.codex-issue-runner`
- 默认 state dir：`~/Library/Application Support/codex-issue-runner-bun-live/state`
- 默认 DB：`<state-dir>/runner.db`
- 默认 token file：`<state-dir>/auth_token`

## 构建

```bash
npm --prefix frontend run build
backend-ts/scripts/build-binary.sh
```

## 部署

```bash
./redeploy.sh
```

`./deploy.sh` 等价调用 `scripts/install-launchd.sh`，会构建前端、构建 Bun binary、stage web 资源、写入 launchd plist 并重启 live 服务。

## 验证

```bash
cd backend-ts && bun test
npm --prefix frontend run build
curl -fsS http://127.0.0.1:3008/health
./dist/codex-issue-runner system status --addr 127.0.0.1:3008 --token-file <state-dir>/auth_token --json
```

## 已删除的旧实现

- `backend/`
- `go.mod`
- `go.sum`
- Go release/build pipeline
- 旧 preview launchd/deploy/status scripts
- 旧 Go DB import / final migration rehearsal CLI
