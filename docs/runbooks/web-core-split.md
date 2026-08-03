# Web Gateway / Runner Core / Agentic Worker 进程隔离运行手册

正式安装默认使用同一份 `codex-issue-runner` artifact 启动三个 OS 进程：

- `${CODEX_RUNNER_LAUNCHD_LABEL}.web` / `${CODEX_RUNNER_SERVICE_NAME}-web`：公开监听 `CODEX_RUNNER_ADDR`，只服务 Web 资源并代理 `/api/*`。
- `${CODEX_RUNNER_LAUNCHD_LABEL}.core` / `${CODEX_RUNNER_SERVICE_NAME}-core`：只监听 `CODEX_RUNNER_CORE_ADDR`（默认 `127.0.0.1:3009`），独占 SQLite、migration、scheduler、provider 与 connector，并调用 Agentic Worker。
- `${CODEX_RUNNER_LAUNCHD_LABEL}.agentic` / `${CODEX_RUNNER_SERVICE_NAME}-agentic`：只监听 `CODEX_RUNNER_AGENTIC_ADDR`（默认 `127.0.0.1:3010`），承载隔离的 Supervisor/Workflow agentic runtime，不对外公开。

开发兼容入口仍是单进程：`codex-issue-runner serve --role all ...`；未指定 `--role` 时同样保持 `all`。正式部署不得启动多个 `core` 或 `all` 实例。

## 验证

源码 launchd 部署使用：

```bash
./scripts/status-launchd.sh
bun run scripts/smoke-web-core-isolation.ts --binary ./dist/codex-issue-runner --web-dir ./frontend/dist
```

状态脚本必须显示三个不同 PID、对应 `web` / `core` / `agentic` role、同一 runtime/artifact stamp，并证明 Web/Agentic 没有打开 `runner.db`、Core 独占 DB。

## 回滚

`./redeploy.sh` 在部署前把在线 SQLite 一致性备份写到 `backups/predeploy-*`，路径记录在 `state/latest-predeploy-backup`；源码 installer 在替换 artifact/plist 前把旧 binary、stamp 和 plist 写到 `rollback/*`，路径记录在 `state/latest-runtime-rollback`。

回滚时先停止 `.web`、`.core` 与 `.agentic`，从 `latest-runtime-rollback` 恢复 binary/stamp/plist；只有新版本已执行不兼容 migration 时，才从 `latest-predeploy-backup` 恢复 DB。随后按备份的 plist 重新 bootstrap，并用 `scripts/status-launchd.sh` 或旧版 `/health`、`/api/system/status` 验证。不要让旧 `all` 与新 `core` 同时运行。
