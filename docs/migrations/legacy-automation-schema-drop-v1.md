# Legacy Automation schema drop v1

- 状态：Canonical，P11.09 exact-set destructive migration
- migration：`053_drop_legacy_automation_tables`
- archive contract：`xw.legacy-automation-archive.v1`
- report contract：`xw.legacy-automation-cleanup-report.v1`

## 最终表清单

以下表已经由 deployed G4/W3 target-primary Automation 取代，且 P11.09 工具会同时清理其专属
显式索引与 SQLite autoindex：

| disposition | tables | authority after drop |
| --- | --- | --- |
| drop | `cron_tasks`, `cron_task_schedules` | `automation_definitions`, `automation_trigger_configs`, `automation_runs/events` |
| drop | `pi_automations` | 同上；legacy route 只重定向到 target command |
| drop | `pi_issue_completion_watches`, `pi_issue_completion_watch_items` | `automation_watches` + `pi_notification_intents` |
| drop | `nightly_batches`, `nightly_batch_items` | 无运行 authority；完整行仅保留在 checksum archive 与 fresh backup |

以下表明确 **不在本 migration 删除范围**：

- `pi_delegations`：`pi/reports.ts` 与 Skill authorization 仍有 live consumer；必须另行完成 target mapping 和
  consumer-zero，不能把空行数当成退役证据。
- `pi_heartbeat_controls`, `pi_heartbeat_runs`, `pi_heartbeat_events`：仍是 pause/control 与 R3 execution
  audit authority。
- `issues`, `issue_events`, `issue_runs`, `works`, `work_events`：Issue/Run/Work shared authority，不属于
  Automation schema cleanup。
- `pi_actions`, `pi_action_events`, `pi_approval_requests`：Action Gate、审计和 Evidence carrier，禁止删除。

## 确定性门禁与执行

普通 startup（包括空库）只把 migration 保持为 deferred，不会自动执行 destructive schema change。
正式库只能在停止所有 writer 后，通过 maintenance 命令执行；成功写入 migration marker 后，后续
startup 的 schema repair 也会保持这些表为已退役状态：

```bash
xuanwu maintenance db legacy-automation-drop \
  --db <runner.db> \
  --backup <fresh-before-drop.db> \
  --archive <legacy-automation-archive.json> \
  --report <legacy-automation-drop-report.json> \
  --source-root <repo-root> \
  --release-ref <deployed-runtime-stamp-or-commit> \
  --confirm-tables cron_task_schedules,cron_tasks,pi_automations,pi_issue_completion_watch_items,pi_issue_completion_watches,nightly_batch_items,nightly_batches \
  --actor <non-llm-operator> --actor-kind user \
  --audit-ref <approval-or-issue-ref> --reason <reason> \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
```

工具在 drop 前依次验证：

1. G4/W3 cutover、data/parity、post-cutover usage telemetry 与 exact-set source consumer-zero；
2. exact table approval 与 non-LLM actor；
3. fresh SQLite `VACUUM INTO` backup 的 SHA-256、`quick_check`、foreign key check；
4. 把 backup 复制到隔离路径并重新计算表/索引/行 checksum，只有
   `restore_rehearsal_completed=true` 才继续；
5. 写出含 CREATE SQL、index SQL、完整有序行与 SHA-256 的 archive，并立即重新验证 archive checksum；
6. 在 audited transaction 内 drop exact set、写 `schema_migrations`，再 `VACUUM`，报告 before/after bytes、
   removed tables/indexes、`quick_check` 与 foreign key check。

独立验证 archive：

```bash
xuanwu maintenance db legacy-automation-archive-verify \
  --archive <legacy-automation-archive.json> --json
```

## 回滚边界

本 migration 没有通用 down SQL。唯一可执行 rollback 是：停止所有 writer，使用 fresh pre-drop SQLite
backup 完整恢复数据库，再部署 prior release；恢复后重新验证 SHA-256、`quick_check` 和 foreign keys。

**rollback limit：** 只有在 drop 后尚未接受任何新写入时，完整 backup restore 才安全。一旦 target
release 接受了 post-drop 写入，恢复旧 backup 会丢失新的 Issue/Work/Run/Action/Evidence authority 数据，
因此禁止 restore；此时 archive 只能用于审计/取证，恢复必须走新的 forward migration。
