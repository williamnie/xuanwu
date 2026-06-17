# 2026-06-17 PI Guardian 完整技术设计：通知决策、授权托管与 Issue 管家

> 状态：完整技术设计，非实现记录。
> 日期：2026-06-17。
> 范围：`codex-issue-runner` 中 PI 对 issue/session/notification/approval/recovery/watchdog 的托管能力。
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

---

## 1. 当前实现事实与问题映射

当前代码事实：

- `backend-ts/src/providers/codex/jsonRpc.ts`：Codex JSON-RPC request 超时硬上限 10s，超时 reject 并 restart transport。
- `backend-ts/src/providers/codex/approvalBroker.ts`：approval request 是 pending promise，必须 resolve/reject 才能继续。
- `backend-ts/src/integrations/feishuNotifications.ts`：`issue.status_changed` / `issue.created` / `approval/requested` 仍直接生成 Feishu draft/outbox，只有 Runner Chat start 做了局部 suppress。
- `backend-ts/src/runner/piAutoManageScheduler.ts`：同一 schedule cycle 内会跑 LLM supervisor、cron、delegation heartbeat、auto manage cycle，当前没有统一仲裁层。
- `backend-ts/src/db/schema/001_base_schema.ts`：`issues` 没有 batch/run-group 字段；`attempt_count` 是 claim 次数，不是恢复次数。
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

```sql
create table if not exists pi_guardian_event_inbox (
  id text primary key,
  source text not null default '',              -- event_bus | issue_events | provider | scheduler
  source_event_id text not null default '',     -- bus:<id> / issue_event:<id> / provider:<hash>
  source_sequence integer not null default 0,
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

create unique index if not exists ux_pi_guardian_event_source
  on pi_guardian_event_inbox(source, source_event_id, idempotency_key);

create index if not exists idx_pi_guardian_event_pending
  on pi_guardian_event_inbox(status, severity, created_at);

create index if not exists idx_pi_guardian_event_issue
  on pi_guardian_event_inbox(project_id, issue_id, created_at desc);

create index if not exists idx_pi_guardian_event_group
  on pi_guardian_event_inbox(run_group_id, created_at desc);
```

`idempotency_key` 规则：

```text
${event_type}:${project_id}:${issue_id || run_group_id || conversation_id}:${source_event_id || source_sequence}
```

如果 upstream 没有 id，使用 normalized payload hash，但 hash 前必须先 redaction/normalization，避免 secret 进入 key material。

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
  user_phrase text not null default '',
  expected_issue_count integer not null default 0,
  status text not null default 'active',        -- active | completed | partial | cancelled | expired
  digest_policy_json text not null default '{}',
  deadline_at text not null default '',
  max_interval_minutes integer not null default 120,
  last_digest_at text not null default '',
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
  enqueue_status text not null default 'pending', -- pending | completed | skipped | failed
  status text not null default 'active',          -- active | reportable | removed
  final_issue_status text not null default '',    -- done | failed | pending_verification | blocked | cancelled | skipped
  last_intent_id text not null default '',
  joined_at text not null,
  completed_at text not null default '',
  updated_at text not null,
  primary key (run_group_id, issue_id),
  foreign key(run_group_id) references pi_run_groups(id) on delete cascade,
  foreign key(issue_id) references issues(id) on delete cascade
);

create index if not exists idx_pi_run_group_items_issue
  on pi_run_group_items(issue_id, run_group_id);

create index if not exists idx_pi_run_group_items_status
  on pi_run_group_items(run_group_id, status, final_issue_status);
```

Reportable terminal 状态：

```text
done | failed | pending_verification | blocked | cancelled | skipped | needs_user | budget_exhausted
```

`todo` / `in_progress` / `triage` 不算完成。

### 3.4 `pi_notification_preferences`

用途：把“别逐条通知 / 睡觉了明天再说 / 只失败找我”落成可查询状态。

```sql
create table if not exists pi_notification_preferences (
  id text primary key,
  project_id text not null default '',
  conversation_id text not null default '',
  run_group_id text not null default '',
  scope text not null,                          -- run_group | conversation | project | global
  mode text not null default 'normal',          -- quiet | digest | normal | verbose
  notify_on_json text not null default '[]',
  digest_policy_json text not null default '{}',
  source_message_id text not null default '',
  source_event_id text not null default '',
  confirmation_text text not null default '',
  effective_after_event_id text not null default '',
  version integer not null default 1,
  status text not null default 'active',         -- active | expired | superseded | disabled
  expires_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_notification_preferences_scope
  on pi_notification_preferences(scope, project_id, conversation_id, run_group_id, status, version desc);

create index if not exists idx_pi_notification_preferences_expiry
  on pi_notification_preferences(status, expires_at);
```

Preference 解析顺序：

```text
run_group explicit preference
  > project explicit preference
  > origin conversation preference
  > global/user default
  > system default
```

Quiet 不能压制以下 severity：

```text
urgent | pi_unavailable | needs_user | budget_exhausted | unsafe_or_external
```

临时偏好必须有 `expires_at`。如果 NL 解析无法确定过期时间，不能写永久 quiet，只能回问或写成短 TTL（例如 8h）并在确认文本中说明。

### 3.5 `pi_notification_intents`

用途：所有普通用户可见输出先落 intent，再由 coordinator/digest/outbox 处理。

```sql
create table if not exists pi_notification_intents (
  id text primary key,
  source_event_id text not null default '',
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
  flush_after_at text not null default '',
  ready_at text not null default '',
  sent_outbox_id integer not null default 0,
  sent_at text not null default '',
  ack_required integer not null default 0,
  ack_status text not null default '',             -- pending | acked | expired | not_required
  ack_deadline_at text not null default '',
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
${kind}:${project_id}:${issue_id}:${run_group_id}:${source_event_id}:${target_channel}
```

### 3.6 `pi_guardian_decisions`

用途：记录 deterministic policy 或 PI decision turn 的判断。所有会触发写动作的判断都要有 decision row。

```sql
create table if not exists pi_guardian_decisions (
  id text primary key,
  idempotency_key text not null,
  source_event_id text not null default '',
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

用途：自动恢复预算 source of truth。不要用 `issues.attempt_count`。

```sql
create table if not exists pi_recovery_attempts (
  id text primary key,
  source_decision_id text not null default '',
  project_id text not null default '',
  issue_id integer not null,
  run_id text not null default '',
  session_id text not null default '',
  provider_turn_id text not null default '',
  run_group_id text not null default '',
  diagnosis_code text not null,
  action_type text not null,                     -- session.resume_followup | issue.retry | issue.retry_after | runner.kick_project_loop | issue.state_repair
  status text not null default 'planned',         -- planned | executing | progress | no_progress | failed | cancelled
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
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_guardian_alerts_open
  on pi_guardian_alerts(status, severity, created_at desc);

create index if not exists idx_pi_guardian_alerts_project
  on pi_guardian_alerts(project_id, status, created_at desc);
```

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
       update item.enqueue_status completed/pending/failed/skipped
  -> PI final reply says “已加入这一批”，不是逐 issue lifecycle 通知
```

### 4.3 状态刷新

Run group item 状态不作为 issue 权威状态；它是报告视图。刷新来源：

- lifecycle event 到达时更新对应 item `final_issue_status` / `completed_at`；
- digest flush 前实时读取 `issues.status`，修正 item report view；
- enqueue action pending/failed 也作为 item reportable 状态，防止 expected-count 永远等不到。

### 4.4 完成判定

```text
all_items_reportable = every item has final_issue_status in reportable terminal states
if all_items_reportable:
  group.status = completed
  completed_at = now
else if deadline/max_interval reached:
  group.status = partial
  keep active for later follow-up digest
else:
  group.status = active
```

### 4.5 Digest 依赖 run group

Digest 查询以 run group 为主：

```text
completed_count = done
verification_count = pending_verification
failed_count = failed | blocked | budget_exhausted
active_count = todo | in_progress | triage
skipped_count = skipped | enqueue failed/pending approval
```

摘要必须包含：

- 总数 / 完成 / 待验证 / 失败 / 仍在跑 / 跳过；
- failed/needs_user 的 issue id + redacted one-line reason；
- PI 已做过的恢复动作和预算剩余；
- 下一步：继续等 / 需要用户 / 已暂停。

---

## 5. Notification intent 与 digest 技术设计

### 5.1 Lifecycle event 到 intent

```text
issue.status_changed / issue.created
  -> PiGuardianEventIngest writes inbox
  -> NotificationCoordinator.normalize(event)
  -> resolve run_group membership by issue_id
  -> resolve preference by run_group/project/conversation
  -> classify severity/kind
  -> write pi_notification_intents(idempotent)
  -> if send_now/escalate: mark ready
  -> if aggregate: wait for DigestFlushScheduler
  -> if suppress: mark suppressed but keep audit row
```

### 5.2 Severity mapping

| Event | Default kind | Default severity | Default decision |
| --- | --- | --- | --- |
| issue created | issue_created | info | suppress if run_group else send_now/aggregate by preference |
| issue todo/in_progress | issue_start | info | aggregate/suppress for run_group |
| issue done | issue_done | info | aggregate for run_group |
| issue pending_verification | issue_pending_verification | watch | aggregate unless user verification required |
| issue failed transient | issue_failed | watch | send to supervisor/recovery, aggregate |
| issue failed needs_context | issue_failed | actionable | escalate_user |
| budget exhausted | budget_exhausted | actionable | escalate_user |
| unsafe/external | unsafe_or_external | urgent | send_now + ack |
| PI unavailable | pi_unavailable | urgent | watchdog, not normal intent |

### 5.3 Digest flush 触发器

`DigestFlushScheduler` 每 30-60s 扫描：

1. `run_group.completed_at` 刚产生且 `last_digest_at < completed_at`。
2. `now - last_digest_at >= max_interval_minutes`，且 group 有未 flush intents。
3. `deadline_at <= now`。
4. urgent/actionable intent 到达且 preference 未允许静默。
5. PI 恢复后发现 missed intents。

Flush 后：

- 生成 digest intent 或直接创建 `im_reply_drafts` / `sync_outbox`；
- 更新 group `last_digest_at`；
- 将被包含的 intents 标记 `aggregated` 或 `sent`；
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
- Ack deadline 到期后：重复提醒、Runner UI banner、备用通道，具体策略由 `ack_policy_json` 扩展。

---

## 6. Preference 技术设计

### 6.1 NL preference 落库流程

```text
User: “我睡觉了，明天再汇报”
  -> PI parses candidate preference
  -> deterministic validator checks scope/mode/expires_at
  -> if temporary phrase and no expires_at: ask clarification or set bounded default TTL
  -> write pi_notification_preferences(version+1)
  -> reply confirmation after DB write succeeds
  -> coordinator applies preference only to events after effective_after_event_id
```

### 6.2 Confirmation 文案约束

确认文案必须明确：

- scope：这个 run group / project / conversation；
- mode：quiet/digest/normal/verbose；
- notify_on：哪些情况仍会打扰；
- expires_at：什么时候恢复；
- 覆盖关系：是否覆盖项目级偏好。

示例：

```text
已切到本批次安静模式，到明天 08:00 自动恢复 normal。期间普通 start/done 会进汇总；只有需要你、预算耗尽、危险授权或 PI 不可用时才会通知。
```

### 6.3 竞态处理

- preference row 写入成功后才回复用户；
- `effective_after_event_id` = 写入时看到的最新 inbox/source event；
- coordinator 对旧事件按旧偏好处理，对新事件按新版本处理；
- 如果旧事件已经进 outbox，不强撤；后续 digest 需要说明“偏好从 X 时刻生效”。

---

## 7. Approval fast-path 技术设计

### 7.1 目标

在 Codex approval 同步 RPC 的 10s 上限内完成本次 request 决策，内部目标 latency < 100ms。

### 7.2 决策流

```text
approval/requested
  -> parse/normalize request
  -> upsert pi_approval_requests(status=pending)
  -> PiGuardianRedaction.redactApprovalSummary
  -> PiSafetyPolicy.evaluateDenyList
     - deny-list hit: decline-now + audit + async escalation if useful
  -> PiApprovalFastPolicy.evaluateAllowList
     - exact low-risk scope hit: approve-now once
     - exact narrow session grant hit: approve-for-session only if provider scope semantics are proven narrow
     - no exact hit / parse failed / ambiguous: deny-now
  -> resolveApproval(decision)
  -> update pi_approval_requests fast decision + pi_guardian_decisions
  -> if denied/ambiguous: enqueue async explanation/escalation outside RPC
```

### 7.3 灰色地带规则

灰色地带定义：

- deny-list 没命中；
- allow-list 也没精确命中；
- command/path 解析失败；
- request scope 不含当前 project/issue/workspace；
- provider permission object 语义不清；
- PI/coordinator 当前不可用；
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
5. audit 写明 rule 与 scope。

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
- JSON raw payload 中 key 包含 token/secret/password/key/credential。

### 8.3 接入点

必须在以下位置调用 redaction：

1. `PiGuardianEventIngest` 写 inbox 前。
2. `IssueSupervisorContextBuilder` 构造 PI prompt 前。
3. `NotificationCoordinator` 写 intent summary/payload 前。
4. `DigestFlushScheduler` 生成 digest 前后。
5. `ApprovalFastPolicy` 写 approval summary/audit 前。
6. `PiGuardianWatchdog` 写 alert / direct Feishu fallback 前。
7. 所有最终 `im_reply_drafts.content` 前。

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

### 10.4 `issue.state_repair`

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

`PiGuardianWatchdog` 独立于 PI runtime，定时检查：

- PI runtime 连续失败；
- decision orchestrator 队列 lag 超阈值；
- notification coordinator 未消费 intents；
- digest flush overdue；
- sync_outbox 连续失败；
- approval fast-path resolver error/latency 异常；
- scheduler heartbeat 停止；
- guardian event inbox pending 数持续增长。

### 11.2 带外告警通道

Watchdog fallback 顺序：

1. 写 `pi_guardian_alerts(status=open, ui_visible=1)`；
2. Runner UI / system status API 直接读取 alerts；
3. 尝试 direct Feishu minimal text sender；
4. direct Feishu 失败则记录 `direct_feishu_state=retry` 和 `next_retry_at`；
5. PI 恢复后补扫 missed intents / alerts，生成补充摘要。

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
- issue/run group 页面展示：group 总数、完成、失败、待验证、仍在跑；
- notification preference 状态：当前 mode、expires_at、notify_on；
- alert ack 按钮；
- digest flush 手动触发按钮（只对当前 group）。

### 12.3 Feishu / Runner Chat

Feishu 普通消息：走 intent/outbox。

Feishu direct fallback：只由 watchdog 使用，必须是最小文本，不发复杂卡片，不依赖 PI 生成内容。

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

backend-ts/src/pi/guardianRedaction.ts
backend-ts/src/pi/guardianEventIngest.ts
backend-ts/src/pi/runGroupService.ts
backend-ts/src/pi/notificationCoordinator.ts
backend-ts/src/pi/digestFlushScheduler.ts
backend-ts/src/pi/approvalFastPolicy.ts
backend-ts/src/pi/safetyPolicy.ts
backend-ts/src/pi/guardianDecisionOrchestrator.ts
backend-ts/src/pi/recoveryBudget.ts
backend-ts/src/pi/guardianWatchdog.ts

backend-ts/src/integrations/feishuNotifications.ts
backend-ts/src/pi/runnerNextTriageActions.ts
backend-ts/src/runner/piAutoManageScheduler.ts
backend-ts/src/pi/heartbeatOrchestrator.ts
backend-ts/src/runner/piIssueSupervisorScheduler.ts
backend-ts/src/http/server.ts
```

关键改造：

- `feishuNotifications.ts`：从“直接 queue draft”改为“queue notification intent”；approval fast-path 仍先记录 request。
- `runnerNextTriageActions.ts`：batch enqueue 创建 run group 和 group items。
- `piAutoManageScheduler.ts`：schedule cycle 进入 orchestrator，heartbeat/supervisor 只产 signal/candidate。
- `providerApprovalRequests.ts` / approval resolver：接入 fast decision audit。
- `redact.ts`：升级或新增 guardian redaction profile，不要破坏现有轻量调用。

---

## 14. 端到端时序

### 14.1 批量启动与 digest

```text
User: “把剩下 10 个 issue 都做完，我睡觉了”
  -> PI calls issue_enqueue_batch_triage
  -> RunGroupService creates group expected=10 deadline=tomorrow 08:00
  -> enqueue actions per issue, keep per-issue audit
  -> lifecycle start events -> intents aggregate/suppress
  -> done/failed/pending events -> intents aggregate
  -> DigestFlushScheduler:
       if all reportable -> send completed digest
       else if deadline/max_interval -> send partial digest
  -> user sees one summary, not 20 lifecycle messages
```

### 14.2 Approval unknown

```text
Codex -> approval/requested(command unknown)
  -> record pi_approval_requests
  -> safety deny-list no hit
  -> allow-list no hit / parse ambiguous
  -> resolveApproval(decline) within fast path
  -> write decision gray_denied_now
  -> async notification intent or PI explanation outside RPC
  -> optional session resume asks user for narrower authorization
```

### 14.3 Transient recovery

```text
provider EOF / stream disconnect
  -> guardian inbox signal
  -> orchestrator merge window groups duplicate signals
  -> budget check from pi_recovery_attempts
  -> PI or deterministic decision: session.resume_followup
  -> action gate checks session/run state
  -> create recovery attempt before snapshot
  -> execute resume
  -> after stale window, progress tracker updates attempt progress/no_progress
  -> budget exhausted -> digest/escalate user
```

### 14.4 PI unavailable

```text
PI runtime down / coordinator lag / outbox stuck
  -> watchdog detects without PI runtime
  -> write pi_guardian_alerts(open)
  -> Runner UI shows banner
  -> direct Feishu minimal text attempt
  -> no notification_intent/outbox dependency
  -> PI recovers -> missed intents digest
```

---

## 15. 测试矩阵

### 15.1 Schema/repository

- migrations create all guardian tables and indexes;
- migration repair can add missing columns on old DB;
- run group create/list/update preserves expected count and item membership;
- notification intent idempotency prevents duplicate rows;
- recovery budget queries ignore `issues.attempt_count`;
- guardian alerts are readable without coordinator/outbox.

### 15.2 Notification/run group

- batch enqueue 10 issues creates one run group with 10 items;
- start/done lifecycle creates intents, not immediate Feishu drafts;
- all items done triggers one digest;
- one item stuck still flushes partial digest on deadline/max interval;
- preference quiet suppresses info but not urgent/needs_user;
- preference TTL expiry restores normal behavior;
- old event before `effective_after_event_id` uses old preference.

### 15.3 Approval

- low-risk read in current repo approve-now and audit latency;
- high-risk `sudo` deny-now;
- gray command deny-now, does not wait for PI;
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
- heartbeat and supervisor candidate for same issue/action result in one executed action.

### 15.6 Recovery

- recovery attempt row created before action execution;
- progress detected updates attempt to `progress`;
- keepalive/token usage/repeated error do not count as progress;
- issue budget exhausts after 3 attempts/24h from `pi_recovery_attempts`;
- session resume budget exhausts after 2 resumes/24h;
- `issue.state_repair` aborts if precondition state changed.

### 15.7 Watchdog

- PI runtime down writes `pi_guardian_alerts` even when coordinator disabled;
- outbox stuck does not call notification intent path;
- direct Feishu failure records retry without losing UI alert;
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
- [ ] digest 是否有 complete、max interval、deadline 三种触发？
- [ ] approval unknown 是否 deny-now，并且没有等待 PI 的代码路径？
- [ ] prompt/user message/watchdog alert 是否都经过 deterministic redaction pre-filter？
- [ ] decision 层是否有 idempotency、lease、merge window、rate limit？
- [ ] recovery budget 是否只从 `pi_recovery_attempts` rolling window 计算？
- [ ] `issue.state_repair` 是否有 state precondition 和 before/after snapshot？
- [ ] watchdog 是否可以在 notification coordinator/outbox 挂掉时仍写 UI alert？
- [ ] urgent escalation 是否有 ack 状态或至少未 ack 记录？

---

## 18. 最终成功标准

用户说：

> “把剩下的 issue 都做完，我睡觉了。”

系统表现：

- 创建 run group，知道“这一批”包含哪些 issue 和 expected count；
- 普通 start/done/progress 不刷屏；
- 所有 suppressed/aggregated 通知都有 intent/audit，不会静默丢失；
- 到 batch complete、max interval 或 deadline，一定发 digest；
- 低风险 approval 在同步预算内处理，unknown/high-risk deny-now 并异步升级；
- transient failure/no progress 先按预算自恢复；
- 恢复预算耗尽、危险操作、业务信息缺失才找用户；
- PI/coordinator/outbox 挂掉时，watchdog 仍能在 Runner UI 告警并尝试带外 Feishu；
- 第二天用户看到一条清晰总结：完成了什么、失败/待验证什么、PI 尝试过什么、现在需要用户做什么。
