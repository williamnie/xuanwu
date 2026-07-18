# ADR-XW-0060：Cron、PI Automation、Heartbeat 与 Watch 统一语义

- 状态：Accepted（G0 / W0 语义基线，不执行 cutover）
- 日期：2026-07-17
- 依赖：[ADR-XW-0005](0005-capability-disposition-inventory.md)、[ADR-XW-0006](../xuanwu-migration/README.md)
- 可执行清单：`backend-ts/src/xuanwu/automationSemantics.ts`
- 覆盖校验：`backend-ts/src/xuanwu/automationSemantics.test.ts`
- 范围：`cron_tasks`、`pi_automations`、PI delegation/heartbeat、completion watch、live-only nightly batch，以及当前归入 automation family 的全部 34 条 API

## 1. 决策

统一的是**产品语义和迁移方向**，不是立即把现有表互相双写。本期不新增 schema、公开 API、共享状态机或 provider adapter，也不改现有 writer。G4 前，每个 legacy carrier 继续拥有自己的 ID、cursor、状态和写路径；目标唯一 authority 是 `pi_automations` 加同一条确定性 Automation command/claim pipeline，但必须由后续 issue 逐 gate 实现。

Automation 是有边界、触发器、权限、停止/升级条件的 standing order。Schedule/Cron 只决定何时触发；Heartbeat 是 trigger executor 与审计，不是 standing order；completion watch 只观察 authoritative Work；Attention 记录需要处理的事项；Approval 只授予权限；Notification/outbox 只负责送达。任何一层都不能单独证明 Work 完成，也不能绕开现有 Issue/Run/Evidence、Action Proposal/Approval 与外部写审计。

## 2. 触发 / 执行 / 观察分类

| carrier | 分类 | 当前 source of truth | 目标与处置 |
| --- | --- | --- | --- |
| `cron_tasks` + `cron_task_schedules` | 触发 | definition/lifecycle/claim/result 与 schedule policy 分别由两表拥有 | migrate 为 Automation schedule trigger；旧 API 最终只翻译到同一 command |
| `pi_automations` | 执行（同时承载 native definition/claim） | native Automation definition、cursor/watermark、lock/retry/result | keep，成为 target primary authority；不得再造第二张 Automation 主表 |
| `pi_delegations` | 触发 | standing-order intent、authorization、lifecycle、`next_heartbeat_at` | migrate 为 continuous/scheduled Automation definition |
| `pi_heartbeat_controls/runs/events` | 执行 | pause control、tick audit 和 Evidence | merge 到 Automation execution/recovery；历史 tick 不是 core Run |
| `pi_issue_completion_watches/items` | 观察 | condition、issue snapshot、idempotency、notification progress | migrate 为 Automation completion condition；仍只观察 Work |
| `nightly_batches/items` | archive | live-only historical rows；当前 source/runtime 无消费者 | delete candidate；不自动迁入 Automation/Run Group |

边界依赖：`project_pi_settings` 仍是 Project policy/settings，`pi_guardian_watchdog_status` 是 Guardian runtime health cursor，`pi_notification_intents`/`sync_outbox`/`notifications` 是 delivery audit/projection。它们不是 Automation definition、claim 或 completion authority，所以不纳入本 ADR 的 11 张 carrier 表，但其外部写与删除仍受 P00.06 门禁约束。

## 3. 状态映射

状态必须按不同 axis 映射，禁止把 definition lifecycle、单次 execution、observation/delivery 混成一个 `status`：

| axis | source | canonical 语义 |
| --- | --- | --- |
| definition | cron `active / paused / done` | `enabled / paused / completed` |
| definition | automation `enabled=1 / 0` | `enabled / paused`；`last_status` 不是 definition 状态 |
| definition | delegation `active / paused / expired` | `enabled / paused / completed` |
| execution | cron `success / error / skipped` | `succeeded / failed / skipped` |
| execution | automation `running / success / error` | `running / succeeded / failed`；空值表示 never started |
| execution | heartbeat `running / completed / failed / skipped` | `running / succeeded / failed / skipped` |
| observation | watch `active / satisfied / notified / cancelled / failed` | `watching / satisfied / delivered / cancelled / failed` |
| archive | nightly batch `active / paused / done` | 只保留 `legacy_active / legacy_paused / archived_terminal`，不得驱动新执行 |
| archive | nightly item `pending / current / done / failed / skipped` | 只保留历史状态与 parent/item provenance |

Watch item 的 `last_status` 是 authoritative Issue 状态快照（`triage/todo/in_progress/pending_verification/done/failed/cancelled`），不是新状态机。`pending_verification` 是否满足 watch 由 condition 决定；watch 的 `notified` 只表示 delivery 已完成，不等于 Work acceptance 已通过。

## 4. 重复能力

1. **定时触发重复**：cron `next_run_at`、Automation `next_run_at`、delegation `next_heartbeat_at` 都能唤醒工作。迁移后每个 trigger/cursor 只能有一个 claim owner。
2. **执行记录重复**：cron `last_*`、Automation `last_*`、heartbeat run/event 都记录一次执行。目标中 Automation claim/result 为执行 authority，heartbeat/action events 作为 Evidence；不能由一次 heartbeat 另建 core Run。
3. **pause 重复**：cron status、Automation enabled、delegation status、heartbeat control 都能暂停不同层。统一 API 必须区分 definition pause 与 executor/project pause，不能用一个布尔值静默覆盖其他层。
4. **completion/notification 重复**：completion watch、Supervisor commitment 与 notification intent 都参与“完成后提醒”。watch condition 是 observation authority，Attention 是 follow-up projection，outbox 是 delivery authority；只允许一个 idempotency key 产生一次外部通知。
5. **夜间批量重复**：nightly batch 曾做 issue 串行 promotion，现有 Cron/Run Group 可覆盖部分体验，但 live 表已无 runtime consumer；本期只 archive/delete，不把陈旧状态猜测映射到新对象。

## 5. source of truth、双读/双写与回滚

- **当前 G0/W0**：旧 carrier 各自唯一写 authority；`pi_automations` 只管理原生 Automation。没有 dual-read 或 dual-write。
- **W1**：legacy primary read；target 只能按 migration batch 做可重建、幂等 shadow write 和 deterministic comparison，shadow failure 不改变 legacy result。
- **W2**：先切 target primary read并保留确定性 legacy comparison/fallback；G4 经非 LLM 审批后 target 成为唯一 writer，旧 API 只翻译到同一 domain command。
- **期限**：**W1 + W2 最多两个连续正式 release**；W2 结束必须关闭全部 dual mode。延期需要 superseding ADR。
- **回滚**：G4 前关闭 shadow/target read即可回 legacy。G4 后先停止 target writer，再按 correlation ID/cutover checkpoint 回放受审计 delta，确认没有两个 writer 后才恢复 legacy。parity/restart/dedupe 任一失败即停 gate。

LLM 只能提议 Automation 或生成说明；状态变更、外部写、cutover、rollback、delete 都必须经过确定性 policy/Approval，记录 actor、reason、target、correlation ID、gate、outcome 和 timestamp。

## 6. 迁移顺序

1. 冻结 11 张 legacy carrier 表、7 张统一 Automation 表、34 条 API、writer/consumer、ID/status/cursor/idempotency mapping 和 live baseline。
2. 新 command 先收敛到一个确定性 Automation command seam；legacy storage 仍各自 sole authority。
3. 只添加可逆 mapping；W1 按 batch backfill，并 shadow-compare definition、cursor、status、claim 与 watch idempotency。
4. W2 先切读；parity、restart/retry 与非 LLM 审批通过后再 G4 切到一个 target writer，旧 route 变 translation-only。
5. W3 target-only 覆盖 restart、missed trigger、quiet hours、retry/backoff、pause、watch dedupe 与 delivery recovery，并取得一个正式 release 的 legacy storage consumer-zero。
6. 只有 P11/G7 可删除 route/code/table；必须先 archive、fresh backup、隔离 restore 和精确 destructive approval。

顺序不得改成“先双写再收敛 command”，也不得让 Cron、Heartbeat 或 Watch 各自生成另一套 Automation/Run authority。

## 7. 删除门禁

| candidate | 附加门禁（同时满足 P00.06 G7） |
| --- | --- |
| cron storage/compat | 无 active task/claim；schedule、timezone、quiet/working hours、missed-run、one-shot、restart parity；一个 release 零 storage consumer；P11.04/P11.09 |
| delegation storage/compat | 无 active/paused delegation；authorization、allowed/forbidden action、cursor/restart parity；P11.04/P11.09 |
| heartbeat legacy scheduler/control | 无 live delegation 引用；pause、retry、action audit、restart parity；R3 runs/events 已归档且仍可追溯；P11.04/P11.09 |
| completion watch storage/compat | 无 active 或 satisfied-but-undelivered watch；condition/item/status/idempotency/startup sweep/notification dedupe parity；P11.04/P11.09 |
| nightly tables | parent/items 全量带 checksum 导出；一个 release source/runtime/API 零消费者；fresh SQLite backup 与隔离 restore；P11.09 |

`pi_automations` 是 target primary authority，不是删除候选。任何 candidate 缺少 active-row=0、consumer-zero、backup/archive hash、restore rehearsal 或精确非 LLM approval 时必须 fail closed。

## 8. API 覆盖

可执行清单逐项覆盖 automation family 的 **34** 条 route：统一 Automation 7、Cron 4、PI Automation 5、delegation 7、heartbeat timeline 1、completion watch 3、project heartbeat/control 7。测试与 `API_ROUTE_DISPOSITIONS` 做 exact set comparison，新增或删除 route 未同步语义清单会失败。

17 条 mutation route 全部标成 write：创建/修改 definition、pause/resume/expire/cancel、manual run。后续统一时，它们必须调用同一确定性 command 和 audit；10 条 GET 只读 projection 不得产生 claim、notification 或外部写。

## 9. live records 抽样

只读快照时间 `2026-07-17T16:01:02+08:00`：launchd runtime `v0.1.0-591-gb57ada6`，source HEAD `36c989083a77`，DB 来自进程 `--db .../state/runner.db`。未修改 live state。

| table | rows | status sample |
| --- | ---: | --- |
| `cron_tasks` | 3 | `done / triage_to_todo = 3` |
| `cron_task_schedules` | 0 | empty |
| `pi_automations` | 0 | empty |
| `pi_delegations` | 0 | empty |
| `pi_heartbeat_controls/runs/events` | 0 / 0 / 0 | empty |
| `pi_issue_completion_watches/items` | 0 / 0 | empty |
| `nightly_batches/items` | 1 / 5 | `done = 1 / done = 5` |

live 只读 API smoke：`GET /api/cron-tasks` 返回 3 行；Automation/runnable/delegation/watch 返回空集合；heartbeat timeline 返回 5 条跨 action/supervisor 的 timeline projection；`GET /api/projects/codex-issue-runner/pi/heartbeat/diagnostics` 返回 `active`。Timeline 有数据而 heartbeat tables 为空，证明 timeline 是多源 observation projection，不能反向当作 heartbeat execution authority。

验证 live table/status 集：

```bash
cd backend-ts
XUANWU_LIVE_DB="$LIVE_DB" bun test src/xuanwu/automationSemantics.test.ts
```

测试以 SQLite readonly 模式打开 DB，检查 11 张表存在，并拒绝未进入 canonical mapping 的 source status；不会写 live records。
