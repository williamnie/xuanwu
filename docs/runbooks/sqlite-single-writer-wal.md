# SQLite 单 Writer、WAL 与后台投影

本页是 PERF-04 / issue #773 的运行契约。`issues`、`issue_runs`、`run_attempts`、`issue_events` 继续是 authority；event summary 与 Run progress 都是可重建投影。

## 连接 authority

- 正式服务只有 `runner-core` 调用 `openDatabase()` 的 writer 连接。scheduler、provider persistence、domain command、projection worker 都在该进程和同一 Bun event loop 内串行写入。
- `runner-web` 的 import graph 不含 `bun:sqlite`，不打开 DB；`status-launchd.sh` 的 `split authority` 行是 live 核验入口。
- Core 另开一个 `readonly + query_only` reader，`busy_timeout=50ms`；writer 的 lock wait 限为 `250ms`。公开请求遇到 `SQLITE_BUSY/LOCKED` 返回 bounded `503`/`Retry-After: 1`，诊断只记录 method、bounded path 与 policy。
- reader 不运行 migration、default-agent bootstrap、telemetry、compat write 或 projection catch-up。普通 Issues/Work/Runs/Evidence/Handoff/Command Center/event summary/system status GET 优先使用 reader。
- WAL 只允许 maintenance command 改变。普通 runtime startup 在检测到已是 WAL 后才设置该连接的 `synchronous=NORMAL` 与 `wal_autocheckpoint=1000`，不会隐式执行 DELETE → WAL。

## `bun:sqlite` 打开路径审计

生产路径分为四类：

1. `backend-ts/src/db/database.ts`：Core writer 与 bounded reader；唯一常驻 runner DB 连接入口。
2. `backend-ts/src/backup/service.ts`：用 SQLite `VACUUM INTO` 生成一致性快照并以 `quick_check` 验证；不会把活动 WAL 下的主 `.db` 单独复制为备份。
3. `backend-ts/src/db/*Maintenance.ts`、`backend-ts/src/events/*Service.ts`、`backend-ts/src/domain/work/migrationService.ts`：显式 CLI/offline maintenance。写模式要求 actor、audit、backup/no-writer confirmations；不得与 Core writer 并行。
4. `backend-ts/src/usage/usageIndex.ts`：独立的可重建 usage index，worker process 只写 `codex-usage-index-v1.sqlite`，不是 runner authority。

`scripts/migrate-automation-*.mjs` 是受门禁的一次性迁移脚本；`consolidationAudit.ts`、capacity/audit scripts 只读。其余 `bun:sqlite` 打开点位于 tests/fixtures。新增生产直连必须归入以上类别，否则视为 writer-authority 违规。

## 普通 GET 审计

| 表面 | PERF-04 行为 |
| --- | --- |
| event summaries / Work timeline | 只读已完成 projection，响应中的 watermark 含 `last_event_id`、`lag_rows`、`updated_at`、`status`；不再 request-time catch-up |
| Runs list/detail | reader 连接；list 使用 summary，detail 的 event source 最多读取最新 5000 行并显式 `source_event_truncated` |
| system status | reader 连接；active Run progress 最多评估 32 个，返回 `evaluated_active_runs` 与 `backpressure` |
| legacy Issues/Sessions | GET 只加 deprecation headers，不写 usage telemetry；显式 `POST /api/compatibility/legacy/usage` 仍可审计导航 |
| usage | GET 读取独立 usage index；refresh 在子 worker 中更新可重建 index，不写 runner DB |
| maintenance | 没有 GET 入口；只通过显式 CLI 执行 |

event summary 后台 worker 每批最多 100 行、每 tick 最多各执行一个 V1/V2 batch，目标 wall time 100ms；有 lag 时以 25ms backpressure delay 续跑，无 lag 时 1s 后再检查。worker 可 pause/resume/stop，snapshot 暴露 batch/row checkpoint、duration、backpressure 与 bounded error。

## WAL rehearsal / cutover

先用 backup bundle 中的 `database/runner.db` 或 SQLite `VACUUM INTO` fresh copy 演练；不要用 `cp runner.db`。所有 report 路径应落在独立、可识别的 artifact 目录。

```bash
codex-issue-runner maintenance db wal \
  --operation dry-run --db <copy.db> --report <dry-run.json> --json

codex-issue-runner maintenance db wal \
  --operation apply --db <copy.db> --report <apply.json> --apply \
  --confirm-backup-tested --confirm-no-active-writers \
  --actor <operator> --actor-kind user \
  --audit-ref <approved-change-ref> \
  --reason 'verified WAL transition rehearsal' --json

codex-issue-runner maintenance db wal \
  --operation verify --db <copy.db> --report <verify.json> --json
```

Live apply 顺序不可交换：focused rehearsal/tests → fresh verified backup → restore rehearsal → 停止 Core/确认无 writer FD → apply → verify → 启动 Core → `quick_check`、authority row counts、runtime stamp/API smoke。apply 检查至少 `max(DB bytes, 256MiB)` 可用磁盘；不足即 fail closed。

长 reader 或异常退出时，未 checkpoint commit 必须可由 `.db-wal/.db-shm` 恢复；一致性备份必须通过 SQLite snapshot/VACUUM INTO 把 WAL 内容纳入目标 DB。不要删除或单独移动 sidecar。

回切前保持 Core 停止：

```bash
codex-issue-runner maintenance db wal \
  --operation rollback --db <runner.db> --report <rollback.json> --apply \
  --confirm-backup-tested --confirm-no-active-writers \
  --actor <operator> --actor-kind user \
  --audit-ref <approved-change-ref> \
  --reason 'approved WAL rollback' --json
```

rollback 先 `wal_checkpoint(TRUNCATE)` 再切回 DELETE。若 integrity 或 authority row counts 异常，不继续启动 Core；恢复到 fresh state directory 中经过 restore rehearsal 的 backup bundle。
