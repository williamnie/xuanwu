# ADR-XW-0005：现有能力 keep / merge / migrate / delete 清单

- 状态：Accepted
- 日期：2026-07-15（live table-set reference 于 2026-07-19 刷新）
- 依赖：[ADR-XW-0004](0004-core-domain-objects.md)
- 可执行清单：`backend-ts/src/xuanwu/capabilityDispositionInventory.ts`
- 覆盖校验：`backend-ts/src/xuanwu/capabilityDispositionInventory.test.ts`
- 决策范围：live DB、主要 API、页面、后台调度器与 `backend-ts/src/pi` 生产模块
- canonical 级别：本 ADR 解释决策；TypeScript 清单保存逐项事实并由测试防止漏项

## 1. 决策与边界

本期只冻结现有能力去向，不新增表、公开 API、共享状态机、provider adapter、双写或双读。当前运行态继续以现有 SQLite/API/Git 路径为 authority；`Work / Run / Evidence / Handoff / Attention / Automation` 是目标语义，不是第二套并行 ledger。

四种结论含义：

- **keep**：现有 authority 或支撑能力继续存在；允许换玄武术语，但不复制数据。
- **merge**：多个现有 carrier/页面/API 合并成一个目标对象或视图；迁移前各 carrier 仍各自 authoritative。
- **migrate**：有明确目标 authority；必须另立 migration ADR，完成 parity、回滚和观察窗后再切换。
- **delete**：不进入目标产品；本期只记录证据和删除门禁，不执行 destructive migration。

统计：

- 87 张表：keep=55、merge=22、migrate=8、delete=2（85 张 current source + 2 张 captured live-only legacy）
- 244 条用户 API route（以 `API_ROUTE_DISPOSITIONS` 的 family 映射为准）
- 32 个页面 JSX 组件归入 9 个 surface：keep=5、merge=3、migrate=1、delete=0
- 15 个后台调度/启动单元：keep=4、merge=8、migrate=3、delete=0
- 145 个 PI 生产模块归入 11 个 family：keep=6、merge=4、migrate=1、delete=0

## 2. live reference 证据

table-set 刷新时间：`2026-07-19T12:23:34+08:00`。仓库 source HEAD 为 `da18fa14e65f`；launchd 正在服务的已部署 runtime 仍为 `v0.1.0-666-ga9c0649` / `a9c06490ecf2`，因此 W1 source 尚未部署，清单继续以 live runtime/DB 证明当前 authority，并用 current source 解释 target contract。

```bash
./scripts/status-launchd.sh
ps ax -o pid=,command= | rg '[c]odex-issue-runner.*serve'
sqlite3 -readonly "$LIVE_DB" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%';"
sqlite3 -readonly "$LIVE_DB" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name;"
```

决定性结果：capture 时 launchd `state = running`、`API OK`、`db ok: True`；进程参数明确 `--db .../state/runner.db`；live DB 有 **79** 张非 SQLite 内部表、52 条 `schema_migrations`，与 77 张 current-source 表加 `nightly_batches` / `nightly_batch_items` 两张 live-only legacy 表的 exact set 一致。runtime 仍是 `a9c0649`，不能把未部署的 W1 source behavior 误报为 live authority。

逐表 `live_rows` 仍保留 `2026-07-15T23:42:00+08:00` 的审计快照；覆盖测试可通过 `XUANWU_LIVE_DB=<path>` 对当前 live table name exact set 做只读比对，不依赖易漂移的 row count。P11.04-W1 的 fresh Automation counts/status/checksum 另由 `migrate-automation-shadow.mjs` readonly report 生成。

## 3. 数据保留等级

| 等级 | 合同 |
| --- | --- |
| `R0_DERIVED` | 可重建 projection/cache；验证无引用后即可丢弃 |
| `R1_OPERATIONAL` | 保留到活动执行结束并满足配置的运维观察窗 |
| `R2_DURABLE` | 保留整个 project/local-control-plane 生命周期并纳入备份 |
| `R3_AUDIT` | 不可变审计/工程历史；仅按显式保留策略导出后删除 |
| `R4_SENSITIVE` | 会话、附件、凭据相关或个人化内容；最小化访问并按引用生命周期清理 |

## 4. 表清单

| 表 | 结论 | 目标对象/能力 | 当前 source of truth | 保留 | live rows |
| --- | --- | --- | --- | --- | ---: |
| `agent_profiles` | **keep** | Executor configuration | agent_profiles | `R2_DURABLE` | 0 |
| `agent_sessions` | **merge** | Run.provider_session_ref drill-down | agent_sessions + provider session files | `R2_DURABLE` | 416 |
| `app_preferences` | **merge** | Local control-plane settings | app_preferences | `R2_DURABLE` | 1 |
| `assistant_tool_providers` | **keep** | Capability registry | assistant_tool_providers | `R2_DURABLE` | 0 |
| `assistant_tools` | **keep** | Capability registry | assistant_tools | `R2_DURABLE` | 0 |
| `attention_inbox_items` | **keep** | Attention primary carrier | attention_inbox_items | `R3_AUDIT` | 0 |
| `context_bundles` | **merge** | Evidence input projection | context_bundles; source events remain authoritative | `R0_DERIVED` | 0 |
| `cron_task_schedules` | **migrate** | Automation.trigger and cursor | cron_task_schedules until Automation parity | `R2_DURABLE` | 0 |
| `cron_tasks` | **migrate** | Automation definition | cron_tasks until Automation parity | `R3_AUDIT` | 3 |
| `external_events` | **keep** | Intake Evidence | external_events | `R3_AUDIT` | 49 |
| `external_links` | **keep** | Cross-system provenance | external_links | `R3_AUDIT` | 102 |
| `feishu_conversation_state` | **keep** | Connector cursor/state | feishu_conversation_state | `R1_OPERATIONAL` | 0 |
| `feishu_project_selections` | **merge** | Project-scope connector preference | feishu_project_selections | `R2_DURABLE` | 2 |
| `im_reply_drafts` | **merge** | Handoff delivery proposal | im_reply_drafts | `R4_SENSITIVE` | 52 |
| `intake_runs` | **merge** | Attention intake execution audit | intake_runs; not a core Run | `R3_AUDIT` | 0 |
| `issue_events` | **keep** | Work events and Evidence authority | issue_events | `R3_AUDIT` | 460891 |
| `issue_runs` | **keep** | Run authority | issue_runs | `R3_AUDIT` | 560 |
| `issue_supervisor_events` | **keep** | Run recovery Evidence | issue_supervisor_events | `R3_AUDIT` | 2008 |
| `issues` | **keep** | Work authority | issues | `R3_AUDIT` | 742 |
| `nightly_batch_items` | **delete** | Archived legacy nightly-batch export | live legacy table only | `R3_AUDIT` | 5 |
| `nightly_batches` | **delete** | Archived legacy nightly-batch export | live legacy table only | `R3_AUDIT` | 1 |
| `notifications` | **migrate** | Attention notification projection | notifications until parity with Attention delivery | `R1_OPERATIONAL` | 32 |
| `pi_action_events` | **keep** | Evidence and external-effect audit | pi_action_events | `R3_AUDIT` | 3169 |
| `pi_action_proposals` | **keep** | Deterministic permission proposal | pi_action_proposals | `R3_AUDIT` | 0 |
| `pi_actions` | **merge** | Handoff or Automation action candidate | pi_actions | `R3_AUDIT` | 731 |
| `pi_agents` | **merge** | Local control-plane assistant configuration | pi_agents | `R2_DURABLE` | 1 |
| `pi_approval_requests` | **merge** | Attention permission request | pi_approval_requests | `R3_AUDIT` | 0 |
| `pi_automations` | **migrate** | `automation_definitions` target authority | pi_automations until W2/G4 target single-writer cutover | `R3_AUDIT` | 0 |
| `pi_conversations` | **keep** | Operator conversation | pi_conversations | `R4_SENSITIVE` | 25 |
| `pi_delegations` | **migrate** | Automation standing order | pi_delegations until Automation parity | `R3_AUDIT` | 0 |
| `pi_guardian_alerts` | **migrate** | Attention runtime alert | pi_guardian_alerts until Attention parity | `R3_AUDIT` | 6 |
| `pi_guardian_decisions` | **keep** | Evidence: deterministic guardian decision | pi_guardian_decisions | `R3_AUDIT` | 65 |
| `pi_guardian_event_inbox` | **keep** | Guardian intake Evidence | pi_guardian_event_inbox | `R3_AUDIT` | 1870 |
| `pi_guardian_watchdog_status` | **merge** | Automation scheduler cursor | pi_guardian_watchdog_status | `R1_OPERATIONAL` | 1 |
| `pi_heartbeat_controls` | **merge** | Automation pause/resume control | pi_heartbeat_controls | `R2_DURABLE` | 0 |
| `pi_heartbeat_events` | **merge** | Automation execution Evidence | pi_heartbeat_events; not a core Run | `R3_AUDIT` | 0 |
| `pi_heartbeat_runs` | **merge** | Automation execution audit | pi_heartbeat_runs; not a core Run | `R3_AUDIT` | 0 |
| `pi_issue_completion_watch_items` | **merge** | Automation execution Evidence | pi_issue_completion_watch_items | `R3_AUDIT` | 0 |
| `pi_issue_completion_watches` | **migrate** | Automation completion watch | pi_issue_completion_watches until Automation parity | `R3_AUDIT` | 0 |
| `pi_mcp_approval_grants` | **keep** | Project-scoped MCP approval policy | pi_mcp_approval_grants | `R3_AUDIT` | 0 |
| `pi_mcp_capabilities` | **keep** | Capability registry | pi_mcp_capabilities | `R2_DURABLE` | 0 |
| `pi_mcp_servers` | **keep** | Capability registry | pi_mcp_servers | `R4_SENSITIVE` | 4 |
| `pi_memory_items` | **keep** | Supporting knowledge store | pi_memory_items | `R4_SENSITIVE` | 1 |
| `pi_persona` | **keep** | Supervisor Chat presentation configuration | pi_persona | `R4_SENSITIVE` | 0 |
| `pi_notification_intents` | **merge** | Attention delivery projection | pi_notification_intents | `R3_AUDIT` | 312 |
| `pi_notification_preferences` | **keep** | Notification policy | pi_notification_preferences | `R2_DURABLE` | 0 |
| `pi_recovery_attempts` | **merge** | Run recovery Evidence | pi_recovery_attempts | `R3_AUDIT` | 5 |
| `pi_reports` | **merge** | Evidence and Handoff projection | pi_reports; underlying facts remain authoritative | `R0_DERIVED` | 0 |
| `pi_run_group_items` | **merge** | Run grouped projection | pi_run_group_items | `R1_OPERATIONAL` | 46 |
| `pi_run_groups` | **merge** | Run grouped projection | pi_run_groups | `R1_OPERATIONAL` | 5 |
| `pi_skill_intent_audits` | **keep** | Evidence: capability selection audit | pi_skill_intent_audits | `R3_AUDIT` | 383 |
| `project_holds` | **merge** | Attention plus project execution gate | project_holds | `R3_AUDIT` | 0 |
| `project_pi_policies` | **keep** | Deterministic permission policy | project_pi_policies | `R3_AUDIT` | 38 |
| `project_pi_settings` | **migrate** | Project policy and Automation settings | project_pi_settings until field parity | `R2_DURABLE` | 0 |
| `projects` | **keep** | Project scope authority | projects | `R3_AUDIT` | 11 |
| `schema_migrations` | **keep** | Storage migration ledger | schema_migrations | `R3_AUDIT` | 39 |
| `session_command_events` | **merge** | Run or Evidence command facts | session_command_events | `R3_AUDIT` | 0 |
| `session_turn_references` | **merge** | Evidence provenance refs | session_turn_references | `R3_AUDIT` | 0 |
| `sync_outbox` | **keep** | Handoff external-delivery audit/outbox | sync_outbox | `R3_AUDIT` | 52 |
| `uploads` | **keep** | Evidence artifact store | uploads | `R4_SENSITIVE` | 54 |

### 4.1 表级 source of truth 结论

- Work/Run 继续由 `issues` / `issue_runs` authoritative；`agent_sessions` 只作为 provider Session drill-down。
- Evidence 继续分布在 `issue_events`、`issue_supervisor_events`、`pi_action_events`、外部 intake/audit 与 Git；不得为了统一命名复制 Evidence table。
- Handoff 继续由 Work、Git revision、Evidence refs 和 delivery audit 确定性组装；本期无独立 Handoff table。
- Attention 当前由 `attention_inbox_items`、Guardian alert、Approval request、Project hold/通知 carrier 共同投影；合并前不互相双写。
- Automation target authority 是 `automation_definitions` / `automation_runs/events`；`pi_automations`、`cron_tasks`、`pi_delegations`、completion watch 在 G4 前保留 ID、cursor 和各自写路径。W1 shadow 不 claim、不执行，也不是第二 writer。

## 5. API 清单

API 清单以 **method + normalized path** 为逐项 identity。测试扫描 `backend-ts/src/http/*.ts` 的生产 route 注册：排除非用户 probe `/health`，并将重复注册折叠成 239 条唯一用户 route。当前 `POST /api/system/restart` 有两个注册点；运行时按注册顺序命中 `systemRestartApi.ts`，后续只能合并实现，不得增加第三个 endpoint。

| API family | route 数 | 结论 | 目标 | 当前 source of truth |
| --- | ---: | --- | --- | --- |
| `assistant-runtime` | 21 | **keep** | Operator conversation and supporting memory/config | pi_conversations, pi_agents, pi_memory_items |
| `attention` | 25 | **merge** | Attention projections with deterministic resolution gates | attention_inbox_items and current Guardian/Approval carriers |
| `automation` | 34 | **migrate** | `automation_definitions/runs/events` API with legacy carrier compatibility | legacy pi_automations, cron_tasks/schedules, pi_delegations, heartbeat controls, and completion watches until W2/G4 |
| `capability-policy` | 44 | **keep** | Capability registry and deterministic permission policy | tool/MCP registries and project_pi_policies |
| `evidence-handoff` | 30 | **merge** | Evidence/Handoff read models and audited action requests | issue/pi audit authorities plus derived Handoff |
| `integration-intake-delivery` | 23 | **keep** | Audited intake and external delivery adapters | external_events/external_links/outbox authorities |
| `project-scope` | 17 | **keep** | Project/local control-plane scope | projects and scoped settings |
| `run-session-drilldown` | 11 | **merge** | Run with provider Session drill-down | issue_runs; agent_sessions remains a reference |
| `system-observability` | 10 | **keep** | Local runtime observability/control | live process, config, logs and event bus |
| `work-ledger` | 24 | **keep** | Work ledger compatibility API | issues remains authoritative |

<details><summary><code>assistant-runtime</code> 的逐项 routes</summary>

```text
GET /api/pi/supervisor
PATCH /api/pi/supervisor
GET /api/pi/supervisor/runtime-prompt
GET /api/pi/conversations
POST /api/pi/conversations
GET /api/pi/conversations/:id
POST /api/pi/conversations/:id/interrupt
POST /api/pi/conversations/:id/messages
GET /api/pi/memory
POST /api/pi/memory
DELETE /api/pi/memory/:id
PATCH /api/pi/memory/:id
POST /api/pi/memory/:id/approve
POST /api/pi/memory/:id/disable
POST /api/pi/memory/:id/forget
POST /api/pi/memory/:id/pin
POST /api/pi/memory/:id/promote
POST /api/pi/memory/batch
POST /api/pi/memory/candidates
GET /api/pi/memory/digest
```

</details>

<details><summary><code>attention</code> 的逐项 routes</summary>

```text
GET /api/notifications
POST /api/notifications/:id/read
GET /api/pi/approval-requests
POST /api/pi/approval-requests/:id/resolve
GET /api/pi/attention-inbox/context-bundles
GET /api/pi/attention-inbox/context-bundles/:id
GET /api/pi/attention-inbox/intake-runs
GET /api/pi/attention-inbox/intake-runs/:id
GET /api/pi/attention-inbox/items
GET /api/pi/attention-inbox/items/:id
PATCH /api/pi/attention-inbox/items/:id
POST /api/pi/attention-inbox/items/:id/domain-skill
POST /api/pi/attention-inbox/items/:id/ignore
POST /api/pi/attention-inbox/items/:id/reintake
GET /api/pi/attention-inbox/raw-events
GET /api/pi/attention-inbox/raw-events/:id
GET /api/pi/guardian/alerts
POST /api/pi/guardian/alerts/:id/ack
POST /api/pi/guardian/digest/flush
GET /api/pi/maintenance/stale-pending-actions
POST /api/pi/maintenance/stale-pending-actions/apply
```

</details>

<details><summary><code>automation</code> 的逐项 routes</summary>

```text
GET /api/cron-tasks
POST /api/cron-tasks
DELETE /api/cron-tasks/:id
PATCH /api/cron-tasks/:id
GET /api/pi/automations
POST /api/pi/automations
GET /api/pi/automations/:id
PATCH /api/pi/automations/:id
GET /api/pi/automations/runnable
GET /api/pi/delegations
POST /api/pi/delegations
GET /api/pi/delegations/:id
PATCH /api/pi/delegations/:id
POST /api/pi/delegations/:id/expire
POST /api/pi/delegations/:id/pause
POST /api/pi/delegations/:id/resume
GET /api/pi/heartbeat-timeline
GET /api/pi/issue-completion-watches
GET /api/pi/issue-completion-watches/:id
POST /api/pi/issue-completion-watches/:id/cancel
GET /api/projects/:id/pi/heartbeat/diagnostics
POST /api/projects/:id/pi/heartbeat/pause
POST /api/projects/:id/pi/heartbeat/resume
POST /api/projects/:id/pi/heartbeat/run-once
POST /api/projects/:id/pi/run-once
```

</details>

<details><summary><code>capability-policy</code> 的逐项 routes</summary>

```text
GET /api/pi/connectors
GET /api/pi/connectors/health
GET /api/pi/guardian/preferences
POST /api/pi/guardian/preferences
POST /api/pi/guardian/preferences/:id/disable
GET /api/pi/mcp/capabilities
GET /api/pi/mcp/capabilities/:id
PATCH /api/pi/mcp/capabilities/:id
GET /api/pi/mcp/discovery/results
POST /api/pi/mcp/discovery/scan
GET /api/pi/mcp/discovery/sources
POST /api/pi/mcp/servers
DELETE /api/pi/mcp/approval-grants/:id
DELETE /api/pi/mcp/servers/:id
PATCH /api/pi/mcp/servers/:id
POST /api/pi/mcp/servers/:id/introspect
POST /api/pi/oauth/openai-codex/login
POST /api/pi/oauth/openai-codex/logout
GET /api/pi/oauth/openai-codex/status
GET /api/pi/provider-settings
PUT /api/pi/provider-settings/:id
POST /api/pi/provider-settings/:id/models
GET /api/pi/skills
GET /api/pi/skills/:id
POST /api/pi/skills/:id/domain-runs
POST /api/pi/skills/:id/intake-runs
GET /api/pi/skills/domain-runs
GET /api/pi/skills/intake-runs
GET /api/pi/source-policies
POST /api/pi/source-policies
PATCH /api/pi/source-policies/automations/:id
GET /api/pi/tool-providers
GET /api/pi/tools
GET /api/pi/tools/:id
POST /api/pi/tools/:id/call
GET /api/projects/:id/pi-policy
PATCH /api/projects/:id/pi-policy
GET /api/projects/:id/pi-settings
PATCH /api/projects/:id/pi-settings
DELETE /api/projects/:id/pi-settings
GET /api/runner/settings
PUT /api/runner/settings
```

</details>

<details><summary><code>evidence-handoff</code> 的逐项 routes</summary>

```text
GET /api/handoffs
GET /api/handoffs/:id
GET /api/issues/:id/supervisor
POST /api/issues/:id/verification
POST /api/issues/:id/verifier-report
GET /api/pi/action-proposals
POST /api/pi/action-proposals
GET /api/pi/action-proposals/:id
POST /api/pi/action-proposals/:id/approve
POST /api/pi/action-proposals/:id/reject
GET /api/pi/actions
GET /api/pi/actions/:id
POST /api/pi/actions/:id/approve
GET /api/pi/actions/:id/events
POST /api/pi/actions/:id/execute
POST /api/pi/actions/:id/reject
POST /api/pi/actions/:id/request-changes
POST /api/pi/actions/:id/snooze
GET /api/pi/activity
GET /api/pi/audit-events
GET /api/pi/guardian/notification-intents
GET /api/pi/guardian/run-groups
GET /api/pi/guardian/run-groups/:id
GET /api/pi/reports
GET /api/pi/reports/:id
POST /api/pi/reports/generate
```

</details>

<details><summary><code>integration-intake-delivery</code> 的逐项 routes</summary>

```text
GET /api/external-events
GET /api/external-events/:id
POST /api/external-events/:id/create-issue
GET /api/im-reply-drafts
GET /api/im-reply-drafts/:id
POST /api/im-reply-drafts/:id/approve
POST /api/im-reply-drafts/:id/reject
POST /api/integrations/feishu/events
GET /api/integrations/feishu/settings
PUT /api/integrations/feishu/settings
GET /api/session-images
GET /api/sync-outbox
POST /api/sync-outbox/dispatch
GET /api/uploads/:id/content
POST /api/uploads/images
```

</details>

<details><summary><code>project-scope</code> 的逐项 routes</summary>

```text
GET /api/agent-profiles
POST /api/agent-profiles
DELETE /api/agent-profiles/:id
PATCH /api/agent-profiles/:id
GET /api/projects
PATCH /api/projects
POST /api/projects
DELETE /api/projects/:id
GET /api/projects/:id
PATCH /api/projects/:id
POST /api/projects/:id/hold/resume
POST /api/projects/:id/loop/start
GET /api/projects/:id/loop/status
POST /api/projects/:id/loop/stop
GET /api/projects/:id/pi/issue-state
GET /api/projects/:id/references/search
POST /api/projects/sync/codex
```

</details>

<details><summary><code>run-session-drilldown</code> 的逐项 routes</summary>

```text
POST /api/codex/approvals/:id/resolve
POST /api/commands
GET /api/sessions
POST /api/sessions
GET /api/sessions/:id
POST /api/sessions/:id/interrupt
POST /api/sessions/:id/messages
GET /api/sessions/preferences
```

</details>

<details><summary><code>system-observability</code> 的逐项 routes</summary>

```text
GET /api/capabilities
GET /api/codex/models
GET /api/events
GET /api/system/doctor
GET /api/system/logs
POST /api/system/restart
GET /api/system/status
GET /api/usage/codex
```

</details>

<details><summary><code>work-ledger</code> 的逐项 routes</summary>

```text
GET /api/issues
POST /api/issues
DELETE /api/issues/:id
GET /api/issues/:id
PATCH /api/issues/:id
POST /api/issues/:id/cancel
POST /api/issues/:id/comments
POST /api/issues/:id/enqueue
GET /api/issues/:id/events
POST /api/issues/:id/retry
GET /api/issues/:id/runs
```

</details>

## 6. 页面清单

前端当前是内存 `currentPage` 路由，不是 URL router。`page_ids` 是用户可达 surface identity；每个生产 JSX 组件在可执行清单中恰好归属一个 surface。

| surface | page ids | 结论 | 目标 | source files |
| --- | --- | --- | --- | --- |
| `assistant-runtime` | `pi-chat`, `pi-overview`, `pi-memory` | **keep** | Operator conversation and supporting memory/config | `PiAgentSettingsPanel.jsx`, `PiChat.jsx`, `PiChatComposerMeta.jsx`, `PiMemoryPanel.jsx` |
| `attention` | `pi-inbox`, `attention-inbox` | **merge** | Attention projections with deterministic resolution gates | —（已合并到 Command Center） |
| `automation` | `cron`, `pi-automations` | **migrate** | `automation_definitions/runs/events` API with legacy carrier compatibility | `Automations.jsx` |
| `capability-policy` | `settings`, `pi-connectors`, `pi-skills`, `pi-policies` | **keep** | Capability registry and deterministic permission policy | `AssistantSettingsSections.jsx`, `ConnectorDiagnosticsPanel.jsx`, `FeishuSettingsPanel.jsx`, `NotificationSettingsPanel.jsx`, `PermissionsSettingsPanel.jsx`, `PiMcpManagementPanel.jsx`, `ProviderAvailabilityPanel.jsx`, `RunnerSettingsPanel.jsx`, `Settings.jsx`, `SettingsChrome.jsx`, `SkillsRuntimePanel.jsx`, `SourcePoliciesPanel.jsx` |
| `evidence-handoff` | `handoffs`, `pi-activity`, `pi-approvals` | **merge** | Evidence/Handoff read models and audited action requests | `ActivityTimelinePanel.jsx`, `Handoffs.jsx` |
| `project-scope` | `projects` | **keep** | Project/local control-plane scope | `ProjectHoldNotice.jsx`, `Projects.jsx` |
| `run-session-drilldown` | `runs`, `sessions` | **merge** | Run with provider Session drill-down | `Runs.jsx`, `Sessions.jsx` |
| `system-observability` | `dashboard` | **keep** | Local runtime observability/control | `Dashboard.jsx` |
| `work-ledger` | `issues`, `issue-detail`, `work-board`, `work-detail` | **keep** | Work ledger compatibility API | `IssueCard.jsx`, `IssueCardMoreActions.jsx`, `IssueDetail.jsx`, `Issues.jsx`, `IssueSupervisorPanel.jsx`, `WorkBoard.jsx`, `WorkDetail.jsx` |

页面迁移规则：`Issues`/`IssueDetail` 保留为 Work feature flag 的 rollback surface；`Sessions` 归入 Run drill-down，不创建独立 Run ledger；`cron`/`pi-automations` page id 统一投影到 `Automations`；`pi-inbox`/`attention-inbox` page id 统一投影到 Command Center。兼容 page id 不再拥有独立 JSX/CSS。

## 7. 后台调度器清单

| 单元 | 结论 | 目标 | 当前入口 | source |
| --- | --- | --- | --- | --- |
| `startup-recovery` | **keep** | Run recovery | `recoverInProgressIssues` | `backend-ts/src/main.ts` |
| `startup-completion-watch-sweep` | **merge** | Automation completion-watch recovery | `sweepActivePiIssueCompletionWatches` | `backend-ts/src/main.ts` |
| `project-execution-loop` | **keep** | Work queue to ordered Run attempts | `startProjectLoop / runProjectLoopOnce` | `backend-ts/src/runner/projectLoopManager.ts` |
| `auto-manage-timer` | **keep** | Single local scheduler infrastructure | `createPiAutoManageScheduler` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `issue-supervisor-scan` | **merge** | Run recovery Evidence and Attention | `runPiIssueSupervisorSchedulerOnce` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `legacy-cron-dispatch` | **migrate** | Automation trigger/definition | `runDueCronTasks` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `legacy-pi-automation-dispatch` | **migrate** | Automation target definition/claim execution | `runDuePiAutomations` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `target-automation-dispatch` | **keep** | `automation_definitions/runs` execution | `runDueAutomations` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `delegation-heartbeat` | **migrate** | Automation standing-order execution | `runDelegationHeartbeatsOnce` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `provider-terminal-reconcile` | **merge** | Run terminal Evidence | `signalOpenRunTerminalProviderErrors` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `guardian-decision-and-action` | **merge** | Attention/Evidence with deterministic gate | `drainGuardianDecisionOrchestrator + dispatchApprovedGuardianActions` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `digest-and-delivery` | **merge** | Attention delivery projection | `runDigestFlushSchedulerOnce + queueReady*Notifications` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `guardian-watchdog` | **merge** | Attention runtime health | `runPiGuardianWatchdogOnce + missed-intent sweep` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `issue-watchdog` | **merge** | Work blocker Attention | `runAutoRunIssueWatchdogOnce` | `backend-ts/src/runner/piAutoManageScheduler.ts` |
| `pi-project-cycle` | **merge** | Automation-triggered Work proposals | `runPiAutoManageCycle` | `backend-ts/src/runner/piAutoManageScheduler.ts` |

`createPiAutoManageScheduler` 保持唯一 30s umbrella timer；其中 cron/delegation 是待迁移 Automation carrier，其他子任务分别投影 Run/Evidence/Attention。heartbeat、intake、Guardian tick 都不得冒充 engineering Run；任何外部写仍必须经过 deterministic action/approval gate 并写审计。

## 8. PI 模块清单

`backend-ts/src/pi` 的 145 个非 `*.test.ts` 模块全部在下面 family 中逐项列出；测试保证没有漏项或重复归属。

| family | 文件数 | 结论 | 目标 | source of truth |
| --- | ---: | --- | --- | --- |
| `action-permission-gate` | 17 | **keep** | Deterministic permission and external-effect gate | Action Proposal/Approval plus pi_action_events |
| `automation` | 11 | **migrate** | `automation_definitions/runs/events` execution pipeline | legacy pi_automations, heartbeats, and watches until W2/G4 |
| `capability-connectors` | 29 | **keep** | Capability and connector runtime | registered provider/tool manifests and audited calls |
| `guardian-attention` | 25 | **merge** | Attention detection, routing and delivery | Guardian authorities projected into Attention |
| `intake-context` | 8 | **merge** | Attention intake and Evidence context | external events, context bundles and intake audit |
| `memory` | 4 | **keep** | Supporting knowledge store | pi_memory_items |
| `policy-role` | 2 | **keep** | Deterministic policy and role selection | project policy plus static role contracts |
| `reporting` | 8 | **merge** | Evidence/Handoff reporting projections | underlying immutable facts remain authoritative |
| `test-support` | 2 | **keep** | Focused deterministic fixtures | test-only import graph |
| `verification-evidence` | 7 | **keep** | Evidence production and verification policy | verification facts and Git/runtime inputs |
| `work-run-orchestration` | 37 | **merge** | Work/Run orchestration and recovery | issues and issue_runs authorities |

<details><summary><code>action-permission-gate</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/actionAudit.ts
backend-ts/src/pi/actionEngine.ts
backend-ts/src/pi/actionEnvelope.ts
backend-ts/src/pi/actionGate.ts
backend-ts/src/pi/actionGateRecovery.ts
backend-ts/src/pi/actionRecordMetadata.ts
backend-ts/src/pi/approvalFastAudit.ts
backend-ts/src/pi/approvalFastPolicy.ts
backend-ts/src/pi/approvalGrantScope.ts
backend-ts/src/pi/approvalPolicyCache.ts
backend-ts/src/pi/approvalRequestParser.ts
backend-ts/src/pi/approvalSafetyPolicy.ts
backend-ts/src/pi/authorizationScope.ts
backend-ts/src/pi/nonIssueProposalActions.ts
backend-ts/src/pi/runnerChatAuthorization.ts
backend-ts/src/pi/sourcePermissionPolicy.ts
backend-ts/src/pi/stalePendingActions.ts
```

</details>

<details><summary><code>automation</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/automationRunner.ts
backend-ts/src/pi/heartbeatActionExecution.ts
backend-ts/src/pi/heartbeatOrchestrator.ts
backend-ts/src/pi/heartbeatOrchestratorSupport.ts
backend-ts/src/pi/heartbeatSignals.ts
backend-ts/src/pi/heartbeatTypes.ts
backend-ts/src/pi/issueCompletionWatchActions.ts
backend-ts/src/pi/issueCompletionWatchEvaluator.ts
backend-ts/src/pi/manualTrigger.ts
```

</details>

<details><summary><code>capability-connectors</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/browserConnectorHealth.ts
backend-ts/src/pi/browserToolCall.ts
backend-ts/src/pi/browserToolProvider.ts
backend-ts/src/pi/builtinToolRegistry.ts
backend-ts/src/pi/cliConnectorHealth.ts
backend-ts/src/pi/cliConnectorManifest.ts
backend-ts/src/pi/cliConnectorProvider.ts
backend-ts/src/pi/cliConnectorToolCall.ts
backend-ts/src/pi/cliRawEventSync.ts
backend-ts/src/pi/cliToolRunner.ts
backend-ts/src/pi/cliToolRunnerSupport.ts
backend-ts/src/pi/httpToolCall.ts
backend-ts/src/pi/httpToolProvider.ts
backend-ts/src/pi/localWorkspaceTools.ts
backend-ts/src/pi/mcpActionTools.ts
backend-ts/src/pi/mcpApprovalExpiry.ts
backend-ts/src/pi/mcpResourceRead.ts
backend-ts/src/pi/mcpToolCall.ts
backend-ts/src/pi/mcpToolDefinitions.ts
backend-ts/src/pi/mcpToolProvider.ts
backend-ts/src/pi/mcpTransport.ts
backend-ts/src/pi/piRuntimeTools.ts
backend-ts/src/pi/readOnlyRuntimeTools.ts
backend-ts/src/pi/readOnlyToolInvocation.ts
backend-ts/src/pi/repoReadActionTools.ts
backend-ts/src/pi/repoReadActions.ts
backend-ts/src/pi/toolCallAudit.ts
backend-ts/src/pi/toolProviderEnvelope.ts
backend-ts/src/pi/toolRegistrySnapshot.ts
```

</details>

<details><summary><code>guardian-attention</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/attentionRouter.ts
backend-ts/src/pi/digestFlushScheduler.ts
backend-ts/src/pi/digestFormatter.ts
backend-ts/src/pi/failurePatterns.ts
backend-ts/src/pi/guardianActionLease.ts
backend-ts/src/pi/guardianAlertRetryPolicy.ts
backend-ts/src/pi/guardianDecisionActionCandidates.ts
backend-ts/src/pi/guardianDecisionActions.ts
backend-ts/src/pi/guardianDecisionMerge.ts
backend-ts/src/pi/guardianDecisionOrchestrator.ts
backend-ts/src/pi/guardianDecisionRateLimit.ts
backend-ts/src/pi/guardianEventIngest.ts
backend-ts/src/pi/guardianFailureClassifier.ts
backend-ts/src/pi/guardianMissedDigestFallback.ts
backend-ts/src/pi/guardianMissedIntentDigest.ts
backend-ts/src/pi/guardianMissedIntentSweep.ts
backend-ts/src/pi/guardianSignals.ts
backend-ts/src/pi/guardianWatchdog.ts
backend-ts/src/pi/guardianWatchdogAlerts.ts
backend-ts/src/pi/guardianWatchdogMaintenance.ts
backend-ts/src/pi/imReplyOutboxDispatcher.ts
backend-ts/src/pi/notificationCoordinator.ts
backend-ts/src/pi/notificationPreferenceResolver.ts
backend-ts/src/pi/notificationPreferenceService.ts
backend-ts/src/pi/notificationPreferenceTools.ts
```

</details>

<details><summary><code>intake-context</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/contextBundleBuilder.ts
backend-ts/src/pi/contextPackTrace.ts
backend-ts/src/pi/domainSkillRun.ts
backend-ts/src/pi/eventRouter.ts
backend-ts/src/pi/intakeSkillInput.ts
backend-ts/src/pi/intakeSourcePolicy.ts
backend-ts/src/pi/llmIntake.ts
backend-ts/src/pi/manualSourcePull.ts
```

</details>

<details><summary><code>memory</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/memoryContext.ts
backend-ts/src/pi/memoryLifecycle.ts
backend-ts/src/pi/memoryPolicy.ts
backend-ts/src/pi/memoryTools.ts
```

</details>

<details><summary><code>policy-role</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/policyTypes.ts
backend-ts/src/pi/roleProfileSelector.ts
```

</details>

<details><summary><code>reporting</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/nightRunSummary.ts
backend-ts/src/pi/reportHealth.ts
backend-ts/src/pi/reportIssueSummary.ts
backend-ts/src/pi/reportSupervisorSummary.ts
backend-ts/src/pi/reportUsage.ts
backend-ts/src/pi/reports.ts
backend-ts/src/pi/runGroupReportStatus.ts
backend-ts/src/pi/runGroupService.ts
```

</details>

<details><summary><code>test-support</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/issueSupervisorDecisionTestSupport.ts
backend-ts/src/pi/issueSupervisorRecoveryFixtures.ts
```

</details>

<details><summary><code>verification-evidence</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/meaningfulProgress.ts
backend-ts/src/pi/projectFindings.ts
backend-ts/src/pi/projectSnapshot.ts
backend-ts/src/pi/repoContextPack.ts
backend-ts/src/pi/verificationEvidence.ts
backend-ts/src/pi/verificationPolicy.ts
```

</details>

<details><summary><code>work-run-orchestration</code> 的逐项 modules</summary>

```text
backend-ts/src/pi/agentOrchestration.ts
backend-ts/src/pi/agentOrchestrationActions.ts
backend-ts/src/pi/agentOrchestrationPayloads.ts
backend-ts/src/pi/failedRetryPolicy.ts
backend-ts/src/pi/issueProposalContext.ts
backend-ts/src/pi/issueStateManager.ts
backend-ts/src/pi/issueStateRepairExecutor.ts
backend-ts/src/pi/issueStateSnapshot.ts
backend-ts/src/pi/issueStateVerification.ts
backend-ts/src/pi/issueSupervisorActions.ts
backend-ts/src/pi/issueSupervisorContext.ts
backend-ts/src/pi/issueSupervisorContextSupport.ts
backend-ts/src/pi/issueSupervisorDecision.ts
backend-ts/src/pi/issueSupervisorDecisionFailure.ts
backend-ts/src/pi/issueSupervisorRecovery.ts
backend-ts/src/pi/issueSupervisorRecoveryAttemptRecorder.ts
backend-ts/src/pi/issueSupervisorSignalCollector.ts
backend-ts/src/pi/issueToolViews.ts
backend-ts/src/pi/providerErrorParser.ts
backend-ts/src/pi/providerErrorParserSupport.ts
backend-ts/src/pi/providerOutageDiagnosis.ts
backend-ts/src/pi/recoveryBudget.ts
backend-ts/src/pi/recoveryDiagnosis.ts
backend-ts/src/pi/runnerActionTools.ts
backend-ts/src/pi/runnerActions.ts
backend-ts/src/pi/runnerBatchTriageScope.ts
backend-ts/src/pi/runnerIssueScheduleActions.ts
backend-ts/src/pi/runnerIssueStateActions.ts
backend-ts/src/pi/runnerNextTriageActions.ts
backend-ts/src/pi/sessionObserver.ts
backend-ts/src/pi/supervisorCommitments.ts
backend-ts/src/pi/supervisorContextResolver.ts
backend-ts/src/pi/supervisorControlContracts.ts
backend-ts/src/pi/supervisorControlTools.ts
```

</details>

## 9. 兼容、迁移、回滚与最终删除门禁

- **source of truth：** 第一个迁移发布前，现有 SQLite/API/Git authorities 保持唯一写 authority。
- **双写：** 默认禁止；只有独立 migration ADR、幂等键、逐字段 parity 与审计事件齐备后才能限时开启。
- **双读：** 只允许 shadow comparison；用户读取继续旧 authority，直到 parity 观察窗通过。
- **回滚：** 停止新写并恢复旧读；新 projection 必须能由旧 rows/events/Git 重建。
- **最终删除：** consumer 引用归零、数据导出校验、备份恢复演练、观察窗、审计批准全部通过。

每个 `migrate` 项必须另立 migration ADR，至少包含 old→new ID mapping、字段/状态/cursor parity、幂等 backfill、shadow comparison、切读/切写顺序、回滚开关、观察窗和审计 actor/reason。任一 parity 失败时旧路径继续 authoritative；不得复制临时第三条路径，也不得让 LLM 选择冲突值。

## 10. 删除前置条件与证据

本期只有两张表判定为 delete，且**不在本 issue 执行删除**：

```bash
rg -n 'nightly_batches|nightly_batch_items' backend-ts/src frontend/src \
  --glob '!**/capabilityDispositionInventory.ts' \
  --glob '!**/capabilityDispositionInventory.test.ts'
strings "$DEPLOYED_BIN" | rg 'nightly_batches|nightly_batch_items'
sqlite3 -readonly "$LIVE_DB" "select 'nightly_batches',count(*) from nightly_batches union all select 'nightly_batch_items',count(*) from nightly_batch_items;"
sqlite3 -readonly "$LIVE_DB" "pragma foreign_key_list('nightly_batches'); pragma foreign_key_list('nightly_batch_items');"
```

快照证据：排除本清单自身后 current source **0 引用**；已部署 runtime binary `strings` **0 命中**；live DB 仍有 `nightly_batches=1`、`nightly_batch_items=5`；两表没有 SQLite foreign key。由于仍有 6 行历史数据，不能直接 drop。

逐项门禁：

### `nightly_batch_items`

- Export rows together with nightly_batches and preserve the parent-child mapping.
- Prove zero references in the deployed runtime and current source for one release observation window.
- Delete only after nightly_batches archival, backup/restore rehearsal, and audited migration approval.

### `nightly_batches`

- Export all rows with schema and checksum into a reviewable archive.
- Prove zero references in the deployed runtime and current source for one release observation window.
- Complete live DB backup/restore rehearsal before an audited destructive migration.

共同 destructive gate：导出 schema + rows + checksum；保留 parent/item 对应；在实际部署 revision 上完成一个 release observation window 的零消费者证明；完成 live DB backup/restore rehearsal；通过可审计 migration approval 后才允许 drop。

## 11. 验证与后续消费合同

最小验证命令：

```bash
cd backend-ts
XUANWU_LIVE_DB="$LIVE_DB" bun test src/xuanwu/capabilityDispositionInventory.test.ts
bunx tsc --ignoreConfig --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --allowImportingTsExtensions --strict \
  --skipLibCheck --lib ES2022 --types bun \
  src/xuanwu/capabilityDispositionInventory.ts \
  src/xuanwu/capabilityDispositionInventory.test.ts
```

测试会验证：85 张 current source table + 2 张 captured live-only table = 87；244 条唯一用户 API route 全覆盖；32 个 JSX 页面组件与 151 个 PI 模块恰好归属一次；12 个 scheduler 入口存在；每个 delete 项都有 live row、零生产引用和至少三条删除门禁。
