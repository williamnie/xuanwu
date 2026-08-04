# 2026-06-17 PI Guardian 完整技术设计：通知决策、授权托管与 Issue 管家

> [!WARNING]
> **历史归档（2026-07-19）**：本文描述迁移前的完整设计，不再是当前实现规范。当前 source of truth 见 [canonical 架构文档索引](README.md)、[Automation 语义](xuanwu/0060-automation-semantics.md)、[Approval / Action Gate](xuanwu/0063-approval-action-gate.md)、[统一通知 Outbox](xuanwu/0075-unified-notification-outbox.md) 与 [决策层收敛](xuanwu/0079-pi-decision-layer-consolidation.md)；不得据本文建立第二套 authority。

> 状态：完整技术设计，非实现记录。
> 日期：2026-06-17。
> 范围：`xuanwu` 中 PI 对 issue/session/notification/approval/recovery/watchdog 的托管能力。
> 目标：用户可以说“把剩下的 issue 都做完，我睡觉了”，系统不刷屏、不中断低风险执行、能自动恢复瞬态失败，并只在危险、预算耗尽、PI 不可用或确实需要业务判断时升级用户。

---

## 0. 设计边界与必须钉死的不变量

本设计不是“让 LLM 更聪明”，而是把 PI 放进一个可审计、可限流、可回退的控制面：

```text
确定性安全/时序层
  + run_group / notification_intent 持久化状态
  + PI 语义判断层
  + 统一 action gate / lease / idempotency
  + recovery budget / progress detector
  + out-of-band watchdog
```

必须满足以下不变量：

1. **LLM 不做硬安全边界**：deny-list、scope allow-list、secret/path redaction 都在 PI prompt 之前执行，PI 输出无权覆盖。
2. **approval fast-path 没有 hold**：同步 `approval/requested` 中，灰色/不确定请求必须当场 deny/decline，本次不等 PI；随后异步交给 PI/用户解释、恢复或重试。
3. **普通通知和 watchdog fallback 解耦**：普通用户消息走 `notification_intent -> digest/outbox`；watchdog 在该管道挂掉时必须走带外最小通道，不能复用 intent/outbox。
4. **事件可重复，动作不可重复**：event inbox 按 at-least-once 设计；所有决策和动作必须有 idempotency key、lease、state precondition。
5. **可以多路观察，只能单路执行**：heartbeat、supervisor、notification coordinator 都可以产信号；写动作统一经过 `PiGuardianDecisionOrchestrator` + action gate。
6. **恢复预算只看 `pi_recovery_attempts` 时间窗**：`issues.attempt_count` 只是 claim 次数证据，不能作为 PI 自动恢复预算 source of truth。
7. **run_group 是批量体验的一等实体**：digest、夜间报告、升级聚合、偏好冲突解析都必须挂在 run group 上，不能靠口头“这一批”。
8. **所有进入 PI prompt 和用户消息的文本先做 deterministic pre-filter**：不能靠 PI 自己“自觉脱敏”。
9. **偏好切换、digest flush、decision 合并都必须有可比锚点**：inbox 使用 DB 级单调 `sequence_id`，不能用 UUID/event id 比较先后。
10. **digest intent 的唯一键必须包含 flush 维度**：同一 run group 的 partial、completed、manual/recovery digest 必须能各自落行。
11. **reportable 判定覆盖 enqueue 失败/跳过**：未进入 lifecycle 的 item 也必须能被纳入完成/摘要判定，不能永远卡 active。
12. **approval fast-path 的决策和 resolver 不依赖同步 DB 写成功**：SQLite 写锁只能影响 audit 补写，不能把可 approve 请求拖成伪拒绝。
13. **transient/needs_context 初判来自 deterministic diagnosis_code**：PI 只能解释、补充证据或升级，不能把需要用户的失败降级成 transient。

---

## 1. 当前实现事实与问题映射

当前代码事实：

- `backend-ts/src/providers/codex/jsonRpc.ts`：Codex JSON-RPC request 超时硬上限 10s，超时 reject 并 restart transport。
- `backend-ts/src/providers/codex/approvalBroker.ts`：approval request 是 pending promise，必须 resolve/reject 才能继续。
- `backend-ts/src/integrations/feishuNotifications.ts`：`issue.status_changed` / `issue.created` / `approval/requested` 仍直接生成 Feishu draft/outbox，只有 Runner Chat start 做了局部 suppress。
- `backend-ts/src/runner/piAutoManageScheduler.ts`：同一 schedule cycle 内会跑 LLM supervisor、cron、delegation heartbeat、auto manage cycle，当前没有统一仲裁层。
- `backend-ts/src/db/schema/001_base_schema.ts`：`issues` 没有 batch/run-group 字段；`attempt_count` 是 claim 次数，不是恢复次数。
- `backend-ts/src/db/database.ts`：运行库使用 `bun:sqlite`，写路径是单 SQLite database，fast-path 不能把同步写锁放进 10s approval 关键路径。
- `backend-ts/src/http/piActionDispatch.ts` 与 `backend-ts/src/pi/issueSupervisorRecovery.ts`：`session.resume_followup` 是真实 gated action，且 runtime 已有 `provider_turn_id` 可作为 resume 去重锚。
- 现有 `issue_events` / `external_events` / `issue_supervisor_events` 虽有自增 id，但没有跨来源统一的 guardian 全序；新 inbox 必须补 `sequence_id`。
- `backend-ts/src/pi/meaningfulProgress.ts` 已有 meaningful progress 初版，可作为恢复进展检测基础。
- `backend-ts/src/util/redact.ts` 只有 token/secret 基础脱敏，不够覆盖本地绝对路径、stack-like 行、长日志、prompt context。

问题映射：

| 问题 | 根因 | 本设计解决点 |
| --- | --- | --- |
| 批量 issue start/done 刷屏 | lifecycle observer 直接发 IM | `notification_intent` + run group digest |
| “不用每个都通知”只停在 PI 口头承诺 | 偏好未持久化，observer 不读偏好 | `pi_notification_preferences` + preference resolver |
| approval 等 PI 可能 10s 超时 | 同步阻塞 RPC 与 LLM 时延冲突 | `PiApprovalFastPolicy`：approve-now / deny-now，禁止 hold |
| LLM 可被 prompt injection 诱导授权 | 安全边界混入 PI 判断 | deterministic `PiSafetyPolicy` 先于 prompt |
| supervisor/heartbeat split-brain | 多层各自执行动作 | `PiGuardianDecisionOrchestrator` + lease + idempotency |
| digest 可能永远不发 | 无 run_group expected-count / deadline / flush | `pi_run_groups` + `DigestFlushScheduler` |
| PI 挂了没人知道 | fallback 依赖同一 PI/outbox 链 | `PiGuardianWatchdog` out-of-band alert |
| 自动恢复无限或口径错 | 用 `attempt_count` 推断恢复 | `pi_recovery_attempts` rolling window |
| 高事件量打爆 PI | 每个事件都可能开 PI turn | decision merge window + backpressure |
| digest partial/completed 互相折叠 | digest intent key 缺 flush 维度 | `flush_reason` + `flush_sequence` / `flush_bucket` 入唯一键 |
| enqueue 失败导致 group 永远 active | 完成判定只看 lifecycle final status | item reportable 集合同时读取 `enqueue_status` 和 `final_issue_status` |
| 偏好竞态无法落地 | event id/UUID 不可比，source_sequence 仅 per-source | inbox `sequence_id` 作为 `effective_after` 锚点 |

---

## 2. 总体架构

### 2.1 组件图

```text
EventBus / issue_events / provider events
  -> PiGuardianEventIngest
     -> pi_guardian_event_inbox
     -> deterministic classifiers
        -> PiApprovalFastPolicy          # 同步 approval 的快速决策
        -> PiNotificationCoordinator     # 用户可见通知 intent/digest
        -> PiSupervisorSignalAdapter     # recovery / stale / failure 信号

PiGuardianDecisionOrchestrator
  -> decision lease / idempotency / merge window
  -> deterministic decision OR PI decision turn
  -> pi_guardian_decisions
  -> action gate
     -> pi_actions / issue actions / session resume / state repair
     -> pi_recovery_attempts

DigestFlushScheduler
  -> pi_notification_intents + pi_run_groups + preferences
  -> im_reply_drafts / sync_outbox          # 普通 IM 通道

PiGuardianWatchdog
  -> pi_guardian_alerts                     # Runner UI/system alert
  -> direct Feishu minimal sender            # 带外 fallback，不能经 intent/outbox
```

### 2.2 组件职责

| 组件 | 职责 | 禁止 |
| --- | --- | --- |
| `PiGuardianEventIngest` | 将 bus event / issue event / provider event 规范化并写入 inbox | 不直接发 IM，不直接执行动作 |
| `PiSafetyPolicy` | 确定性 deny-list、scope allow-list、路径/命令解析 | 不调用 PI，不读取 prompt 内容来放宽规则 |
| `PiApprovalFastPolicy` | 在同步 approval RPC 内快速 approve/deny | 不 hold、不等 PI、不创建 LLM turn |
| `PiNotificationCoordinator` | 生成 notification intent，读取偏好，决定 suppress/aggregate/send_now/escalate | 不直接绕过 outbox 发普通消息 |
| `RunGroupService` | 创建/维护批量执行 group 与成员状态 | 不改变 issue 权威状态 |
| `DigestFlushScheduler` | 按 complete/interval/deadline/urgent flush digest | 不吞掉未 flush intents |
| `PiGuardianDecisionOrchestrator` | 合并信号、限流、拿 lease、写 decision、派 action | 不让 supervisor/heartbeat 绕过它执行写动作 |
| `PiRecoveryBudget` | 基于 `pi_recovery_attempts` 计算预算 | 不使用 `issues.attempt_count` 当预算 |
| `PiGuardianRedaction` | prompt/user-message/audit-safe 文本 deterministic pre-filter | 不依赖 PI 输出做最后清洗 |
| `PiGuardianWatchdog` | 检测 PI/coordinator/outbox/flush 卡死并带外告警 | 不依赖 PI runtime，不走 notification_intent/outbox |

---

## 3. 数据模型

新增一个迁移，例如 `backend-ts/src/db/schema/028_pi_guardian_runtime.ts`。以下 SQL 是设计目标，落地时可按仓库迁移风格拆分 `apply()` 兼容旧库。

### 3.1 `pi_guardian_event_inbox`

用途：把运行时事件转成可幂等消费的 guardian 事件。不要复制未经脱敏的大 raw payload；只保存 normalized/redacted summary，并引用原始 `issue_events.id` 或 provider event id。

关键点：`id` 是外部可引用的稳定 UUID；`sequence_id` 是 SQLite 写入时产生的 DB 级单调序列，用于偏好生效锚点、decision merge 边界和 digest flush 顺序。任何“之前/之后”判断只看 `sequence_id`，不要比较 UUID 或 per-source sequence。

```sql
create table if not exists pi_guardian_event_inbox (
  sequence_id integer primary key autoincrement,
  id text not null unique,
  source text not null default '',              -- event_bus | issue_events | provider | scheduler
  source_event_id text not null default '',     -- bus:<id> / issue_event:<id> / provider:<id/hash>
  source_sequence integer not null default 0,   -- source-local ordering only, not globally comparable
  event_type text not null,
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  conversation_id text not null default '',
  severity text not null default 'info',
  normalized_payload_json text not null default '{}',
  redaction_profile text not null default 'prompt',
  status text not null default 'pending',       -- pending | leased | consumed | ignored | failed
  lease_owner text not null default '',
  lease_expires_at text not null default '',
  consumed_at text not null default '',
  idempotency_key text not null,
  error text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_guardian_event_id
  on pi_guardian_event_inbox(id);

create unique index if not exists ux_pi_guardian_event_source
  on pi_guardian_event_inbox(source, source_event_id, idempotency_key);

create index if not exists idx_pi_guardian_event_pending
  on pi_guardian_event_inbox(status, severity, sequence_id);

create index if not exists idx_pi_guardian_event_issue
  on pi_guardian_event_inbox(project_id, issue_id, sequence_id desc);

create index if not exists idx_pi_guardian_event_group
  on pi_guardian_event_inbox(run_group_id, sequence_id desc);
```

`idempotency_key` 规则：

```text
with upstream id:
  ${event_type}:${project_id}:${issue_id || run_group_id || conversation_id}:${source_event_id}

with source-local sequence:
  ${event_type}:${project_id}:${issue_id || run_group_id || conversation_id}:${source}:${source_sequence}

without upstream id/sequence, notification-like:
  ${event_type}:${project_id}:${scope}:${normalized_payload_hash}:${minute_bucket}

without upstream id/sequence, recovery/provider-failure-like:
  ${event_type}:${project_id}:${scope}:${diagnosis_code}:${coarse_time_bucket}:${payload_hash}
  # 允许 at-least-once；下游用 cooldown / recovery budget 收敛，不能因为 hash 相同漏数。
```

幂等边界：

- hash 前必须先 deterministic redaction/normalization，避免 secret 进入 key material；
- `source_sequence` 只用于同一 source 内排序/去重，不能作为跨 source 偏好锚点；
- provider 没给 id 的 failure/recovery 信号不能只用 payload hash，否则连续相同失败会被误删；必须加入粗时间桶，或干脆按 at-least-once 写入再由下游 cooldown 去重；
- preference、digest、decision 中引用事件顺序时写 `source_event_sequence_id` / `effective_after_sequence`，不是 `source_event_id`。

### 3.2 `pi_run_groups`

用途：表达“用户意图上的这一批”。它不是并发执行组，不改变 runner 单线程执行模型。

```sql
create table if not exists pi_run_groups (
  id text primary key,
  project_id text not null,
  origin_conversation_id text not null default '',
  source_message_id text not null default '',
  source_action_id text not null default '',
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  user_phrase text not null default '',
  expected_issue_count integer not null default 0,
  status text not null default 'active',        -- active | completed | partial | cancelled | expired
  digest_policy_json text not null default '{}',
  deadline_at text not null default '',
  max_interval_minutes integer not null default 120,
  last_digest_at text not null default '',
  digest_flush_sequence integer not null default 0,
  completed_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_run_groups_project_status
  on pi_run_groups(project_id, status, created_at desc);

create index if not exists idx_pi_run_groups_deadline
  on pi_run_groups(status, deadline_at);
```

字段规则：

- `expected_issue_count`：创建 run group 时确定，等于本次用户明确要批量处理的 candidate 数量；包括 enqueue pending/failed 的项，便于 digest 报告跳过原因。
- `deadline_at`：默认可由用户偏好或系统策略生成，例如“明天 08:00”或 `created_at + max_interval`；用于防止 digest 永远等待。
- `digest_flush_sequence`：持有 group flush lease 时递增，作为 digest intent 的 `flush_sequence` 来源，确保 partial/completed/manual digest 唯一键稳定。
- `status=completed`：所有 group item 到达 reportable terminal 状态。
- `status=partial`：deadline/max interval 到达但仍有 active item，digest 必须报告 partial。

### 3.3 `pi_run_group_items`

```sql
create table if not exists pi_run_group_items (
  run_group_id text not null,
  issue_id integer not null,
  position integer not null default 0,
  issue_title_snapshot text not null default '',
  enqueue_action_id text not null default '',
  enqueue_status text not null default 'pending', -- pending | completed | pending_approval | skipped | failed
  status text not null default 'active',          -- active | reportable | removed
  final_issue_status text not null default '',    -- lifecycle status if issue actually ran
  report_status text not null default 'active',   -- normalized reportable status, see table below
  report_bucket text not null default 'active',   -- done | verification | failed | active | skipped | needs_user
  report_reason text not null default '',         -- redacted one-line reason
  last_intent_id text not null default '',
  joined_at text not null,
  reportable_at text not null default '',
  completed_at text not null default '',
  updated_at text not null,
  primary key (run_group_id, issue_id),
  foreign key(run_group_id) references pi_run_groups(id) on delete cascade,
  foreign key(issue_id) references issues(id) on delete cascade
);

create index if not exists idx_pi_run_group_items_issue
  on pi_run_group_items(issue_id, run_group_id);

create index if not exists idx_pi_run_group_items_status
  on pi_run_group_items(run_group_id, status, report_status, final_issue_status, enqueue_status);
```

Reportable 状态全集必须只有一份定义，完成判定与 digest bucket 都读它：

| 输入来源 | 条件 | `status` | `report_status` | `report_bucket` |
| --- | --- | --- | --- | --- |
| lifecycle | `issues.status=done` | reportable | `done` | done |
| lifecycle | `pending_verification` | reportable | `pending_verification` | verification |
| lifecycle | `failed` 且 `diagnosis_code=transient` 仍有预算 | active | `active` | active |
| lifecycle | `failed` 且 needs context / no budget | reportable | `failed` / `needs_user` / `budget_exhausted` | failed / needs_user |
| lifecycle | `blocked` | reportable | `blocked` | failed |
| lifecycle | `cancelled` | reportable | `cancelled` | skipped |
| enqueue | `enqueue_status=failed` | reportable | `enqueue_failed` | skipped |
| enqueue | `enqueue_status=skipped` | reportable | `skipped` | skipped |
| enqueue | `enqueue_status=pending_approval` | reportable | `enqueue_pending_approval` | needs_user |
| current issue state | `todo` / `triage` / `in_progress` | active | `active` | active |

规则：

- `final_issue_status` 只记录 lifecycle/issue 的真实状态，不要求 enqueue failed item 必须等到 lifecycle；
- `report_status` 是 run group 完成与 digest 的唯一读取字段；
- `enqueue_status in (failed, skipped, pending_approval)` 时，落库/刷新时立即写 `status=reportable`，不能让 group 因一个未进入 lifecycle 的 item 永远 active；
- `needs_user` 与 `budget_exhausted` 必须有明确 bucket，不能在 digest 分类中丢失。

### 3.4 `pi_notification_preferences`

用途：把“别逐条通知 / 睡觉了明天再说 / 只失败找我”落成可查询状态。

```sql
create table if not exists pi_notification_preferences (
  id text primary key,
  project_id text not null default '',
  conversation_id text not null default '',
  run_group_id text not null default '',
  scope text not null,                          -- run_group | conversation | project | global
  policy_kind text not null default 'user_preference', -- user_preference | admin_default | admin_enforced | system_default
  mode text not null default 'normal',          -- quiet | digest | normal | verbose
  notify_on_json text not null default '[]',
  digest_policy_json text not null default '{}',
  source_message_id text not null default '',
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  confirmation_text text not null default '',
  effective_after_sequence integer not null default 0,
  effective_after_time text not null default '',
  version integer not null default 1,
  status text not null default 'active',         -- active | expired | superseded | disabled
  expires_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_notification_preferences_scope
  on pi_notification_preferences(scope, project_id, conversation_id, run_group_id, status, version desc);

create index if not exists idx_pi_notification_preferences_effective
  on pi_notification_preferences(status, effective_after_sequence, expires_at);
```

Preference 解析顺序：

```text
run_group explicit preference
  > origin conversation temporary/current preference
  > project user preference / admin default
  > global/user default
  > system default
```

如果项目级策略是管理员硬策略（`policy_kind=admin_enforced`），它不是普通 notification preference，而是单独的安全/合规 policy：可以压制更低层偏好，但必须在确认文案中说明“项目管理员策略覆盖了本次对话偏好”。普通 project default 不应压过用户当下 conversation 里的临时意图。

Quiet 不能压制以下 severity：

```text
urgent | pi_unavailable | needs_user | budget_exhausted | unsafe_or_external
```

临时偏好必须有 `expires_at`。如果 NL 解析无法确定过期时间，不能写永久 quiet，只能回问或写成短 TTL（例如 8h）并在确认文本中说明。

生效锚点：

- `effective_after_sequence` 来自写入 preference 事务中读到的最新 `pi_guardian_event_inbox.sequence_id`；
- `effective_after_time` 只用于展示和迁移期兜底，不作为首选比较字段；
- 不允许用 UUID/event id 判定旧事件或新事件。

### 3.5 `pi_notification_intents`

用途：所有普通用户可见输出先落 intent，再由 coordinator/digest/outbox 处理。digest intent 也是 intent，但它的唯一键必须包含 flush 维度，确保 partial 与 completed 能同时存在。

```sql
create table if not exists pi_notification_intents (
  id text primary key,
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  source_event_type text not null default '',
  idempotency_key text not null,
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  conversation_id text not null default '',
  target_channel text not null default '',        -- feishu | runner_chat | system
  target_chat_id text not null default '',
  target_thread_id text not null default '',
  target_message_id text not null default '',
  kind text not null,                             -- issue_start | issue_done | issue_failed | digest | approval | guardian_alert
  severity text not null default 'info',          -- info | watch | actionable | urgent
  requires_user integer not null default 0,
  decision text not null default 'aggregate',     -- suppress | aggregate | send_now | escalate_user
  state text not null default 'pending',          -- pending | suppressed | aggregated | ready | sending | sent | failed | cancelled
  summary text not null default '',               -- already redacted for user-message profile
  payload_json text not null default '{}',         -- redacted payload only
  preference_id text not null default '',
  flush_reason text not null default '',           -- completed | partial_deadline | partial_interval | urgent | manual | recovery
  flush_sequence integer not null default 0,       -- monotonically increases per run_group digest
  flush_bucket text not null default '',           -- fallback bucket for time-based/manual flush
  flush_after_at text not null default '',
  ready_at text not null default '',
  sent_outbox_id integer not null default 0,
  sent_at text not null default '',
  ack_required integer not null default 0,
  ack_status text not null default '',             -- pending | acked | expired | not_required
  ack_deadline_at text not null default '',
  ack_retry_count integer not null default 0,
  next_ack_retry_at text not null default '',
  error text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_notification_intent_key
  on pi_notification_intents(idempotency_key);

create index if not exists idx_pi_notification_intents_flush
  on pi_notification_intents(state, decision, flush_after_at, severity);

create index if not exists idx_pi_notification_intents_group
  on pi_notification_intents(run_group_id, state, created_at);

create index if not exists idx_pi_notification_intents_issue
  on pi_notification_intents(issue_id, kind, state, created_at desc);
```

Intent idempotency key：

```text
non-digest lifecycle/approval:
  ${kind}:${project_id}:${issue_id}:${source_event_id || source_event_sequence_id}:${target_channel}

digest:
  digest:${run_group_id}:${flush_reason}:${flush_sequence || flush_bucket}:${target_channel}

guardian alert mirror, if ever needed for UI-only system channel:
  guardian_alert:${alert_id}:${target_channel}
```

Flush 规则：

- 同一 run group 的 `partial_deadline`、`partial_interval`、`completed` digest 必须能各自插入一行；
- `flush_sequence` 由 `DigestFlushScheduler` 在持有 group flush lease 后递增，避免同一原因并发重复；
- `flush_bucket` 仅作兼容/手动 flush fallback，例如 `2026-06-18T08:00Z`；
- digest 失败只能重试同一 intent，不能创建同 key 的替代行吞掉原始 completed digest。

### 3.6 `pi_guardian_decisions`

用途：记录 deterministic policy 或 PI decision turn 的判断。所有会触发写动作的判断都要有 decision row。

```sql
create table if not exists pi_guardian_decisions (
  id text primary key,
  idempotency_key text not null,
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  decision_kind text not null,                   -- approval | notification | recovery | state_repair | watchdog
  authority text not null default 'policy',       -- policy | pi | watchdog
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  conversation_id text not null default '',
  decision text not null,                         -- approve | deny | aggregate | resume_session | retry_issue | needs_user | noop
  risk_level text not null default 'low',
  requires_user integer not null default 0,
  rationale text not null default '',             -- redacted
  evidence_json text not null default '[]',        -- redacted refs/summaries, not raw secrets
  actions_json text not null default '[]',
  state text not null default 'proposed',          -- proposed | approved | executing | completed | failed | skipped | superseded
  lease_owner text not null default '',
  lease_expires_at text not null default '',
  cooldown_until text not null default '',
  pi_session_id text not null default '',
  raw_pi_text_ref text not null default '',         -- file/ref only; raw text must be redacted before persistence if stored
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_guardian_decisions_key
  on pi_guardian_decisions(idempotency_key);

create index if not exists idx_pi_guardian_decisions_issue
  on pi_guardian_decisions(project_id, issue_id, decision_kind, state, created_at desc);

create index if not exists idx_pi_guardian_decisions_group
  on pi_guardian_decisions(run_group_id, decision_kind, state, created_at desc);
```

Decision idempotency key：

```text
${decision_kind}:${project_id}:${issue_id || run_group_id}:${diagnosis_code || kind}:${time_bucket_or_source_event}
```

非 urgent decision 使用 merge window 的 bucket；urgent/approval 使用 source event 精确 key。

### 3.7 `pi_recovery_attempts`

用途：自动恢复预算 source of truth。不要用 `issues.attempt_count`。对 `session.resume_followup` 这类 provider 侧有副作用的动作，本表同时承担 crash/replay 去重锚。

```sql
create table if not exists pi_recovery_attempts (
  id text primary key,
  idempotency_key text not null,
  source_decision_id text not null default '',
  project_id text not null default '',
  issue_id integer not null,
  run_id text not null default '',
  session_id text not null default '',
  provider_session_id text not null default '',
  provider_turn_id text not null default '',          -- observed/current turn before action
  expected_provider_turn_id text not null default '', -- precondition turn id
  result_provider_turn_id text not null default '',   -- provider turn produced by action
  run_group_id text not null default '',
  diagnosis_code text not null,
  action_type text not null,                     -- session.resume_followup | issue.retry | issue.retry_after | runner.kick_project_loop | issue.state_repair
  status text not null default 'planned',         -- planned | executing | progress | no_progress | failed | cancelled | superseded
  executing_started_at text not null default '',
  hard_timeout_at text not null default '',
  progress_detected integer not null default 0,
  progress_reasons_json text not null default '[]',
  ignored_reasons_json text not null default '[]',
  budget_window_started_at text not null,
  before_snapshot_json text not null default '{}', -- redacted state snapshot
  after_snapshot_json text not null default '{}',
  error text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_recovery_attempts_key
  on pi_recovery_attempts(idempotency_key);

create index if not exists idx_pi_recovery_attempts_issue_window
  on pi_recovery_attempts(issue_id, created_at, action_type, status);

create index if not exists idx_pi_recovery_attempts_session_window
  on pi_recovery_attempts(session_id, created_at, action_type, status);

create index if not exists idx_pi_recovery_attempts_decision
  on pi_recovery_attempts(source_decision_id);
```

预算口径：

```text
issue_auto_recovery_24h = count(pi_recovery_attempts where issue_id=? and created_at >= now-24h and status in ('planned','executing','progress','no_progress','failed'))
session_resume_24h = count(... where session_id=? and action_type='session.resume_followup' and created_at >= now-24h)
project_auto_recovery_1h = count(... where project_id=? and created_at >= now-1h)
```

默认阈值：

- issue 自动恢复：3 次 / 24h。
- session resume：2 次 / 24h。
- project 自动恢复：可按 project policy，默认 10 次 / 1h。
- `issue.retry` 与 `session.resume_followup` 共享 issue 总预算。

`session.resume_followup` 去重规则：

```text
idempotency_key = resume:${provider_session_id}:${expected_provider_turn_id}:${source_decision_id || diagnosis_code}
```

执行前必须在事务内：

1. 重新读取 run/session 的 `provider_turn_id`；
2. 若已存在相同 key 的 attempt 且 `status=executing` 且未过 `hard_timeout_at`，不重发 provider 调用；
3. 若已存在相同 key 且 `result_provider_turn_id` 非空，标记当前 decision `skipped/superseded`；
4. 创建/更新 attempt 为 `executing`，写 `expected_provider_turn_id`、`before_snapshot_json`、`hard_timeout_at`；
5. 事务提交后才调用 provider resume。

接管者处理 crash 窗口时，先读 provider/session/run 当前 `provider_turn_id`：如果 turn 已从 `expected_provider_turn_id` 推进，即使原 attempt 没写 result，也应把原 attempt 标记为 `progress/superseded`，不能再次发送同一 followup。

### 3.8 `pi_guardian_alerts`

用途：watchdog 的带外系统告警，不依赖 `notification_intent` / `sync_outbox`。

```sql
create table if not exists pi_guardian_alerts (
  id text primary key,
  alert_type text not null,                      -- pi_runtime_down | coordinator_stalled | outbox_stalled | digest_flush_stalled | approval_fast_path_error
  severity text not null default 'urgent',
  status text not null default 'open',            -- open | acked | resolved | suppressed
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  message text not null,                          -- redacted system message
  evidence_json text not null default '[]',
  ui_visible integer not null default 1,
  direct_feishu_state text not null default '',    -- not_attempted | sent | failed | retry
  direct_feishu_message_id text not null default '',
  direct_feishu_error text not null default '',
  next_retry_at text not null default '',
  retry_count integer not null default 0,
  max_retry_count integer not null default 5,
  watchdog_seen_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_guardian_alerts_open
  on pi_guardian_alerts(status, severity, created_at desc);

create index if not exists idx_pi_guardian_alerts_project
  on pi_guardian_alerts(project_id, status, created_at desc);
```

Watchdog 自身 liveness 单独暴露，避免“连 watchdog 都停了”时 UI 无从判断：

```sql
create table if not exists pi_guardian_watchdog_status (
  singleton_id integer primary key check (singleton_id = 1),
  last_seen_at text not null,
  last_success_at text not null default '',
  last_error text not null default '',
  checked_components_json text not null default '[]',
  updated_at text not null
);
```

Runner UI/system status 直接读取这张表；若 `last_seen_at` 超过阈值，也要显示“Guardian watchdog stale”。

### 3.9 Existing table extensions

#### `pi_approval_requests`

可通过 `pi_guardian_decisions` 记录 fast decision；如果 UI/API 需要快速筛选，补以下字段：

```sql
alter table pi_approval_requests add column fast_decision text not null default '';       -- approve | deny | decline | none
alter table pi_approval_requests add column fast_decision_reason text not null default '';
alter table pi_approval_requests add column fast_policy_rule text not null default '';
alter table pi_approval_requests add column fast_policy_latency_ms integer not null default 0;
alter table pi_approval_requests add column async_escalation_state text not null default ''; -- none | queued | sent | failed
```

#### `pi_actions`

现有 `pi_actions` 已有 action gate/audit 字段；新增 guardian 关联字段可选：

```sql
alter table pi_actions add column guardian_decision_id text not null default '';
alter table pi_actions add column idempotency_key text not null default '';
alter table pi_actions add column expected_state_json text not null default '{}';
alter table pi_actions add column before_snapshot_json text not null default '{}';
```

---

## 4. Run group 技术设计

### 4.1 创建时机

只有明确批量意图创建 run group：

- `issue_enqueue_batch_triage` 工具调用；
- 用户明确说“全部/剩下/这 25 个/#387-#391 都开始”；
- 后续如果 UI 批量选择 issues，也走同一 service。

单个 `issue_enqueue_next_triage` 默认不创建 run group。

### 4.2 创建流程

```text
PI tool issue_enqueue_batch_triage
  -> parseBatchTriageScope(user_phrase, issue_ids)
  -> resolve candidate triage issues in project
  -> create pi_run_groups(expected_issue_count=candidates.length, deadline/max_interval)
  -> for each candidate:
       create pi_run_group_items(status=active, enqueue_status=pending)
       create issue.enqueue pi_action with run_group_id / group item context
       execute if action gate allows
       update item.enqueue_status completed/pending/pending_approval/failed/skipped
  -> PI final reply says “已加入这一批”，不是逐 issue lifecycle 通知
```

### 4.3 状态刷新

Run group item 状态不作为 issue 权威状态；它是报告视图。刷新来源：

- lifecycle event 到达时更新对应 item `final_issue_status` / `completed_at`；
- digest flush 前实时读取 `issues.status`，修正 item report view；
- enqueue action pending/failed 也作为 item reportable 状态，防止 expected-count 永远等不到。

### 4.4 完成判定

完成判定读取 `pi_run_group_items.status/report_status/report_bucket`，不能只读 `final_issue_status`：

```text
item_reportable = item.status == 'reportable'
  OR item.report_status in reportable_statuses
  OR item.enqueue_status in ('failed', 'skipped', 'pending_approval')

all_items_reportable = every item satisfies item_reportable

if all_items_reportable:
  group.status = completed
  completed_at = now
else if deadline/max_interval reached:
  group.status = partial
  keep active for later completed follow-up digest
else:
  group.status = active
```

Reportable statuses：

```text
done | pending_verification | failed | blocked | cancelled | skipped |
needs_user | budget_exhausted | enqueue_failed | enqueue_pending_approval
```

`enqueue_status=failed/skipped/pending_approval` 的 item 必须在 enqueue 阶段直接转成 reportable；这些 item 没有后续 lifecycle，不能等待 `final_issue_status`。`status=partial` 的 group 不是终态：后续所有 item reportable 后仍需发 `flush_reason=completed` 的完成摘要。

### 4.5 Digest 依赖 run group

Digest 查询以 run group 为主，所有 bucket 与 §3.3 的 `report_bucket` 对齐：

```text
completed_count = report_bucket=done
verification_count = report_bucket=verification
failed_count = report_bucket=failed
needs_user_count = report_bucket=needs_user
active_count = report_bucket=active
skipped_count = report_bucket=skipped
```

摘要必须包含：

- 总数 / 完成 / 待验证 / 失败 / 需要用户 / 仍在跑 / 跳过；
- failed/needs_user 的 issue id + redacted one-line reason；
- enqueue failed/skipped/pending approval 的原因，避免用户误以为“丢了”；
- PI 已做过的恢复动作和预算剩余；
- 下一步：继续等 / 需要用户 / 已暂停。

迁移期没有 run group 的 legacy issue 不强行补 group：按 per-issue notification preference 退化成当前单 issue 路由，并在测试中覆盖“无 run_group 仍不丢通知”。

## 5. Notification intent 与 digest 技术设计

### 5.1 Lifecycle event 到 intent

```text
issue.status_changed / issue.created
  -> PiGuardianEventIngest writes inbox
  -> NotificationCoordinator.normalize(event)
  -> resolve run_group membership by issue_id
  -> resolve preference by run_group/conversation/project/global
  -> classify severity/kind
  -> write pi_notification_intents(idempotent)
  -> if send_now/escalate: mark ready
  -> if aggregate: wait for DigestFlushScheduler
  -> if suppress: mark suppressed but keep audit row
```

### 5.2 Severity mapping

Severity 初判必须由 deterministic classifier 产出，不由 PI 自由判断。PI 可以补充解释、建议升级、生成用户可读摘要，但不能把 deterministic `needs_context` / `unsafe` 降级为 `transient` / `info`。

| Event / diagnosis_code | Default kind | Default severity | Default decision |
| --- | --- | --- | --- |
| issue created | issue_created | info | suppress if run_group else send_now/aggregate by preference |
| issue todo/in_progress | issue_start | info | aggregate/suppress for run_group |
| issue done | issue_done | info | aggregate for run_group |
| issue pending_verification | issue_pending_verification | watch | aggregate unless user verification required |
| provider EOF / stream disconnect / timeout / rate_limited with retry_after | issue_failed | watch | send to supervisor/recovery, aggregate |
| repeated identical provider failure with budget remaining | issue_failed | watch | aggregate + cooldown recovery |
| missing context / business decision required / ambiguous user instruction | issue_failed | actionable | escalate_user |
| auth required / approval rejected / external account needed | issue_failed | actionable | escalate_user |
| deterministic build/test failure needing repo/user fix | issue_failed | actionable | escalate_user or digest needs_user |
| budget exhausted | budget_exhausted | actionable | escalate_user |
| unsafe/external | unsafe_or_external | urgent | send_now + ack |
| PI unavailable | pi_unavailable | urgent | watchdog, not normal intent |

Classifier 规则：

- `transient` 只来自可枚举 diagnosis_code：`provider_eof`、`stream_disconnect`、`provider_timeout`、`provider_rate_limited`、`transport_restart`、`scheduler_retryable_error`；
- `needs_context` 只要出现 `missing_user_input`、`ambiguous_requirement`、`auth_required`、`approval_denied`、`external_account_required`、`business_decision_required`，就不可被 PI 降级；
- unknown diagnosis 默认 `actionable/needs_user` 或至少进入 digest 的 needs_user bucket，不得静默 aggregate；
- prompt/issue/log 中的文字只能作为 classifier 的 evidence，不能直接改变分类权威。

### 5.3 Digest flush 触发器

`DigestFlushScheduler` 每 30-60s 扫描：

1. `run_group.completed_at` 刚产生且 `last_digest_at < completed_at`。
2. `now - last_digest_at >= max_interval_minutes`，且 group 有未 flush intents。
3. `deadline_at <= now`。
4. urgent/actionable intent 到达且 preference 未允许静默。
5. PI 恢复后发现 missed intents。

Flush 后：

- 持有 group flush lease 后递增 `flush_sequence`；
- 生成 `kind=digest` intent，`idempotency_key` 必须包含 `flush_reason` + `flush_sequence/flush_bucket`；
- 普通出站仍由 intent 进入 `im_reply_drafts` / `sync_outbox`；
- 更新 group `last_digest_at`，但 partial 后 group 仍保持 active/partial，可在 completed 时再发完成摘要；
- 将被包含的 lifecycle intents 标记 `aggregated` 或 `sent`；
- 如果 digest failed，不丢 intent，记录 `state=failed` + retry。

### 5.4 普通消息出站

普通用户消息仍复用现有 outbox：

```text
pi_notification_intents ready
  -> build redacted content/card
  -> create im_reply_drafts(status=approved, created_by='pi_guardian')
  -> create sync_outbox
  -> imReplyOutboxDispatcher
  -> mark intent sent_outbox_id/sent_at or failed
```

不得绕过 outbox 发普通生命周期消息；只有 watchdog fallback 可以绕过。

### 5.5 Ack 语义

- `info/watch` 默认 `ack_required=0`。
- `urgent` 默认 `ack_required=1`。
- Feishu `message_id` 只表示平台接收，不是用户 ack。
- Ack 来源可以是：Feishu card callback、Runner UI acknowledge、用户回复匹配当前 alert/intent。
- Ack deadline 到期后：Runner UI banner 持续显示；IM 重试必须指数退避并有上限，quiet 期内 urgent 也不能固定频率整晚刷屏。
- 建议默认 `ack_retry_count <= 3`，退避如 15min / 60min / 4h；超过上限后只保留 UI banner 与最终 digest 提醒。

---

## 6. Preference 技术设计

### 6.1 NL preference 落库流程

```text
User: “我睡觉了，明天再汇报”
  -> PI parses candidate preference
  -> deterministic validator checks scope/mode/expires_at
  -> if temporary phrase and no expires_at: ask clarification or set bounded default TTL
  -> transaction:
       read max(pi_guardian_event_inbox.sequence_id) as effective_after_sequence
       write pi_notification_preferences(version+1, effective_after_sequence)
  -> reply confirmation after DB write succeeds
  -> coordinator applies preference only to events with sequence_id > effective_after_sequence
```

如果迁移期事件没有 `sequence_id`，只能使用 `effective_after_time` 作为展示/兜底，并在 audit 中标记 `ordering_anchor=time_fallback`；正式实现不允许继续生成无 sequence 的 guardian event。

### 6.2 Confirmation 文案约束

确认文案必须明确：

- scope：这个 run group / project / conversation；
- mode：quiet/digest/normal/verbose；
- notify_on：哪些情况仍会打扰；
- expires_at：什么时候恢复；
- 覆盖关系：run_group/conversation/project/global 谁生效，是否存在 admin_enforced 项目策略覆盖本次对话。

示例：

```text
已切到本批次安静模式，到明天 08:00 自动恢复 normal。期间普通 start/done 会进汇总；只有需要你、预算耗尽、危险授权或 PI 不可用时才会通知。
```

### 6.3 竞态处理

- preference row 写入成功后才回复用户；
- `effective_after_sequence` = 写入事务内看到的最新 `pi_guardian_event_inbox.sequence_id`；
- coordinator 对 `event.sequence_id <= effective_after_sequence` 的旧事件按旧偏好处理，对 `>` 的新事件按新版本处理；
- 如果旧事件已经进 outbox，不强撤；后续 digest 需要说明“偏好从 X 时刻生效”；
- 不允许使用 `effective_after_event_id` / UUID / per-source `source_sequence` 做跨 source 顺序判断。

## 7. Approval fast-path 技术设计

### 7.1 目标

在 Codex approval 同步 RPC 的 10s 上限内完成本次 request 决策，内部目标 latency < 100ms。

### 7.2 决策流

Fast-path 分两条链：同步链只做内存可判定策略和 resolver；持久化/audit 是同步返回后的 best-effort 补写。SQLite 写锁、audit 表异常、coordinator lag 都不能进入 approval 10s 关键路径。

```text
approval/requested
  -> parse/normalize request in memory
  -> PiGuardianRedaction.redactApprovalSummary in memory
  -> PiSafetyPolicy.evaluateDenyList from in-memory/static policy cache
     - deny-list hit: resolveApproval(decline) immediately
  -> PiApprovalFastPolicy.evaluateAllowList from in-memory/static policy cache
     - exact low-risk scope hit: resolveApproval(approve once) immediately
     - exact narrow session grant hit: resolveApproval(approve-for-session) only if provider scope semantics are proven narrow
     - no exact hit / parse failed / ambiguous / policy cache unavailable: resolveApproval(deny-now)
  -> after resolver returns:
       enqueue best-effort audit write to pi_approval_requests + pi_guardian_decisions
       if denied/ambiguous: enqueue async explanation/escalation outside RPC
```

同步链允许读取的状态：

- request payload 本身；
- 当前 provider/session/project scope 的内存快照；
- 预加载的 deny-list/allow-list/policy cache；
- 纯函数 path/command parser。

同步链禁止：

- 等 PI turn；
- 等用户；
- 等 SQLite 写锁；
- 因 audit write 失败改变已经算出的 approve/deny；
- 因 DB 繁忙把 allow-list 精确命中的低风险请求伪拒绝。

如果 fast policy 必须依赖某个 DB 状态但该状态不在 cache 中，则按 `policy_cache_unavailable` 归入 unknown 并 deny-now；这是“缺少决策依据”的拒绝，不是“DB 写锁慢”的伪拒绝。cache 刷新必须在 RPC 外完成。

### 7.3 灰色地带规则

灰色地带定义：

- deny-list 没命中；
- allow-list 也没精确命中；
- command/path 解析失败；
- request scope 不含当前 project/issue/workspace；
- provider permission object 语义不清；
- PI/coordinator 当前不可用；
- policy cache 不可用或过期；
- fast policy 超过内部 latency budget。

处理方式：

```text
gray / unknown / ambiguous -> deny-now / decline-now
```

禁止：

```text
gray -> wait for PI
gray -> hold approval promise
gray -> ask user synchronously
gray -> approve because “看起来不危险”
```

### 7.4 Deny-list

确定性 deny-list 至少覆盖：

- `sudo` / `su` / privilege escalation；
- system/global service：launchd/systemd、`/Library`、`/System`、`/etc`、`/usr/local` 等非当前 repo 目标；
- destructive filesystem：`rm -rf`、清空目录、大批量 delete、不可逆迁移；
- destructive git：`git reset --hard`、force push、remote rewrite、tag/release publish；
- secrets/credentials：SSH key、keychain、browser password/profile、cloud credentials、token files；
- cross workspace/repo，除非当前 user instruction 明确扩大 scope；
- production/paid/external account/real user data；
- shell string 包含无法解析的 nested eval/curl|sh/remote script execution。

### 7.5 Allow-list

自动 approve 只允许：

- 当前 repo/workspace 内 read-only；
- 当前 issue scope 内小范围 file change；
- test/lint/build/typecheck；
- git status/diff/log/show；
- Runner Chat 明确 delegation 下的 continuation/resume；
- 所有路径 normalize 后仍在 project cwd 下。

### 7.6 `approve for session`

默认只 `approve once`。`approve for session` 只有在同时满足以下条件时才允许：

1. provider request type 的 session grant 语义已知且足够窄；
2. grant 绑定 provider/session/request_type/normalized scope；
3. 后续更高风险请求仍会重新触发 approval 或可由 deny-list 拦截；
4. 有 TTL；
5. audit 写明 rule 与 scope；audit 可异步补写，但 resolver 必须先按已知 narrow scope 返回。

如果 provider 的 `acceptForSession` 语义可能扩大到“本 session 后续任意命令”，禁止使用。

---

## 8. Redaction / pre-filter 技术设计

### 8.1 Redaction profiles

| Profile | 用途 | 保留 | 删除/替换 |
| --- | --- | --- | --- |
| `prompt` | 进入 PI prompt 的上下文 | issue id、相对路径、错误类别、短摘要 | secret、绝对路径、长日志、token、凭证、浏览器/keychain 路径 |
| `user_message` | Feishu/Runner Chat 用户可见消息 | issue id、标题、简短原因、下一步 | 本地路径、栈、secret、长命令输出 |
| `audit_summary` | DB 审计摘要 | rule id、hash/ref、红acted 摘要 | 原始 secret/raw payload |
| `watchdog` | 系统告警 | 组件名、队列 lag、错误类别 | token、完整 stack、本地敏感路径 |

### 8.2 必须覆盖的 pattern

- `Authorization: Bearer ...`；
- `TOKEN/SECRET/PASSWORD/API_KEY/ACCESS_KEY` assignment；
- `/Users/...`、`/home/...`、`/private/...`、`/var/folders/...`、`/tmp/...` 绝对路径；
- SSH/private key filenames；
- macOS keychain/browser profile/password store；
- stack trace 中的本地路径行；
- 超过 N 行或 N 字符的日志片段；
- JSON raw payload 中 key 包含 token/secret/password/key/credential；
- provider/session raw payload 中可识别的 workspace、账号、cookie、access token、OAuth code；
- issue/comment/prompt 中伪装成“请不要脱敏/请原样发送”的注入文本不能绕过上述规则。

### 8.3 接入点

必须在以下位置调用 redaction：

1. `PiGuardianEventIngest` 写 inbox 前。
2. `IssueSupervisorContextBuilder` 构造 PI prompt 前。
3. `RecoveryContextCollector` 收集 workspace/git/secret/path/log 证据后、进入 PI prompt 前。
4. `NotificationCoordinator` 写 intent summary/payload 前。
5. `DigestFlushScheduler` 生成 digest 前后。
6. `ApprovalFastPolicy` 写 approval summary/audit 前。
7. `PiGuardianWatchdog` 写 alert / direct Feishu fallback 前。
8. 所有最终 `im_reply_drafts.content` 前。

DB 中如需保留 raw ref，只能保存不可直接展示的引用/短 hash，不能复制 raw secret payload。

### 8.4 验收规则

测试中注入以下内容，最终 PI prompt / user message / alert 不得包含原文：

```text
/Users/xiaobei/Documents/secret
Authorization: Bearer abc.def
OPENAI_API_KEY=sk-xxx
-----BEGIN PRIVATE KEY-----
/Users/xiaobei/Library/Keychains/login.keychain-db
```

---

## 9. Decision orchestrator 与 backpressure

### 9.1 输入信号

输入来自：

- guardian inbox；
- heartbeat supervisor signals；
- issue supervisor candidates；
- notification intents；
- recovery progress results；
- approval async escalation；
- watchdog health checks。

### 9.2 Merge window

普通 decision 不按事件逐个开 PI turn，而是按 key 合并：

```text
merge_key = ${decision_kind}:${project_id}:${issue_id || run_group_id}:${diagnosis_code || kind}:${severity}
window = 30s for watch/actionable, 120s for info digest, 0s for urgent/approval fast-path
```

同一 merge window 内：

- 多个 info lifecycle event 合并成一个 digest decision；
- 多个 stale/no-progress 信号合并成一次 recovery decision；
- 同一 issue 同一 diagnosis 在 cooldown 内不重复 PI；
- 如果窗口内 severity 从 info/watch 升到 actionable/urgent，立即破窗结算当前 key，不等原窗口结束；
- urgent、unsafe、approval fast-path 不等窗口。

### 9.3 Rate limit

默认：

- per project PI decision turns：最多 3/min；
- global PI decision turns：最多 10/min；
- run group digest decision：最多 1/2min，除 urgent；
- recovery decision：同 issue cooldown 默认 5min。

超过限流时：

- info/watch：继续 aggregate，记录 `backpressure_deferred`；
- actionable：如果 deterministic policy 可处理则处理，否则 delayed escalation；
- urgent：绕过 PI，直接 deterministic escalation/user alert。

### 9.4 Lease

执行写动作前必须拿 lease：

```text
lease_key = ${project_id}:${issue_id || run_group_id}:${action_type}
lease_ttl = 30s for lightweight, 5min for recovery/session actions
```

如果 lease 已被占用：

- 当前 decision 标记 `skipped`，reason=`lease_held`；
- 不创建重复 `pi_action`；
- 对 `session.resume_followup`，接管前还要读取 `pi_recovery_attempts` 中 executing attempt 和 provider/session 当前 turn，避免崩溃窗口重复 resume；
- 下次由 cooldown/flush 重新评估。

### 9.5 单一 action 出口

所有写动作必须经过：

```text
PiGuardianDecisionOrchestrator
  -> gatePiActionEnvelope
  -> state precondition check
  -> idempotency check
  -> create/update pi_actions
  -> execute action or leave pending
  -> record result
```

Heartbeat 不再直接执行 repair/retry；它只生成 action candidate。

---

## 10. Issue supervisor / recovery 技术设计

### 10.1 Recovery action 类型

允许的自动恢复动作：

- `session.resume_followup`；
- `session.steer`；
- `issue.retry`；
- `issue.retry_after`；
- `runner.kick_project_loop`；
- `issue.state_repair`；
- `needs_user.escalate`。

### 10.2 Budget

预算只从 `pi_recovery_attempts` 计算：

```text
if issue_auto_recovery_24h >= 3 -> budget_exhausted
if session_resume_24h >= 2 -> no more resume
if project_auto_recovery_1h >= project_policy.max -> defer/escalate
```

`issues.attempt_count` 用途：

- 展示 issue 被 runner claim 过几次；
- retry policy 的辅助证据；
- 不参与 PI 自动恢复预算。

失败分类与预算耗尽：

- budget exhausted 是 deterministic recovery budget 结果，不由 PI 判定；
- budget exhausted 的 item 立即进入 `report_status=budget_exhausted` / `report_bucket=needs_user`；
- PI 可以解释“为什么耗尽”，不能把它改回 watch/aggregate。

### 10.3 Progress baseline

每个恢复动作执行前记录 `before_snapshot_json`：

```json
{
  "issue": {"status": "in_progress", "updated_at": "..."},
  "run": {"id": "...", "status": "running", "updated_at": "..."},
  "session": {"provider_session_id": "...", "status": "active", "updated_at": "..."},
  "git_diff_hash": "sha256:..."
}
```

恢复后一段时间刷新：

- 新 agent message；
- command completed；
- git diff hash changed；
- issue/run/session 状态推进；
- verification/commit/issue update signal。

排除：

- keepalive；
- token usage；
- repeated identical error；
- empty turn；
- 只有 timestamp 但无语义变化的 heartbeat。

### 10.4 `session.resume_followup` 幂等执行

`session.resume_followup` 会对 provider session 产生副作用，不能只靠 decision lease + issue state precondition。必须按以下流程：

```text
orchestrator chooses session.resume_followup
  -> transaction:
       read latest run/session provider_turn_id
       verify expected_provider_turn_id still matches
       find/create pi_recovery_attempts(idempotency_key=resume:session:turn:decision)
       if existing executing and not hard-timeout: skip provider call
       if existing result_provider_turn_id: skip provider call
       mark attempt executing with hard_timeout_at
  -> call provider steer/resume
  -> transaction:
       persist result_provider_turn_id
       persist issue event / run raw_ref
       mark attempt progress or scheduled progress-check
```

Crash 接管规则：

- 如果进程在 provider call 后、写 result 前崩溃，接管者先读 run/session/provider 可见 turn；
- 若 current `provider_turn_id != expected_provider_turn_id`，认为 provider 侧已有推进，把旧 attempt 标记为 `progress/superseded`，不重复 resume；
- 若仍未推进且旧 attempt 未过 `hard_timeout_at`，继续等待；
- 只有旧 attempt 过硬超时、且 provider/session 仍未推进、且预算仍允许时，才能创建新的 attempt。

### 10.5 `issue.state_repair`

这是高爆炸半径动作，只能修确定性 mismatch。

必须满足：

1. diagnosis 来源是 deterministic `issueStateManager` / runtime state，不是 PI 自由猜测；
2. payload 包含 expected current state：issue status、run id/status、session status、updated_at/version；
3. 执行前重新读取状态，precondition 不匹配则 abort；
4. 保存 before snapshot；
5. 写 `issue.state_manager_repair` event；
6. repair 后写 after snapshot；
7. 仍需通过 action gate。

禁止：

- PI 直接拼 `{status:'done'}`；
- 有 active run/session 时把 issue 标 terminal；
- 没有 verification evidence 时直接 done。

---

## 11. Watchdog 技术设计

### 11.1 Watchdog 检测项

`PiGuardianWatchdog` 独立于 PI runtime，定时检查并刷新 `pi_guardian_watchdog_status.last_seen_at`：

- PI runtime 连续失败；
- decision orchestrator 队列 lag 超阈值；
- notification coordinator 未消费 intents；
- digest flush overdue；
- sync_outbox 连续失败；
- approval fast-path resolver error/latency 异常；
- scheduler heartbeat 停止；
- guardian event inbox pending 数持续增长；
- watchdog 自身 heartbeat 是否过旧（由 Runner UI/system status 判断）。

### 11.2 带外告警通道

Watchdog fallback 顺序：

1. 写 `pi_guardian_alerts(status=open, ui_visible=1)`；
2. Runner UI / system status API 直接读取 alerts，这是唯一不依赖外部平台的主带外通道；
3. 尝试 direct Feishu minimal text sender；
4. direct Feishu 失败则记录 `direct_feishu_state=retry`、`retry_count`、`next_retry_at`，按退避和上限重试；
5. PI 恢复后补扫 missed intents / alerts，生成补充摘要。

覆盖边界：watchdog 能兜住 PI/coordinator/outbox/digest 管道挂；不能保证兜住 Feishu 平台/token/API/network 故障。Feishu direct fallback 是 best-effort，Runner UI alert 才是主承诺。

禁止：

```text
watchdog -> pi_notification_intents -> coordinator -> sync_outbox
```

因为 watchdog 的目的就是在 coordinator/outbox/PI 失效时告警。

### 11.3 Watchdog 消息内容

必须 redacted，且只包含：

- 哪个组件异常；
- 影响 project/run_group/issue 范围；
- runner 是否仍在执行；
- 用户需要做什么；
- 恢复后是否会补发摘要。

---

## 12. API / UI 技术设计

### 12.1 Backend API

新增只读/控制 API：

```text
GET  /api/pi/guardian/run-groups?project_id=&status=
GET  /api/pi/guardian/run-groups/:id
GET  /api/pi/guardian/notification-intents?run_group_id=&state=
GET  /api/pi/guardian/alerts?status=open
POST /api/pi/guardian/alerts/:id/ack
GET  /api/pi/guardian/preferences?project_id=&conversation_id=&run_group_id=
POST /api/pi/guardian/preferences
POST /api/pi/guardian/digest/flush
```

API 返回内容必须使用 user_message redaction profile；不要返回 raw provider payload。

### 12.2 Runner UI

最小 UI surface：

- 顶部 system alert banner：读取 open `pi_guardian_alerts`；
- watchdog stale banner：直接读取 `pi_guardian_watchdog_status.last_seen_at`，不依赖 PI/coordinator；
- issue/run group 页面展示：group 总数、完成、失败、需要用户、待验证、仍在跑、跳过；
- notification preference 状态：当前 mode、expires_at、notify_on、effective_after_time；
- alert ack 按钮；
- digest flush 手动触发按钮（只对当前 group）。

### 12.3 Feishu / Runner Chat

Feishu 普通消息：走 intent/outbox。

Feishu direct fallback：只由 watchdog 使用，必须是最小文本，不发复杂卡片，不依赖 PI 生成内容；它是 best-effort，不承诺覆盖 Feishu 平台/token/API/network 故障。

Runner Chat：共享 notification coordinator 和 preference resolver，不做 Feishu-only 分叉。

---

## 13. 现有代码落点

预期新增/修改模块：

```text
backend-ts/src/db/schema/028_pi_guardian_runtime.ts
backend-ts/src/db/schema/index.ts
backend-ts/src/db/repositories/pi/guardianEvents.ts
backend-ts/src/db/repositories/pi/runGroups.ts
backend-ts/src/db/repositories/pi/notificationIntents.ts
backend-ts/src/db/repositories/pi/notificationPreferences.ts
backend-ts/src/db/repositories/pi/guardianDecisions.ts
backend-ts/src/db/repositories/pi/recoveryAttempts.ts
backend-ts/src/db/repositories/pi/guardianAlerts.ts
backend-ts/src/db/repositories/pi/watchdogStatus.ts

backend-ts/src/pi/guardianRedaction.ts
backend-ts/src/pi/guardianEventIngest.ts
backend-ts/src/pi/runGroupService.ts
backend-ts/src/pi/notificationCoordinator.ts
backend-ts/src/pi/digestFlushScheduler.ts
backend-ts/src/pi/approvalFastPolicy.ts
backend-ts/src/pi/safetyPolicy.ts
backend-ts/src/pi/guardianDecisionOrchestrator.ts
backend-ts/src/pi/recoveryBudget.ts
backend-ts/src/pi/guardianFailureClassifier.ts
backend-ts/src/pi/guardianWatchdog.ts

backend-ts/src/integrations/feishuNotifications.ts
backend-ts/src/pi/runnerNextTriageActions.ts
backend-ts/src/runner/piAutoManageScheduler.ts
backend-ts/src/pi/heartbeatOrchestrator.ts
backend-ts/src/runner/piIssueSupervisorScheduler.ts
backend-ts/src/http/server.ts
```

关键改造：

- `feishuNotifications.ts`：从“直接 queue draft”改为“queue notification intent”；approval fast-path 只做内存决策与 resolver，audit/request 写入异步补偿。
- `runnerNextTriageActions.ts`：batch enqueue 创建 run group 和 group items。
- `piAutoManageScheduler.ts`：schedule cycle 进入 orchestrator，heartbeat/supervisor 只产 signal/candidate。
- `providerApprovalRequests.ts` / approval resolver：接入不依赖同步 DB 写的 fast decision，audit 异步补写。
- `redact.ts`：升级或新增 guardian redaction profile，不要破坏现有轻量调用。

---

## 14. 端到端时序

### 14.1 批量启动与 digest

```text
User: “把剩下 10 个 issue 都做完，我睡觉了”
  -> PI calls issue_enqueue_batch_triage
  -> RunGroupService creates group expected=10 deadline=tomorrow 08:00
  -> enqueue actions per issue, keep per-issue audit
  -> enqueue failed/skipped items immediately become reportable
  -> lifecycle start events -> intents aggregate/suppress
  -> done/failed/pending events -> intents aggregate
  -> DigestFlushScheduler:
       if all reportable -> send completed digest (flush_reason=completed)
       else if deadline/max_interval -> send partial digest (flush_reason=partial_deadline/partial_interval)
  -> user sees one summary, not 20 lifecycle messages
```

### 14.2 Approval unknown

```text
Codex -> approval/requested(command unknown)
  -> parse/redact/evaluate in memory, no synchronous DB write
  -> safety deny-list no hit
  -> allow-list no hit / parse ambiguous
  -> resolveApproval(decline) within fast path
  -> async audit writes pi_approval_requests + decision gray_denied_now
  -> async notification intent or PI explanation outside RPC
  -> optional session resume asks user for narrower authorization
```

### 14.3 Transient recovery

```text
provider EOF / stream disconnect
  -> guardian inbox signal with sequence_id; no-id duplicates use time bucket/at-least-once
  -> deterministic diagnosis_code classifies transient
  -> orchestrator merge window groups duplicate signals
  -> budget check from pi_recovery_attempts
  -> PI or deterministic decision: session.resume_followup
  -> action gate checks session/run state
  -> create recovery attempt executing before provider call
  -> execute resume with provider_turn_id idempotency anchor
  -> after stale window, progress tracker updates attempt progress/no_progress
  -> budget exhausted -> digest/escalate user
```

### 14.4 PI unavailable

```text
PI runtime down / coordinator lag / outbox stuck
  -> watchdog detects without PI runtime
  -> write pi_guardian_alerts(open)
  -> Runner UI shows banner
  -> direct Feishu minimal text attempt best-effort
  -> no notification_intent/outbox dependency; Feishu platform failure only records retry
  -> PI recovers -> missed intents digest
```

---

## 15. 测试矩阵

### 15.1 Schema/repository

- migrations create all guardian tables and indexes;
- migration repair can add missing columns on old DB;
- run group create/list/update preserves expected count and item membership;
- notification intent idempotency prevents duplicate lifecycle rows;
- same run group partial digest and later completed digest each insert one row;
- recovery budget queries ignore `issues.attempt_count`;
- guardian alerts and watchdog status are readable without coordinator/outbox;
- `pi_guardian_event_inbox.sequence_id` is monotonic and usable as preference anchor.

### 15.2 Notification/run group

- batch enqueue 10 issues creates one run group with 10 items;
- start/done lifecycle creates intents, not immediate Feishu drafts;
- all items done triggers one completed digest;
- one item stuck still flushes partial digest on deadline/max interval;
- after a partial digest, later completion triggers a separate completed digest;
- enqueue failed/skipped/pending_approval item is reportable and does not keep group active forever;
- reportable status set and digest buckets align for `needs_user` / `budget_exhausted` / enqueue failures;
- preference quiet suppresses info but not urgent/needs_user;
- conversation temporary preference overrides project default, except explicit `admin_enforced` policy;
- preference TTL expiry restores normal behavior;
- old event with `sequence_id <= effective_after_sequence` uses old preference; new event uses new preference;
- legacy issue without run_group still routes per-issue preference without dropped notification.

### 15.3 Approval

- low-risk read in current repo approve-now and audit latency;
- high-risk `sudo` deny-now;
- gray command deny-now, does not wait for PI;
- exact allow-list approval resolves before/ahead of async DB audit write;
- simulated SQLite write lock/audit failure does not convert exact low-risk approval into deny;
- policy cache unavailable becomes unknown deny-now, with async explanation;
- provider resolver failure marks request visible for retry;
- `approve for session` disabled when provider scope semantics are opaque;
- prompt injection text inside issue body cannot alter deny-list result.

### 15.4 Redaction

- PI prompt context redacts absolute paths/token/private key markers;
- digest redacts local paths, stack-like lines, long logs;
- watchdog alert redacts secret lines;
- approval summary redacts command/path where needed;
- DB payload for intents does not duplicate raw secret payload.

### 15.5 Orchestrator/backpressure

- duplicate event with same idempotency key produces one decision;
- same issue same diagnosis within cooldown does not produce duplicate action;
- high volume info events merge into one PI decision/digest;
- PI rate limit defers watch/info but urgent bypasses;
- severity upgrade inside merge window breaks the window and emits actionable/urgent path immediately;
- heartbeat and supervisor candidate for same issue/action result in one executed action;
- provider failure without upstream id is not lost when repeated with identical payload across time buckets.

### 15.6 Recovery

- recovery attempt row created as `executing` before provider action execution;
- process crash after resume provider call but before result write does not send duplicate resume when `provider_turn_id` advanced;
- existing executing resume attempt under hard timeout suppresses duplicate provider call;
- progress detected updates attempt to `progress`;
- keepalive/token usage/repeated error do not count as progress;
- deterministic `diagnosis_code` decides transient vs needs_context; PI cannot downgrade needs_context;
- issue budget exhausts after 3 attempts/24h from `pi_recovery_attempts`;
- session resume budget exhausts after 2 resumes/24h;
- `issue.state_repair` aborts if precondition state changed.

### 15.7 Watchdog

- PI runtime down writes `pi_guardian_alerts` even when coordinator disabled;
- outbox stuck does not call notification intent path;
- direct Feishu failure records retry without losing UI alert;
- Feishu platform/token/API failure still leaves Runner UI alert visible and truthfully marked fallback failed;
- watchdog liveness stale state appears in Runner UI/system status;
- urgent ack retry uses backoff and max retry count, especially during quiet period;
- alert ack updates status;
- PI recovery can generate missed-intents summary.

---

## 16. 非目标

- 不保证所有 issue 无人值守都能成功；只自动处理低风险和可恢复问题。
- 不让 PI 或任何 LLM 自动批准危险操作。
- 不把 Feishu 做成唯一入口；Runner Chat/UI 共享同一 coordinator。
- 不删除 per-issue audit；只是减少用户可见噪音。
- 不用 `attempt_count` 代表恢复次数。
- 不让 watchdog 走普通 notification pipeline。

---

## 17. 开发前硬验收清单

任何实现 PR/issue 在进入下一层前必须能回答：

- [ ] run group schema 是否包含 `expected_issue_count`、成员归属、deadline、digest interval？
- [ ] 普通生命周期通知是否已经 intent 化，而不是直接 draft/outbox？
- [ ] digest 是否有 complete、max interval、deadline 三种触发，且 partial/completed digest 唯一键不会互相折叠？
- [ ] enqueue failed/skipped/pending approval item 是否在落库时就能进入 reportable，避免 group 永远 active？
- [ ] preference 竞态是否使用 `sequence_id/effective_after_sequence`，而不是 UUID/event id？
- [ ] conversation 临时偏好与 project 默认偏好优先级是否清晰；admin_enforced 是否单独标识？
- [ ] approval unknown 是否 deny-now，并且没有等待 PI 的代码路径？
- [ ] approval fast-path 是否在 resolver 前不依赖同步 DB 写成功，SQLite 写锁不会制造伪拒绝？
- [ ] prompt/user message/watchdog alert 是否都经过 deterministic redaction pre-filter？
- [ ] transient/needs_context 是否由 deterministic `diagnosis_code` 初判，PI 不能降级？
- [ ] decision 层是否有 idempotency、lease、merge window、rate limit，且 severity 升级能破窗？
- [ ] 无 upstream id 的 provider failure 是否不会被纯 payload-hash 去重漏数？
- [ ] recovery budget 是否只从 `pi_recovery_attempts` rolling window 计算？
- [ ] `session.resume_followup` 是否用 `provider_turn_id`/executing attempt 防 crash 后重复 resume？
- [ ] `issue.state_repair` 是否有 state precondition 和 before/after snapshot？
- [ ] watchdog 是否可以在 notification coordinator/outbox 挂掉时仍写 UI alert？
- [ ] watchdog 是否明确不承诺覆盖 Feishu 平台故障，UI alert 是主带外通道？
- [ ] watchdog 自身 liveness 是否可由 UI/system status 直接看见？
- [ ] urgent escalation 是否有 ack 状态、退避与最大重试次数？
- [ ] 迁移期无 run_group 的 legacy issue 是否仍按 per-issue 偏好路由？

### 17.1 二轮评审闭环确认

| Review item | 设计落点 |
| --- | --- |
| N1 digest partial/completed 被唯一键折叠 | §3.5 `flush_reason/flush_sequence/flush_bucket` 入 digest key；§5.3 partial 后 completed 仍单独落 intent |
| N2 enqueue failed/skipped 卡 active | §3.3 `report_status/report_bucket`；§4.4 完成判定同时读取 `enqueue_status` |
| N3 `effective_after_event_id` 不可比 | §3.1 `sequence_id`；§3.4/§6.3 `effective_after_sequence` |
| N4 project 压 conversation 顺序可疑 | §3.4 改为 run_group > conversation > project default；`admin_enforced` 单独说明 |
| N5 resume 持锁崩溃非幂等 | §3.7/§10.4 用 `provider_turn_id`、executing attempt、hard timeout 去重 |
| N6 watchdog 不覆盖 Feishu 平台挂 | §11.2 明确 UI alert 是主带外；direct Feishu best-effort |
| N7 payload-hash 去重漏数 | §3.1 无 upstream id 的 provider failure 加时间桶或 at-least-once |
| N8 transient/needs_context 权威不明 | §5.2 deterministic `diagnosis_code` 初判，PI 不可降级 |
| N9 approval 同步 DB 写拖慢 fast-path | §7.2 resolver 前不等 DB 写，audit 异步补偿 |
| 次要：watchdog liveness / quiet urgent retry / legacy issue / reportable buckets / severity 破窗 | §3.8/§11.1、§5.5、§4.5、§3.3/§4.5、§9.2 |

---

## 18. 最终成功标准

用户说：

> “把剩下的 issue 都做完，我睡觉了。”

系统表现：

- 创建 run group，知道“这一批”包含哪些 issue 和 expected count；
- 普通 start/done/progress 不刷屏；
- 所有 suppressed/aggregated 通知都有 intent/audit，不会静默丢失；
- 到 batch complete、max interval 或 deadline，一定发 digest；partial 后 completed 仍会补完成摘要；
- enqueue 失败/跳过也进入摘要，不会让 group 卡 active；
- 低风险 approval 在同步预算内处理，unknown/high-risk deny-now 并异步升级；SQLite 写锁不会拖垮 fast-path；
- transient failure/no progress 先按 deterministic diagnosis 和预算自恢复；
- 恢复预算耗尽、危险操作、业务信息缺失才找用户；
- PI/coordinator/outbox 挂掉时，watchdog 仍能在 Runner UI 告警；direct Feishu 只是 best-effort；
- 第二天用户看到一条清晰总结：完成了什么、失败/待验证什么、PI 尝试过什么、现在需要用户做什么。
