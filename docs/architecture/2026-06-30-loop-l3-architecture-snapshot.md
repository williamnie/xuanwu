# Codex Issue Runner Loop Engineering L3 架构快照与成熟度清单

> [!WARNING]
> **历史快照（2026-07-19 归档）**：本文只用于追溯 2026-06-30 的实现状态，不再是当前架构规范。当前 source of truth 见 [canonical 架构文档索引](README.md)、[核心对象合同](xuanwu/0004-core-domain-objects.md) 与 [运行可观测性合同](xuanwu/0078-runtime-observability-diagnostics.md)。

- 日期：2026-06-30
- 范围：当前仓库真实代码入口与 Loop Engineering L3 边界
- 文档性质：项目内架构说明；不替代 README，不引用外部博客/竞品措辞，不引入新 runtime 约束
- 非目标：不做运行时代码修改、不做 DB migration、不重写公开叙事

## 0. 为什么补这份文档

`docs/design.md` 仍停留在 `Web UI -> Bun API Server -> SQLite -> Runner Loop -> Provider` 的早期视图。真实代码已经包含 PI manager cycle、scheduler layer、guardian/watchdog、Feishu connector/outbox、provider session recovery、verification gate 等链路。后续 agent 如果只看旧图，容易把问题误判成“单一 runner loop”，从而越界改 schema、通知链路或核心状态机。

这份快照只把当前 L2.5-L3 的真实边界讲清楚：今晚继续执行时优先在现有结构内补洞；除非用户另行确认，不推进 L4/L5 的大重构。

## 1. 当前主链：5 分钟读图

```text
backend-ts/src/main.ts
  -> loadConfig / openDatabase / EventBus / executorProviders
  -> startServer(config, runtime)
       backend-ts/src/http/server.ts
       REST + SSE + static web + auth + system status
       Feishu settings/events、external events、im reply outbox、runner settings、read APIs
  -> restart Feishu receiver
       backend-ts/src/integrations/feishuReceiver.ts
       backend-ts/src/integrations/feishuAgentBridge.ts
  -> startAutoRunLoops(...)
       recoverInProgressIssues(...)
       sweepActivePiIssueCompletionWatches(...)
       startProjectLoop(...) for auto_run projects
       createPiAutoManageScheduler(...).start()
```

```text
Issue executor 主链
projects/issues(SQLite)
  -> backend-ts/src/runner/projectLoopManager.ts
       全局 max_parallel_projects；项目/工作区 lock；forceOnce；auto_run requeue
  -> backend-ts/src/runner/projectLoop.ts
       claimNextIssue -> publish status -> select provider/profile -> build prompt
  -> backend-ts/src/runner/providerRuntime.ts
       ensure issue_run -> provider.run -> persist issue_events/issue_runs/agent_sessions
       sync provider approval request -> signal terminal provider events
  -> agent/provider 必须显式回写 done/failed/pending_verification/cancelled
       见 docs/agent-execution-contract.md
```

```text
PI / outer loop 主链
backend-ts/src/runner/piAutoManageScheduler.ts
  每轮 runScheduleLayerCycle:
    supervisor -> cron -> delegation heartbeat -> provider terminal signals
    -> guardian decisions -> approved guardian action dispatch
    -> digest flush -> guardian watchdog -> missed intent sweep/fallback
    -> notification queues -> issue watchdog -> auto-managed project PI cycles

PI project cycle:
  backend-ts/src/http/piProjectControlApi.ts
    runProjectPiCycle -> createPiRuntimeSession -> managerCyclePrompt
    -> PI action proposals / role workflow tools / action gate / audit
```

```text
Guardian / Feishu / notification 主链
external_events / external_links
  -> feishuReceiver.ts / feishuEventsApi.ts ingest
  -> feishuAgentBridge.ts route command/chat/project selection
  -> pi_guardian_event_inbox / pi_guardian_decisions / pi_actions
  -> piGuardianActionDispatcher.ts 只执行 approved + gate_decision=execute 的白名单动作
  -> im_reply_drafts / sync_outbox / Feishu lifecycle & completion-watch notifications
  -> guardianWatchdog.ts 观察 pi_runtime/coordinator/outbox/digest/approval/scheduler/inbox stale
```

## 2. 真实组件与关键路径

### Bun server / API control plane

- 入口：`backend-ts/src/main.ts`
- HTTP server：`backend-ts/src/http/server.ts`
- 关键行为：
  - `commandMode` 区分 CLI 与 `serve`。
  - `openDatabase` 打开 SQLite state；`EventBus` 连接 SSE、通知 observer、issue lifecycle observer。
  - `createDefaultRouter` 注册 Feishu、external events、im outbox、runner settings、read APIs、system status/logs。
  - `startServer` 统一 bearer auth、CORS、static web fallback。
- L3 边界：Bun server 是单进程控制面；不要在本 issue 中拆多 daemon 或引入独立 workflow service。

### SQLite durable state

- 数据库入口：`backend-ts/src/db/database.ts`
- schema 索引：`backend-ts/src/db/schema/index.ts`
- 主要 state：
  - runner：`projects`、`issues`、`issue_events`、`issue_runs`
  - provider：`agent_sessions`、`issue_runs.provider_session_id`、`runtime_metadata_json`
  - PI：`pi_agents`、`project_pi_settings`、`pi_conversations`、`pi_actions`、`pi_action_events`
  - scheduler：`cron_tasks`、`pi_heartbeat_runs`、`pi_delegations`
  - connector：`external_events`、`external_links`
  - Feishu/outbox：`im_reply_drafts`、`sync_outbox`、`feishu_conversation_state`、`feishu_project_selections`
  - gate/watch：`pi_approval_requests`、`pi_guardian_event_inbox`、`pi_guardian_decisions`、`pi_guardian_alerts`、`pi_guardian_watchdog_status`
  - verification/watch：`pi_issue_completion_watches`、`pi_issue_completion_watch_items`、`notifications`
- L3 边界：现有 state 已经 durable，但还没有统一 `loop_runs/loop_steps` ledger；本轮只记录清单，不新增 migration。

### Project loop / executor

- loop manager：`backend-ts/src/runner/projectLoopManager.ts`
- 单次 claim：`backend-ts/src/runner/projectLoop.ts`
- provider runtime：`backend-ts/src/runner/providerRuntime.ts`
- recovery：`backend-ts/src/runner/recovery.ts`
- 关键事实：
  - `projectLoopManager` 控制 `max_parallel_projects` 与 per-project/per-workspace lock，避免同一项目内并发执行。
  - `runProjectLoopOnce` 只负责 claim、构造 prompt、调用 provider；不把 provider turn completed 等同于 issue done。
  - `providerRuntime` 持久化 runtime event、issue run、provider session，并把 approval/terminal signal 接到后续恢复链。
  - `recoverInProgressIssues` 在服务重启时按 provider session 可恢复性决定 recover/requeue/defer/fail。
- L3 边界：维持“项目内串行、多项目有限并行”的执行模型；不默认引入 worktree isolation 或 step checkpoint orchestrator。

### PI auto-manage scheduler

- scheduler：`backend-ts/src/runner/piAutoManageScheduler.ts`
- PI cycle：`backend-ts/src/http/piProjectControlApi.ts`
- 关键事实：
  - 默认 scheduler interval 是 30s，supervisor 默认 60s 扫描一次。
  - `runScheduleLayerCycle` 串起 supervisor、cron、delegation heartbeat、terminal signals、guardian decisions/action dispatch、digest、watchdog、notification queue、issue watchdog、project PI cycles。
  - `runPiAutoManageCycle` 只处理 `project_pi_settings.auto_manage=1` 且 PI agent enabled 的项目，并用 `activeProjectCycles` 防同项目 PI cycle 重入。
- L3 边界：这是当前 outer loop；今晚若要扩展，应优先加观测/文档/小 gate，不改成 durable step orchestrator。

### Guardian / watchdog

- watchdog：`backend-ts/src/pi/guardianWatchdog.ts`
- alert writer：`backend-ts/src/pi/guardianWatchdogAlerts.ts`
- maintenance：`backend-ts/src/pi/guardianWatchdogMaintenance.ts`
- guardian action dispatch：`backend-ts/src/runner/piGuardianActionDispatcher.ts`
- 关键事实：
  - watchdog 检查组件包括 `pi_runtime`、`coordinator`、`outbox`、`digest`、`approval`、`scheduler`、`inbox`。
  - stale 结果写入 `pi_guardian_watchdog_status`，异常/告警走 `pi_guardian_alerts`，必要时 direct Feishu fallback。
  - guardian dispatcher 只执行 `source=pi_guardian_orchestrator`、`gate_decision=execute`、`status=approved` 且在白名单内的动作。
- L3 边界：guardian 是 guardrail 与恢复控制面，不是任意自动化执行引擎。

### Feishu / connector / outbox

- receiver：`backend-ts/src/integrations/feishuReceiver.ts`
- bridge：`backend-ts/src/integrations/feishuAgentBridge.ts`
- external event schema：`backend-ts/src/db/schema/021_external_events.ts`
- external link schema：`backend-ts/src/db/schema/022_external_links.ts`
- outbox schema：`backend-ts/src/db/schema/023_im_reply_outbox.ts`、`backend-ts/src/db/schema/024_im_reply_outbox_dispatch.ts`
- 关键事实：
  - WebSocket 模式注册 `im.message.receive_v1` 与 `card.action.trigger`；HTTP callback 仍存在兼容路径。
  - message ingest 先 normalize/dedupe/audit，再由 bridge 做 project routing、命令解析、memory/preference/watch/project selection、PI conversation。
  - 对外回复通过 `im_reply_drafts` / `sync_outbox` / dispatcher 与 Feishu client，不应绕过 outbox 直接散发。
- L3 边界：Feishu 是当前主要 connector；不在本阶段抽象通用 connector marketplace。

### Verification contract

- contract：`docs/agent-execution-contract.md`
- review API state：`backend-ts/src/db/repositories/issueVerification.ts`
- UI evidence heuristic：`frontend/src/utils/issueWorkflowEvidence.js`
- 关键事实：
  - provider run completed、模型回复、代码修改都不等于 issue done。
  - agent/provider 完成直接相关验证后，必须显式回写 `done` / `failed` / `pending_verification` / `cancelled`。
  - `pending_verification` 有 review action：accept -> `done`，reject -> `failed`，request_changes -> `triage`。
  - 当前 evidence 仍偏启发式和事件/日志摘要；尚未产品化成独立 verification harness registry。
- L3 边界：最低标准是“每个 issue 有直接相关验证证据或明确 pending_verification”；不声称已有完整 checker/evaluator 平台。

## 3. 当前成熟度判断

结论：当前系统约为 **L2.5-L3**。

- 已超过 L2：有 SQLite durable state、auto-run queue、provider sessions、recovery、PI scheduler、action gate、connector/outbox、watchdog、completion watch。
- 正在接近 L3：已有 outer loop、有限 connector、approval/audit、pending verification、guardian 恢复链。
- 未到 L4/L5：缺统一 loop runtime/step ledger、标准 verification harness、context trace、成本/接受率指标、workflow registry、多 daemon 或生产级 step orchestrator。

## 4. L3 done checklist：最低标准

下面是“推进到 Loop Engineering L3”的最低完成线。今晚后续执行只应围绕这些项补齐，不顺手升级 L4/L5。

### 4.1 Durable state

- [ ] issue、issue_run、issue_event、agent_session 能解释一次 executor run 的输入、执行、provider session、终态。
- [ ] PI action、approval、guardian decision、notification/outbox 都有 DB 记录和 audit/event 线索。
- [ ] 服务重启后 `recoverInProgressIssues` 对 in-progress issue 有 recover/requeue/defer/fail 的确定路径。
- [ ] 每个自动化动作都能从 DB 找到 project/issue/conversation/source event 关联。
- [ ] 不要求：新增统一 `loop_runs/loop_steps` migration 或 step checkpoint runtime。

### 4.2 Connector

- [ ] Feishu 消息、卡片 action、外部事件经过 normalize/dedupe/audit 后入库或拒绝。
- [ ] `external_links` 能把 source event、project、issue、conversation、reply 关联起来。
- [ ] 对外回复优先走 `im_reply_drafts` / `sync_outbox`，有 retry/error/feishu_message_id readback 字段。
- [ ] connector 权限边界清楚：allowed chat/user、verification token/signature、runner bearer auth 不混用。
- [ ] 不要求：多平台 connector 框架、marketplace、跨租户权限模型。

### 4.3 Action gate

- [ ] PI/guardian 提议的写操作必须进入 `pi_actions`，有 `risk_level`、`requires_confirmation`、`gate_decision`、`pi_action_events`。
- [ ] 自动 dispatch 仅允许低风险、已 approved、白名单动作。
- [ ] enqueue/retry/resume/follow-up 等动作完成后能 kick 对应 project loop 或记录失败。
- [ ] 高风险动作保持人类 gate：schema、部署、外部写回、批量修改、删除、合并、付费操作。
- [ ] 不要求：全自动 merge/deploy/schema migration gate。

### 4.4 Independent verification

- [ ] issue 回写 `done` 前必须有直接相关验证摘要；没有证据时进入 `pending_verification` 或 `failed`。
- [ ] `pending_verification` 能被人工或 verifier flow accept/reject/request_changes。
- [ ] UI/PI 能识别 weak done 或 pending verification 并提示补证据。
- [ ] 高风险任务至少有 builder/checker 角色分离的执行协议，即使 checker 仍是轻量只读流程。
- [ ] 不要求：完整 evaluator service、标准化 browser/db/http/shell harness registry 全量实现。

### 4.5 Context trace

- [ ] executor prompt 至少包含 issue、project cwd、policy、skill/MCP intent、图片/附件引用等必要上下文。
- [ ] PI manager cycle 保存 conversation/session 索引，prompt 包含 project snapshot、issue state diagnostics、role/gate 约束。
- [ ] Feishu/external event 保留 source、dedupe、raw ref、normalized message、project routing 与 reply link。
- [ ] 关键决策能从 issue events、agent_sessions、pi_actions、external_links、guardian decisions 反查来源。
- [ ] 不要求：统一 Context Engine、context_pack hash、source priority/token budget 产品化。

### 4.6 Cost visibility

- [ ] issue_run 记录 attempt、provider、session、service tier、runtime metadata。
- [ ] provider/session/token 信息可被 UI 或 system status 追踪到当前可用粒度。
- [ ] PI/guardian/scheduler 至少能看见重试、失败、pending_user、pending_verification、outbox backlog。
- [ ] 后续指标应按 project/issue/run group 看 retry、verification fail、human rework、accepted/reverted。
- [ ] 不要求：cost per accepted change 的完整财务模型或预算结算系统。

## 5. L3 内允许做的事

- 小范围修复真实链路 bug：claim、kick、event publish、status 回写、watchdog 检查、notification/outbox retry。
- 补文档、私有架构快照、issue template、执行协议、最小验证脚本。
- 在现有表/字段上增强观测与 UI 展示，前提是不改共享 schema。
- 为高风险任务加更明确的人工 gate 或 pending_verification 路径。
- 补 focused tests 证明现有 contract 不回退。

## 6. 明确不做的 L4/L5 项

除非用户开新任务并明确扩大范围，不在当前 L3 阶段做：

- durable step orchestrator：`loop_runs` / `loop_steps` / checkpoint / onFailure hook / 幂等 step replay。
- JS workflow sandbox 或动态 workflow runtime。
- 多 daemon、远程 worker pool、默认 worktree isolation、自动分支/PR 编排。
- 通用 connector marketplace、多租户云权限模型、生产 SLA 监控平台。
- 自动 merge、自动部署、自动 DB migration、自动外部付费/删除等不可逆动作。
- 自我修改主规则/skills 并自动生效；只能生成 proposal，必须人类 review。
- 大范围 README/品牌叙事重写。

## 7. 晚上继续执行时的停机线

如果后续 agent 发现需要以下改动，应先停下说明，不要顺手做：

- 新增或修改 DB schema/migration。
- 改 `projectLoopManager` 的并发语义或 `projectLoop` 的终态 contract。
- 绕过 `pi_actions` / `pi_action_events` / approval gate 执行写操作。
- 绕过 `sync_outbox` 直接改 Feishu 生命周期通知链路。
- 把缺 verification evidence 的任务直接标 `done`。
- 引入 worktree、多 daemon、workflow sandbox 或全新长期后台进程。

## 8. 本文档人工校验路径

本快照已按以下当前代码入口对齐；最小验证时只需确认路径存在：

- `backend-ts/src/main.ts`
- `backend-ts/src/runner/piAutoManageScheduler.ts`
- `backend-ts/src/runner/projectLoop.ts`
- `backend-ts/src/pi/guardianWatchdog.ts`

辅助路径：

- `backend-ts/src/http/server.ts`
- `backend-ts/src/runner/projectLoopManager.ts`
- `backend-ts/src/runner/providerRuntime.ts`
- `backend-ts/src/runner/recovery.ts`
- `backend-ts/src/http/piProjectControlApi.ts`
- `backend-ts/src/runner/piGuardianActionDispatcher.ts`
- `backend-ts/src/integrations/feishuReceiver.ts`
- `backend-ts/src/integrations/feishuAgentBridge.ts`
- `docs/agent-execution-contract.md`
