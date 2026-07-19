# ADR-XW-0060：Cron、PI Automation、Heartbeat 与 Watch 统一语义

- 状态：Accepted（W2 / G4 / W3 target-primary；P11.09 exact-set schema cleanup 见
  `docs/migrations/legacy-automation-schema-drop-v1.md`）
- 日期：2026-07-17
- 依赖：[ADR-XW-0005](0005-capability-disposition-inventory.md)、[ADR-XW-0006](../xuanwu-migration/README.md)
- 可执行清单：`backend-ts/src/xuanwu/automationSemantics.ts`
- 覆盖校验：`backend-ts/src/xuanwu/automationSemantics.test.ts`
- 只读退役审计：`scripts/audit-automation-consolidation.mjs`
- target-primary 迁移：`scripts/migrate-automation-target-primary.mjs`
- 隔离回滚校验：`scripts/verify-automation-rollback.mjs`
- 范围：11 张 legacy carrier 表、7 张 `automation_*` target 表、automation family 的全部 35 条 API（含 compatibility report），以及 3 条 source-policy compatibility API

## 1. 决策

当前 actively served `/api/automations`、repository 与 scheduler 已完成 W2/G4：`automation_definitions`、`automation_trigger_configs`、`automation_runs/events` 与 `automation_watches` 是唯一 Automation definition、claim、execution 与 watch authority。legacy Cron、PI Automation、delegation、completion-watch API 以 `308` 永久重定向到 `/api/automations`，并只记录 `compatibility.automation_legacy_used.v1`；它们不再读取或写入 legacy carrier。主调度循环只调用 native Automation scheduler 与 native Watch runtime。

W1 shadow seam 仍保留为 previous-release rollback/migration implementation，但不在 W3 runtime、route registry 或 frontend 中注册。新的 issue 定时执行直接创建带 `target_issue_id` 的 one-shot manual Automation；Feishu/PI/Supervisor completion watch 直接创建 native `automation_watches`，统一使用 `automation_watch_terminal` intent、outbox idempotency 与 delivery recovery。Source Policy 页面只读展示 profile；权限写入统一由 Automation `permission_policy_ref` 承担。

Automation 是有边界、触发器、权限、停止/升级条件的 standing order。Schedule/Cron 只决定何时触发；Heartbeat 是 trigger executor 与审计，不是 standing order；completion watch 只观察 authoritative Work；Attention 记录需要处理的事项；Approval 只授予权限；Notification/outbox 只负责送达。任何一层都不能单独证明 Work 完成，也不能绕开现有 Issue/Run/Evidence、Action Proposal/Approval 与外部写审计。

## 2. 触发 / 执行 / 观察分类

| carrier | 分类 | 当前 source of truth | 目标与处置 |
| --- | --- | --- | --- |
| `cron_tasks` + `cron_task_schedules` | 触发 | `automation_definitions/runs`；legacy rows 冻结为 rollback/archive | 已迁移为 Automation trigger；旧 API 只做 audited redirect |
| `pi_automations` | legacy definition / execution | `automation_definitions` / `automation_runs/events` | legacy rows 冻结为 rollback/archive，W3 不读取或执行 |
| `pi_delegations` | 触发 | continuous/scheduled `automation_definitions` | legacy rows 冻结为 rollback/archive，旧 scheduler 已移除 |
| `pi_heartbeat_controls/runs/events` | 执行 | pause control、tick audit 和 Evidence | merge 到 Automation execution/recovery；历史 tick 不是 core Run |
| `pi_issue_completion_watches/items` | 观察 | `automation_watches` + intent/outbox delivery | legacy rows 冻结为 rollback/archive；仍只观察 Work |
| `nightly_batches/items` | archive | live-only historical rows；当前 source/runtime 无消费者 | delete candidate；不自动迁入 Automation/Run Group |

边界依赖：`project_pi_settings` 仍是 Project policy/settings，`pi_guardian_watchdog_status` 是 Guardian runtime health cursor，`pi_notification_intents`/`sync_outbox`/`notifications` 是 delivery audit/projection。它们不是 Automation definition、claim 或 completion authority，所以不纳入本 ADR 的 11 张 carrier 表，但其外部写与删除仍受 P00.06 门禁约束。

## 3. 状态映射

状态必须按不同 axis 映射，禁止把 definition lifecycle、单次 execution、observation/delivery 混成一个 `status`：

| axis | source | canonical 语义 |
| --- | --- | --- |
| definition | cron `active / paused / done` | `active / paused / archived` |
| definition | legacy PI automation `enabled=1 / 0` | `active / paused`；`last_status` 不是 definition 状态；W1 target row 仍固定 `draft` |
| definition | delegation `active / paused / expired` | `active / paused / archived` |
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

- **当前 W2/G4/W3**：`automation_*` 是唯一读写与 scheduler authority；legacy carrier 只保留冻结的 pre-cutover state、历史执行 audit 和精确 rollback 输入，不允许恢复并行 writer。
- **W1**：legacy primary read/write；target 只能按 migration batch 做可重建、幂等 shadow write和 deterministic comparison。`scripts/migrate-automation-shadow.mjs` 默认 readonly dry-run；apply 必须使用 `--apply-to-copy --source-db ...`，且 source 与 copy 的 schema/legacy checksum 一致。第二次 apply 必须零新增、零刷新。shadow failure 不改变 legacy result。
- **W2/G4**：target primary read 与 target-only writer 同一 release 切换；没有双写/双读窗口。旧 route 只返回 auditable `308`，不翻译旧 payload，也不 fallback legacy storage。
- **期限**：W1 dual mode 已结束；W3 至少保留一个正式 release 的 redirect telemetry、pre-cutover backup、Nightly archive 与 restore report，之后仍须 P11.09/G7 才能物理删除表。
- **回滚**：停止 target release，恢复 retained pre-cutover SQLite backup，再部署 previous release；禁止只回滚代码或在 target writer 运行时恢复 legacy writer。`verify-automation-rollback.mjs` 必须在隔离副本证明全 Automation carrier/target checksum 一致。

LLM 只能提议 Automation 或生成说明；状态变更、外部写、cutover、rollback、delete 都必须经过确定性 policy/Approval，记录 actor、reason、target、correlation ID、gate、outcome 和 timestamp。

## 6. 迁移顺序

1. 冻结 11 张 legacy carrier 表、7 张统一 Automation 表、35 条 API、writer/consumer、ID/status/cursor/idempotency mapping 和 live baseline。
2. 新 command 先收敛到一个确定性 Automation command seam；legacy storage 仍各自 sole authority。
3. 只添加可逆 mapping；W1 按 batch backfill，并 shadow-compare definition、trigger/cursor、status axis、claim/retry、timezone/quiet hours、watch idempotency 与 provenance/correlation。任何 target/provenance drift 都 fail closed。
4. W2/G4 同一确定性 cutover 将 target 设为唯一 writer；旧 route 变 permanent redirect-only，使用 telemetry 证明 consumer-zero。
5. W3 target-only 覆盖 restart、missed trigger、one-shot、retry/backoff、pause、watch dedupe 与 delivery recovery，并取得 deployed release 的 legacy storage consumer-zero。
6. 只有 P11/G7 可删除 route/code/table；必须先 archive、fresh backup、隔离 restore 和精确 destructive approval。

顺序不得改成“先双写再收敛 command”，也不得让 Cron、Heartbeat 或 Watch 各自生成另一套 Automation/Run authority。

## 7. 删除门禁

| candidate | 附加门禁（同时满足 P00.06 G7） |
| --- | --- |
| cron storage/compat | 无 active task/claim；schedule、timezone、quiet/working hours、missed-run、one-shot、restart parity；一个 release 零 storage consumer；P11.04/P11.09 |
| `pi_automations` storage/compat | W2/G4 target single-writer；definition、cursor/watermark、claim/retry/result parity；W3 restart/retry；一个 release 零 direct consumer；P11.04/P11.09 |
| delegation storage/compat | 无 active/paused delegation；authorization、allowed/forbidden action、cursor/restart parity；P11.04/P11.09 |
| heartbeat legacy scheduler/control | 无 live delegation 引用；pause、retry、action audit、restart parity；R3 runs/events 已归档且仍可追溯；P11.04/P11.09 |
| completion watch storage/compat | 无 active 或 satisfied-but-undelivered watch；condition/item/status/idempotency/startup sweep/notification dedupe parity；P11.04/P11.09 |
| nightly tables | parent/items 全量带 checksum 导出；一个 release source/runtime/API 零消费者；fresh SQLite backup 与隔离 restore；P11.09 |

`pi_automations` 也是 legacy migration candidate；只有 W2/G4 target single-writer、W3 restart/retry parity、一个正式 release consumer-zero、archive/restore 和精确非 LLM G7 approval 全部完成后才可删除。任何 candidate 缺少 active-row=0、consumer-zero、backup/archive hash、restore rehearsal 或精确非 LLM approval 时必须 fail closed。

P11.09 只删除已通过 exact-set consumer-zero 的 cron、`pi_automations`、legacy completion-watch 与
Nightly 表。`pi_delegations` 因 report/authorization live consumer 继续保留；heartbeat control/run/event
仍是运行与 R3 audit authority，也继续保留。空行数不能覆盖这两个 retain decision。

可执行审计只读打开 SQLite，并把数据/影子 parity 与 destructive delete authorization 分开：

```bash
scripts/audit-automation-consolidation.mjs \
  --db <runner.db> \
  --report /tmp/xw-p11-04/automation-consolidation-audit.json \
  --source-root "$PWD"
```

报告检查未终结 Cron/Nightly、Cron/PI claim、active Delegation、running Heartbeat、未送达 completion watch、
PI Automation 与 completion-watch W1 shadow drift/orphan，并生成包含 parent/item mapping 与 SHA-256 的 Nightly
只读 archive candidate。该 candidate 不是 fresh backup，也不代表 restore rehearsal 已完成；报告固定
`destructive_delete_authorized=false`，不会接受 LLM 文本作为 formal-release consumer-zero、P11.09 或 G7 证据。
`cutover_gate` 只在 `automation:cutover-739` 的 audited marker 存在且 legacy execution rows 静止时通过；
`consumer_zero` 同时检查 active runtime/frontend source 与 marker 之后的 redirect telemetry。该门禁只授权
W3 target-only 运行，不授权删除任何 legacy 表。

## 8. API 覆盖

可执行清单逐项覆盖 automation family 的 **35** 条 route：统一 Automation 7、compatibility report 1、Cron 4、PI Automation 5、delegation 7、heartbeat timeline 1、completion watch 3、project heartbeat/control 7；另对 3 条 source-policy compatibility route 做 exact-set comparison。测试扫描 active runtime/frontend source，保证旧 scheduler、route writer 和 frontend client 均为零。

35 条 automation-family route 中，legacy Cron/PI Automation/delegation/completion-watch surface 在 W3 仍保留 method/path contract，但统一返回 `308 /api/automations`；compatibility report 只读展示 redirect 合同与 telemetry。native 7 条 API 是唯一读写 surface；Heartbeat timeline 与 Project control 继续是 PI observation/policy，不是第二 Automation writer。redirect telemetry 不得被当作 external action 或 legacy storage mutation。

## 9. live records 抽样

Pre-cutover 只读快照刷新于 `2026-07-19`：launchd runtime `v0.1.0-672-g0a5f00e`，审计时 source HEAD `0a5f00e`；该基线只以 SQLite readonly 打开，用于与 W3 部署后报告比较。

| table | rows | status sample |
| --- | ---: | --- |
| `cron_tasks` | 3 | `done / triage_to_todo = 3` |
| `cron_task_schedules` | 0 | empty |
| `pi_automations` | 0 | empty |
| `pi_delegations` | 0 | empty |
| `pi_heartbeat_controls/runs/events` | 0 / 0 / 0 | empty |
| `pi_issue_completion_watches/items` | 0 / 0 | empty |
| `nightly_batches/items` | 1 / 5 | `done = 1 / done = 5` |

Pre-cutover API smoke：`GET /api/cron-tasks` 返回 3 行；Automation/PI Automation/delegation/watch 返回空集合；heartbeat timeline 返回 80 条多源 projection。W3 后不得再用旧 API 读取这些行；旧 route 固定 `308` 且访问会进入 consumer telemetry。

验证 live table/status 集：

```bash
cd backend-ts
XUANWU_LIVE_DB="$LIVE_DB" bun test src/xuanwu/automationSemantics.test.ts
```

测试以 SQLite readonly 模式打开 DB，检查 11 张表存在，并拒绝未进入 canonical mapping 的 source status；不会写 live records。
