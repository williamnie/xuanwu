# loop_run / loop_step v0 ledger 设计草案

> [!WARNING]
> **历史草案（2026-07-19 归档）**：本文未成为当前 runtime authority，不得作为新增 ledger 或 scheduler 的实现依据。当前 source of truth 见 [canonical 架构文档索引](README.md)、[Run / Attempt 生命周期](xuanwu/0020-run-attempt-lifecycle-contract.md) 与 [运行可观测性合同](xuanwu/0078-runtime-observability-diagnostics.md)。

- 日期：2026-06-30
- 范围：Loop Engineering L3 可观察性设计；覆盖 project loop、cron、heartbeat、guardian、supervisor、completion watch 的现状映射
- 非目标：不写 DB migration；不改 scheduler；不改现有事件表；不引入 durable step orchestrator / JS workflow sandbox / 多 daemon

## 0. 结论

`loop_run` / `loop_step` v0 只做 **ledger overlay**：把现有分散 run/event/watch/action 事实投影成统一时间线，帮助回答“这一轮为什么醒、看了什么、做了什么、为什么停、下次何时醒”。

v0 不改变当前 source of truth：

- executor 仍以 `issues`、`issue_runs`、`issue_events`、`agent_sessions` 为真相。
- cron 仍以 `cron_tasks` / `cron_task_schedules` 的 run counters、last result、next run 为真相。
- heartbeat 仍以 `pi_heartbeat_runs` / `pi_heartbeat_events` / `pi_delegations` 为真相。
- guardian 仍以 `pi_guardian_watchdog_status`、`pi_guardian_alerts`、`pi_guardian_event_inbox`、`pi_guardian_decisions`、`pi_actions` 为真相。
- supervisor 仍以 `issue_supervisor_events`、`pi_recovery_attempts`、相关 `issue_runs` / `agent_sessions` 为真相。
- completion watch 仍以 `pi_issue_completion_watches`、`pi_issue_completion_watch_items`、`pi_notification_intents`、`im_reply_drafts` / `sync_outbox` / `notifications` 为真相。

ledger v0 的产品边界是 L3：**可观察、可解释、可排查**。它不负责调度决策、不作为 retry checkpoint、不替代 action gate、不要求 step-level durable retry。

## 1. v0 数据模型草案

### 1.1 `loop_run`

一条 `loop_run` 表示一次可解释的外层循环或工作单元。v0 设计成 append/update overlay，可由现有模块同步写入或异步补写。

最小字段：

- `id`: ledger run id。建议稳定前缀，例如 `project_issue:<issue_run_id>`、`cron:<task_id>:<timestamp>`、`heartbeat:<heartbeat_id>`。
- `kind`: run 类别。
  - v0 建议值：`project_issue`、`cron`、`heartbeat`、`guardian_watchdog`、`supervisor`、`completion_watch`。
  - 后续可扩展 `pi_project_cycle`、`external_event`、`digest_flush`，但不在本设计强行落地。
- `trigger`: JSON object 或结构化字段，描述唤醒原因。
  - 最小形态：`{ type, ref, source }`。
  - 示例：`{ type: "auto_run_queue", ref: "issue-558" }`、`{ type: "schedule_due", ref: "cron_task:12" }`、`{ type: "issue.status_changed", ref: "issue_event:123" }`。
- `project_id`: 可为空；系统级 watchdog 允许为空。
- `issue_id`: 可为空；project issue / supervisor / completion watch item 应尽量填。
- `session_ref`: provider/PI session 关联。
  - v0 可用 JSON：`{ agent_session_key, provider, provider_session_id, provider_turn_id, codex_thread_id, codex_turn_id }`。
- `run_ref`: 现有 source-of-truth run/watch/action 引用。
  - v0 可用 JSON：`{ issue_run_id, cron_task_id, heartbeat_id, watch_id, supervisor_event_id, guardian_alert_id, run_group_id, action_id }`。
- `status`: ledger 归一化状态。
  - v0 建议值：`running`、`succeeded`、`failed`、`skipped`、`stopped`、`pending_user`、`pending_verification`。
  - 原表的 richer status 保留在 `run_ref` 指向的 source table，不在 ledger 里重造状态机。
- `started_at`: run 开始时间。
- `ended_at`: run 结束时间；未结束为空。
- `next_wake_at`: 下一次计划唤醒；不拥有调度权，只展示现有模块给出的 `next_run_at` / `next_tick_at` / retry time。
- `stop_reason`: 终止或跳过原因；成功可为空。
- `context_pack_ref`: context pack 引用。v0 允许为空或指向现有 prompt/session/event；不要求先实现 Context Engine。
- `verification_ref`: 验证证据引用。project issue 可指向 `issue.verification_report` / issue final event / reviewer evidence；其他 loop 可为空或指向自身 result。
- `cost_snapshot`: JSON snapshot，记录 token、runtime、attempt、service tier、retry count 等当时能拿到的成本信息。没有成本来源时写 `{}`。
- `created_at` / `updated_at`: ledger 自身写入时间。

### 1.2 `loop_step`

一条 `loop_step` 表示某个 `loop_run` 内部的可解释阶段。v0 只用于 timeline，不参与恢复与重放。

最小字段：

- `id`: step id。
- `loop_run_id`: 所属 `loop_run.id`。
- `seq`: run 内单调递增序号。
- `step_type`: `observe`、`decide`、`gate`、`act`、`verify`、`notify`、`reflect`、`schedule`、`recover`。
- `status`: `running`、`succeeded`、`failed`、`skipped`。
- `started_at` / `ended_at`: 阶段时间。
- `input_ref`: 输入引用，优先指向现有表/event/session，而不是复制大 payload。
- `output_ref`: 输出引用，优先指向现有表/event/session/action/outbox。
- `error`: 阶段错误摘要，需做现有 redaction。
- `summary`: 人类可读短摘要，UI 可直接展示。

v0 不要求每个函数都有 step；只记录能解释用户问题的关键节点。

## 2. source of truth 与 overlay 规则

### 2.1 不变的真相边界

ledger 永远不应该成为这些决策的唯一依据：

- issue queue claim / executor lock / project loop 并发控制。
- cron due/claim/next run 计算。
- heartbeat pause、delegation tick、policy/action plan。
- guardian action gate、approval、direct Feishu retry。
- supervisor recovery budget、cooldown、retry-after 判断。
- completion watch active/satisfied/notified/cancelled 状态与 outbox retry。

这些仍由现有表和现有模块决定。ledger writer 失败时，source operation 不能失败；最多写 `issue_events` / logger 诊断，后续允许补写。

### 2.2 overlay 的职责

ledger 只回答：

- 这次 run 是哪个模块触发的，触发引用是什么。
- 它关联了哪个 project / issue / session / existing run。
- 它经历了哪些高层 step。
- 它最终是 succeeded / failed / skipped / pending_user / pending_verification / stopped。
- 它的下一次 wake 时间来自哪里。
- 用户或开发者应该去哪个 source table 看完整细节。

### 2.3 status 映射原则

- `succeeded`: 本轮模块完成了它负责的工作；不代表 issue done，也不代表 watched issues 全部成功。
- `failed`: 模块本轮出现错误并已记录到 source table。
- `skipped`: 本轮有明确跳过原因，例如 paused、quiet hours、already running、recent decision exists。
- `stopped`: 运行被取消、预算耗尽、或按 stop policy 停止。
- `pending_user`: 需要人工 gate / approval / needs_user。
- `pending_verification`: executor 或 verifier contract 明确进入待验收。

## 3. 现有模块映射

### 3.1 `projectLoop`

路径：

- `backend-ts/src/runner/projectLoopManager.ts`
- `backend-ts/src/runner/projectLoop.ts`
- `backend-ts/src/runner/providerRuntime.ts`
- `backend-ts/src/db/repositories/issueRuns.ts`

现有 source of truth：

- `issues.status`、`issues.attempt_count`、`issues.auto_retry_next_at`、`issues.error`
- `issue_runs`：attempt、provider/session/turn、started/ended、exit_reason、runtime metadata
- `issue_events`：status change、provider/runtime/verification 事件
- `agent_sessions`：provider session 可恢复状态

ledger 映射：

- `loop_run.kind = "project_issue"`
- `trigger.type`：`force_once` / `auto_run_queue` / `manual_enqueue` / `requeue_after_recovery`，具体从调用入口逐步补齐；拿不到时用 `queue_claim`。
- `project_id = issue.project_id`
- `issue_id = issue.id`
- `session_ref` 来自 `issue_runs.provider_session_id` / `provider_turn_id` / `codex_thread_id` / `codex_turn_id`。
- `run_ref.issue_run_id = issue_runs.id`
- `status`：
  - open `issue_runs.ended_at=''` -> `running`
  - issue `done` -> `succeeded`
  - issue `failed` -> `failed`
  - issue `pending_verification` -> `pending_verification`
  - provider transient defer / auto retry -> `stopped` 或 `pending_user`，并在 `stop_reason` 写具体原因
- `started_at` / `ended_at` 优先用 `issue_runs.started_at` / `ended_at`。
- `context_pack_ref` v0 可指向 prompt/render source，例如 `issue:<id>` + `issue_run:<id>`；等 Context Engine 后再升级。
- `verification_ref` 指向 `issue.verification_report`、最终 `issue_events` 或 reviewer evidence。
- `cost_snapshot` 从 `issue_runs.runtime_metadata_json`、service tier、attempt、provider usage 摘要读取。

建议 steps：

1. `observe`: claim issue。
2. `decide`: resolve executor/profile/model/service tier。
3. `act`: provider run start/resume。
4. `observe`: provider terminal signal / runtime event。
5. `verify`: final issue status / verification evidence。
6. `schedule`: auto retry / requeue / no next wake。

### 3.2 `cronExecutor`

路径：

- `backend-ts/src/runner/cronExecutor.ts`
- `backend-ts/src/runner/scheduleActionDispatcher.ts`
- `backend-ts/src/db/repositories/cronTaskClaims.ts`
- `backend-ts/src/db/repositories/cronTaskResults.ts`

现有 source of truth：

- `cron_tasks.status`、`last_run_at`、`last_status`、`last_result`、`run_count`、`error`、`next_run_at`
- `cron_task_schedules`：schedule expr、timezone、missed_run_policy、quiet/working hours、action payload

ledger 映射：

- `loop_run.kind = "cron"`
- `trigger = { type: "schedule_due", ref: "cron_task:<id>", source: "cronExecutor" }`
- `project_id = cron_tasks.project_id`
- `run_ref.cron_task_id = cron_tasks.id`
- `status`：`last_status=success` -> `succeeded`；`error` -> `failed`；`skipped` -> `skipped`
- `started_at` 可用 claim start 或本轮 `now`；`ended_at` 用 `last_run_at`。
- `next_wake_at = cron_tasks.next_run_at`
- `stop_reason = last_result` for skipped/failed。
- `cost_snapshot = {}`，除非 action 触发 provider run；provider 成本由对应 `project_issue` run 解释。

建议 steps：

1. `observe`: claim due cron tasks。
2. `gate`: quiet hours / missed run policy。
3. `act`: dispatch schedule action。
4. `schedule`: record success/error/skip and next run。
5. `act`: kick project loop when action produced project ids。

### 3.3 `heartbeatOrchestrator`

路径：

- `backend-ts/src/pi/heartbeatOrchestrator.ts`
- `backend-ts/src/pi/heartbeatOrchestratorSupport.ts`
- `backend-ts/src/db/repositories/pi/heartbeats.ts`
- `backend-ts/src/db/schema/007_pi_heartbeat_orchestrator.ts`

现有 source of truth：

- `pi_heartbeat_runs`：kind、project/delegation、status、trigger、started/finished、next_tick、signals/policy/action/result JSON
- `pi_heartbeat_events`：collect_signals、evaluate_policies、plan_actions、authorization_gate、guardian_signal、audit、schedule_next_tick
- `pi_delegations`：delegation heartbeat tick
- `pi_heartbeat_controls`：pause state

ledger 映射：

- `loop_run.kind = "heartbeat"`
- `trigger = { type: pi_heartbeat_runs.trigger, ref: "heartbeat:<id>", source: "heartbeatOrchestrator" }`
- `project_id = pi_heartbeat_runs.project_id`
- `run_ref.heartbeat_id = pi_heartbeat_runs.id`
- `run_ref.delegation_id = pi_heartbeat_runs.delegation_id`
- `status`：直接映射 `completed -> succeeded`、`failed -> failed`、`skipped -> skipped`、`running -> running`
- `started_at` / `ended_at` / `next_wake_at` 映射 `started_at` / `finished_at` / `next_tick_at`
- `stop_reason = error` 或 `skip_reason`
- `context_pack_ref` 暂指向 `signals_json` / `policy_json` 所在 heartbeat run；未来接 Context Engine。
- `cost_snapshot` 从 `signals_json.usage_cost` 摘要读取。

建议 steps 直接来自 `pi_heartbeat_events.event_type`：

- `collect_signals` -> `observe`
- `evaluate_policies` -> `gate`
- `plan_actions` -> `decide`
- `authorization_gate` -> `gate`
- `guardian_signal` -> `act`
- `audit` -> `reflect`
- `schedule_next_tick` -> `schedule`

### 3.4 `guardianWatchdog`

路径：

- `backend-ts/src/pi/guardianWatchdog.ts`
- `backend-ts/src/pi/guardianWatchdogAlerts.ts`
- `backend-ts/src/pi/guardianWatchdogMaintenance.ts`
- `backend-ts/src/db/repositories/pi/watchdogStatus.ts`

现有 source of truth：

- `pi_guardian_watchdog_status`：单例 last_seen/last_success/last_error/checked_components
- `pi_guardian_alerts`：open/resolved alert、severity、direct Feishu state、retry metadata
- `pi_guardian_event_inbox` / `pi_guardian_decisions`：guardian input 与 decision
- `pi_actions` / `pi_action_events`：被 gate 后的实际动作审计

ledger 映射：

- `loop_run.kind = "guardian_watchdog"`
- `trigger = { type: "schedule_layer", ref: "piAutoManageScheduler", source: "guardianWatchdog" }`
- `project_id` 可为空；component check 有 project 时填 project 级 run 或在 step output_ref 中体现。
- `run_ref.watchdog_status = "pi_guardian_watchdog_status:1"`
- `status`：有 probe exception -> `failed`；无 exception -> `succeeded`。发现 stale alert 仍是 `succeeded`，因为 watchdog 成功观察并写了 alert。
- `started_at` / `ended_at` 以本轮 watchdog context now / writeStatus 时间为准。
- `next_wake_at` 不由 watchdog 拥有；可展示 scheduler interval 推断值或留空。
- `stop_reason` 写 `last_error` 或 alerts summary。
- `context_pack_ref` 指向 `checked_components_json`；完整证据仍在 alert / inbox / decision / action 表。
- `cost_snapshot = {}`。

建议 steps：

1. `observe`: suppress unroutable lifecycle intents。
2. `observe`: run component probe（`pi_runtime`、`coordinator`、`outbox`、`digest`、`approval`、`scheduler`、`inbox`）。
3. `act`: write `pi_guardian_alerts` / direct Feishu best-effort。
4. `reflect`: upsert watchdog singleton status。
5. `recover`: resolve recovered alerts。

### 3.5 `piIssueSupervisorScheduler`

路径：

- `backend-ts/src/runner/piIssueSupervisorScheduler.ts`
- `backend-ts/src/pi/issueSupervisorContext.ts`
- `backend-ts/src/pi/issueSupervisorSignalCollector.ts`
- `backend-ts/src/db/repositories/pi/supervisorEvents.ts`

现有 source of truth：

- `issue_supervisor_events`：signal、signal_failed、decision/action/result/budget_exhausted 等事件
- `pi_recovery_attempts`：实际恢复尝试、before/after snapshot、budget window、progress/error
- `issue_runs` / `agent_sessions`：stale provider session 和 run 状态
- `project_pi_policies`：mode、allowed actions、cooldown、budget、retry-after policy
- `pi_guardian_event_inbox` / `pi_guardian_decisions` / `pi_actions`：supervisor signal 后续进入 guardian/action gate 的路径

ledger 映射：

- `loop_run.kind = "supervisor"`
- `trigger = { type: "supervisor_interval", ref: "piAutoManageScheduler", source: "piIssueSupervisorScheduler" }`
- 可选两层建模：
  - scan-level run：一次 scheduler scan，`run_ref` 记录 scanned/signaled/decision counts。
  - issue-level step：每个 ready target 作为 `loop_step`。
- `project_id` / `issue_id` 对 issue-level step 必填；scan-level 可为空或聚合。
- `session_ref` 从 `context.session.provider_session_id` / `provider_turn_id` 映射。
- `run_ref.supervisor_event_id` 指向 `issue_supervisor_events.id`；`run_ref.issue_run_id` 指向 latest run。
- `status`：写 signal 成功 -> scan `succeeded`；target active lock / recent decision -> `skipped` step；recordFailure -> `failed` step。
- `next_wake_at` 来自 supervisor interval / retry_after / cooldown_until，仅展示，不参与调度。
- `stop_reason` 写 diagnosis、budget exhausted、recent decision exists、policy off、cooldown 等摘要。
- `context_pack_ref` 可指向 supervisor recovery context snapshot 或 `issue_supervisor_events.payload_json`。
- `cost_snapshot` 可从 linked `issue_runs.runtime_metadata_json` / retry budget 摘要读取。

建议 steps：

1. `observe`: scan in-progress/open-run/retry-after issues。
2. `observe`: build recovery context。
3. `gate`: policy mode、cooldown、budget、recent decision dedupe。
4. `decide`: choose dispatchable candidate。
5. `act`: write supervisor signal and guardian signal。
6. `recover`: record recovery attempt result（由后续 action/recovery path 补写）。

### 3.6 `completionWatch`

现有实现路径：

- `backend-ts/src/pi/issueCompletionWatchEvaluator.ts`
- `backend-ts/src/integrations/feishuCompletionWatchNotifications.ts`
- `backend-ts/src/db/repositories/pi/issueCompletionWatches.ts`
- `backend-ts/src/db/repositories/pi/issueCompletionWatchAdmin.ts`

现有 source of truth：

- `pi_issue_completion_watches`：watch status、target、origin conversation/source、completed/notified/error
- `pi_issue_completion_watch_items`：watched issue initial/last/terminal status
- `pi_notification_intents`：satisfied watch notification intent
- `im_reply_drafts` / `sync_outbox` / `notifications`：实际通知与 retry/readback
- `issue_events`：触发 observer 的 issue lifecycle event

ledger 映射：

- `loop_run.kind = "completion_watch"`
- `trigger`：
  - issue lifecycle：`{ type: "issue.status_changed", ref: "issue_event:<id>", source: "completionWatchObserver" }`
  - startup sweep：`{ type: "startup_sweep", ref: "watch:<id>", source: "sweepActivePiIssueCompletionWatches" }`
  - notification queue：`{ type: "schedule_layer", ref: "pi_notification_intent:<id>", source: "queueReadyFeishuCompletionWatchNotifications" }`
- `project_id = watch.project_id`
- `issue_id = event issue id`；多 issue watch 通过 `run_ref.watch_id` 和 item table 展开。
- `run_ref.watch_id = pi_issue_completion_watches.id`
- `status`：active update -> `running` 或 `succeeded`（evaluation 本身成功）；watch satisfied -> `succeeded`；notification missing target / retry -> `failed` step；cancelled -> `stopped`。
- `started_at` / `ended_at` 使用 event/sweep/queue 时间；watch 完成时间仍以 `completed_at` 为真相。
- `next_wake_at` 通常为空；notification retry 以 `pi_notification_intents` / outbox retry 字段为准。
- `stop_reason` 写 watch error、missing target、cancel reason 或 satisfied summary。
- `verification_ref` 可为空；若 watch 目标是验证型 issue，可指向 watched issue 的 verification evidence。
- `cost_snapshot = {}`。

建议 steps：

1. `observe`: receive issue lifecycle event or sweep active watch。
2. `act`: update watch item status。
3. `decide`: determine satisfied / still active。
4. `notify`: create `pi_notification_intents`。
5. `notify`: queue Feishu draft / sync outbox。
6. `schedule`: mark sent/retry/notified state。

## 4. 分阶段接入顺序

### Phase 0：文档与边界确认（本 issue）

- 产出本设计文档。
- 人工核对模块路径存在。
- 不写 migration，不改 scheduler，不改事件表。

### Phase 1：ledger overlay 基础设施

后续实现 issue 可先做：

- 新增 `loop_runs` / `loop_steps` schema 与 repository。
- 写入 API 采用 best-effort：ledger 失败不得影响 source operation。
- 定义 idempotency key：`kind + source_table + source_id + step_type + seq`。
- 先不上 UI；只加 repository unit tests 与少量 smoke readback。

### Phase 2：先接入高价值 overlay 写入

优先顺序：

1. `heartbeatOrchestrator`：已有 `pi_heartbeat_runs/events`，映射最直接，适合验证 step projection。
2. `projectLoop`：用户最关心 issue executor 为什么 in_progress/done/failed，需把 `issue_runs`、provider session、verification ref 串起来。
3. `cronExecutor`：把 due/skip/next run 映射出来，帮助解释自动唤醒。
4. `piIssueSupervisorScheduler`：只写 scan/target signal overlay，不改变 recovery/gate。
5. `guardianWatchdog`：把 component check/alert/status 映射为 watchdog run。
6. `completionWatch`：把 watch satisfied/notification queued 映射为 notification timeline。

### Phase 3：逐步 UI 展示

- 先做只读 API：按 project / issue / session / watch 查询 ledger timeline。
- UI 先展示 overlay summary，并提供 source table/ref drilldown。
- 不允许 UI 把 ledger status 当 source-of-truth 改写现有状态。
- 不做 backfill 或只做离线只读 backfill；不要在用户请求链路里扫描大量历史表。

## 5. 可拆出的 3 个后续实现 issue

1. **feat(loop-ledger): 增加 v0 schema/repository 与 best-effort writer**
   - 新增 migration、repository、类型定义、idempotency key。
   - 单测覆盖 create/update run、append step、writer failure isolation。
   - 不接 scheduler，不上 UI。

2. **feat(loop-ledger): 接入 heartbeat/project/cron overlay 写入**
   - 先接最容易稳定映射的 heartbeat，再接 project issue 与 cron。
   - 每个接入点只同步写 ledger；source table 仍是真相。
   - focused tests 验证 source operation 正常、ledger 可解释。

3. **feat(loop-ledger): 接入 supervisor/guardian/completion watch 并提供只读 timeline API**
   - supervisor/guardian/completion watch 只做 overlay。
   - 提供 read API 和最小 UI 展示入口。
   - 明确 drilldown 到原表，不改现有事件表和调度逻辑。

如果后续发现任一 issue 需要改 scheduler 决策、action gate、Feishu 通知链路或共享 schema 以外的状态机，应暂停并重新拆分，不要顺手升级到 L4/L5。

## 6. L3 边界与验收口径

本设计达成的是：

- 能用统一词汇描述一次 loop run 与关键 step。
- 能明确每类 loop 的 source of truth 与 overlay 关系。
- 能指导后续小步接入与 UI 展示。
- 能解释 context / verification / cost 字段在 v0 可为空、可引用、逐步补齐。

本设计不承诺：

- step-level durable retry。
- workflow replay/checkpoint。
- 统一 Context Engine 已实现。
- verification harness registry 已实现。
- ledger 能驱动调度或 action gate。
- 自动 backfill 全量历史。

## 7. 本文档人工校验路径

最小验证只需确认以下路径存在：

- `backend-ts/src/runner/projectLoop.ts`
- `backend-ts/src/runner/projectLoopManager.ts`
- `backend-ts/src/runner/cronExecutor.ts`
- `backend-ts/src/pi/heartbeatOrchestrator.ts`
- `backend-ts/src/pi/guardianWatchdog.ts`
- `backend-ts/src/runner/piIssueSupervisorScheduler.ts`
- `backend-ts/src/pi/issueCompletionWatchEvaluator.ts`
- `backend-ts/src/integrations/feishuCompletionWatchNotifications.ts`
- `backend-ts/src/db/schema/001_base_schema.ts`
- `backend-ts/src/db/schema/007_pi_heartbeat_orchestrator.ts`
- `backend-ts/src/db/schema/008_cron_schedule_layer.ts`
- `backend-ts/src/db/schema/020_issue_supervisor_recovery.ts`
- `backend-ts/src/db/schema/028_pi_guardian_runtime.ts`
- `backend-ts/src/db/schema/029_pi_issue_completion_watches.ts`
