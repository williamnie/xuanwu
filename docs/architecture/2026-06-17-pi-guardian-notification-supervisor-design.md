# 2026-06-17 PI Guardian：通知决策、授权托管与 Issue 管家设计

> 状态：后续架构设计，非实现记录。
> 日期：2026-06-17
> 范围：`codex-issue-runner` 中 PI 对 issue/session/notification/approval 的托管能力。
> 背景：用户批量启动 issue 后，系统逐条发送 start/done 生命周期通知；PI 虽然在对话里承诺“不逐个通知”，但底层 observer 仍继续机械推送。这暴露出用户可见通知绕过 PI、PI 不能实际接管 issue 执行过程的问题。
> 评审更新：已吸收 `2026-06-17-pi-guardian-design-review.md` 中对 approval 同步预算、LLM 安全边界、split-brain、run group/digest、PI fallback 的修正意见。

## 1. 设计结论

PI 的定位应从“聊天入口 + issue loop 触发器”升级为：

> **辅助工程师、Issue 管家、夜间值守工程师、Codex session supervisor。**

因此，面向用户的通知不应由底层生命周期 observer 直接格式化发送；底层系统只产生结构化事件，PI 负责判断：

- 这件事是否需要现在打扰用户；
- 是否应该合并成批量摘要；
- 是否可以由 PI 直接处理；
- 是否需要人工业务决策或高风险授权；
- 发送到 Feishu / Runner Chat 时应该怎么表达。

核心原则：

1. **Audit event 和 user notification 分离**：每个 issue 的状态变化都要完整记录，但不等于每条都通知用户。
2. **先自治，后打扰**：授权先过确定性 fast policy；失败、阻塞、长时间无进展默认先交给 PI 诊断和处理。
3. **危险或不确定才升级用户**：只有确定性 policy 或 PI 判断需要人工决策、高风险权限、自动恢复预算耗尽，或 PI 自己不可用时，才直接通知用户。
4. **用户偏好必须影响系统行为**：用户说“不用每个都通知”后，不能只让 PI 口头承诺；必须写入通知策略并影响后续 lifecycle。

## 2. 当前问题

现有链路大致是：

```text
issue.status_changed / issue.created / approval/requested
  -> feishuNotifications observer
  -> formatIssueStatusNotification / formatApprovalNotification
  -> notification draft
  -> Feishu outbox
```

这个链路的问题：

- 它把“系统状态变化”直接变成“用户消息”；
- 它绕过 PI agent，PI 无法判断发不发；
- 它不了解当前会话语境，例如用户已经说过“后续不用每个都通知”；
- 它不会先尝试恢复 session、retry issue、kick runner loop；
- 它让 PI 像播报机器人，而不是工程师助理。

之前对 batch start 的修复只是局部 suppress：Runner Chat 自动 enqueue 的 `todo/in_progress` 启动通知不再逐条发。但 `done`、`failed`、`pending_verification`、approval、stale session 等仍需要统一进入 PI 托管层。

## 3. 目标架构

新增一层 `PiGuardian`，可拆成两个协作模块：

- `PiIssueSupervisor`：负责诊断、恢复、重试、续聊、kick runner、状态修复。
- `PiNotificationCoordinator`：负责通知策略、聚合、静默、摘要、升级用户。

目标链路：

```text
Runner / Issue Loop / Codex Provider / Feishu Chat
  -> structured events
  -> PiGuardian event inbox (sequenced, idempotent)
  -> deterministic safety/admission policy (ms 级、LLM 不可覆盖)
  -> acquire decision lease + read preference/run-group state
  -> PI decision turn（仅用于非阻塞、可等待的工程判断）
  -> action gate（state precondition + idempotency key）
  -> actions:
       - deterministic auto approve / deny low-risk approval
       - resume / steer session
       - retry issue / retry after cooldown
       - kick runner loop
       - issue.state_repair for inconsistent state
       - aggregate notification / flush digest
       - escalate to user
  -> audit log + optional user-facing IM reply
```

Feishu / Runner Chat outbox 只负责发送 PI 最终决定好的消息，不再承担业务判断。

### 3.1 职责、仲裁与时序硬约束

评审结论基本成立：当前实现里 approval 是同步 RPC（10s 上限），schedule layer 同一轮会先跑 LLM supervisor、再跑 deterministic heartbeat；因此 PiGuardian 落地前必须先补齐职责边界，不能把“PI 会判断”当成安全或时序保证。

| 场景 | 决策者 | 硬约束 |
| --- | --- | --- |
| `approval/requested` 阻塞 RPC | `PiApprovalFastPolicy` 确定性规则 | 必须在毫秒级返回；禁止等待 PI decision turn；无法确定时 deny/decline 本次请求并异步升级/恢复 |
| 安全边界 | `PiSafetyPolicy` deny-list + scope allow-list | 在任何 LLM prompt 之前执行，LLM 无权放宽 `sudo`、凭证、跨 repo、破坏性 git、生产/付费资源等规则 |
| issue/session 恢复 | `PiGuardianDecisionOrchestrator` | 同一 `source_event_id`/`issue_id` 先拿 lease；heartbeat 只能产信号，执行动作必须走同一 action gate |
| 通知聚合 | `PiNotificationCoordinator` | 不能只 suppress；必须持久化 intent/digest item，并由独立 flush 调度兜底发送 |
| PI 不可用 | `PiGuardianWatchdog` | 不依赖 PI runtime；至少能写 system alert、Runner UI 告警，并尝试带外 IM fallback |

关键不变量：**deterministic policy 负责安全和时序，PI 负责工程语义；所有写动作再经过 action gate 的状态前置条件和幂等键。**

## 4. 授权请求策略

### 4.1 授权来源

当前主要是 Codex provider 的 `approval/requested`，可归类为：

- `command`：执行命令；
- `file`：修改文件；
- `permission`：申请更高权限或更大 scope；
- `approval`：无法归类的通用确认。

### 4.2 授权不应默认找用户，但也不能等 PI 推理

授权请求先进入 **deterministic fast path**，而不是 PI decision turn：

```text
approval/requested (同步阻塞，10s 内必须返回)
  -> PiSafetyPolicy deny-list / scope check
  -> PiApprovalFastPolicy deterministic classifier
  -> decision:
       - approve once       # 仅低风险、scope 精确命中
       - approve for session # 仅同类低风险请求降摩擦，不覆盖后续 deny-list
       - deny / decline      # 高风险、不确定、scope 缺失、PI 不可用
       - async_escalate      # deny 本次请求后异步询问用户或让 session 稍后重试
```

`PI context check` 只能参与非阻塞路径：例如生成给用户的解释、汇总为什么拒绝、或在下一次 `session.resume_followup` 中请求更窄授权。不能在 Codex approval RPC 还悬挂时建 PI session、跑 LLM、等 JSON 解析。

可以自动同意的低风险场景必须同时满足：

- 命中当前 issue / 当前 repo / 当前 workspace 的明确 scope；
- 不触发 deny-list；
- 命令或文件路径可确定性解析；
- 操作可审计、非破坏性、可回滚；
- 当前 session 的 delegation/authorization 仍在 TTL 内。

候选低风险包括：

- 当前 workspace / 当前 repo 内的读操作；
- 针对当前 issue 的小范围文件编辑；
- 跑测试、lint、build、typecheck；
- 查看 git status、git diff、日志、项目配置；
- Runner Chat 明确委托后的 continuation / retry / resume。

必须 deny 或升级给用户的高风险场景：

- `sudo`、系统目录、全局服务、launchd/systemd 变更；
- 删除大量文件、清空目录、不可逆迁移；
- `git reset --hard`、强推、改远端、发布部署；
- 访问 SSH key、系统钥匙串、云凭证、浏览器密码、个人目录敏感文件；
- 跨 workspace / 跨 repo，且没有明确委托；
- 外部账号、付费资源、生产环境、真实用户数据；
- PI / policy 无法判断风险或上下文不足。

所有自动授权都必须写审计：approval id、issue id、命令/路径摘要、risk、decision、scope、policy rule、evidence refs、resolver latency。

### 4.3 默认保守边界

PI 可以更主动，但不能成为权限绕过器：

- deny-list 在 LLM 之前执行，PI 输出不能覆盖；
- 中风险必须有当前 issue 上下文和明确用户委托；
- `approve for session` 只缓存同类低风险 request 的低摩擦结果，每个新 request 仍重新跑 deny-list；
- 高风险必须用户确认；
- 不确定按高风险处理；
- 连续自动授权失败、resolver 异常或 fast path 超预算时，停止自动处理并升级。

## 5. Runner 阻塞与长时间无进展

“runner 阻塞”不应直接等价于“通知用户”。它应该是 PI 的待处理事件。

### 5.1 阻塞类型

常见阻塞信号：

- `session_no_recent_progress`：session/run 长时间无新事件；
- `executor_stream_disconnected`：stream 断开、reconnect 多次失败；
- `provider_transient_network_error`：网络 timeout、EOF、socket reset、DNS；
- `provider_rate_limited`：429、quota、retry-after；
- `approval_pending`：Codex 等待授权；
- `terminal_state_mismatch`：session 已结束，但 issue 仍 `in_progress`；
- `runner_queue_stuck`：queue 有 todo，但 project loop 没继续消费；
- `workspace_hold`：dirty worktree、配置缺失、provider unavailable；
- `verification_loop_stuck`：验证失败但可继续修复。

### 5.2 PI 处理方式

PI 先收集上下文：

- issue status、attempt_count、最近 comments；
- latest run/session/turn 状态；
- 最近 provider events / errors；
- 最近 agent 输出和工具调用；
- approval pending 情况；
- workspace/git 状态摘要；
- 同 issue 的恢复历史和预算。

然后 PI 可以执行：

- `session.resume_followup`：对断开的 Codex session 发送续聊消息；
- `session.steer`：对仍在 running 的 turn 发送收束/继续/检查指令；
- `issue.retry`：transient failure 后重新排队；
- `issue.retry_after`：根据 429/retry-after 到期后再恢复；
- `runner.kick_project_loop`：queue 卡住时重启消费；
- `issue.state_repair`：在确定性诊断命中且 state precondition 仍成立时修复 terminal mismatch；
- `issue.comment`：记录诊断和动作；
- `needs_user`：确实需要用户业务判断时再升级。

`issue.state_repair` 是写权威状态的高爆炸半径动作，必须由确定性诊断产生 payload，执行前检查：issue 当前 status、latest run/session terminal 状态、updated_at/version、executor 是否仍 busy。执行时保存改前快照，写 `issue.state_manager_repair` audit；PI 只能选择已有 repair proposal，不能自由拼 patch。

### 5.3 夜间值守目标

用户睡觉后，PI 应该能处理这种场景：

```text
session 因网络问题断开
  -> heartbeat 检测 no progress
  -> PI 判断为 transient network
  -> PI 发送 resume follow-up
  -> Codex session 继续执行
  -> issue 完成后进入下一个 issue
  -> 用户醒来看到一条批量总结
```

这正是 PI 相比普通 issue loop 的价值：不只是把任务排队，而是在无人值守时持续管理执行链路。

## 6. Issue 失败策略

失败默认先由 PI 管，而不是直接通知用户。

### 6.1 分类

- `transient`：网络、rate limit、provider temporary unavailable、stream disconnect；
- `recoverable_engineering`：测试失败、lint 失败、类型错误、实现遗漏；
- `needs_context`：需求不清、验收标准冲突、缺素材/账号/业务信息；
- `unsafe_or_external`：高风险权限、外部系统、生产数据；
- `exhausted`：超过 retry/resume budget。

### 6.2 动作

- transient：wait/retry/resume，不通知或只写 audit；
- recoverable engineering：让 executor 继续修，或创建 follow-up issue；
- needs_context：PI 汇总问题后问用户；
- unsafe_or_external：直接升级用户确认；
- exhausted：给用户一条结构化摘要，说明已尝试什么、为什么停下。

默认预算建议：

- 恢复预算使用 **rolling 24h + issue 生命周期** 双维度：同一 issue 自动恢复最多 3 次/24h，进入 terminal 后不再重置；用户显式 retry 或重新 enqueue 才开启新生命周期；
- 同一 session resume 最多 2 次/24h；issue retry 和 session resume 共享 `total_recovery_budget`，避免 3 次 retry + 2 次 resume 叠加成意外 5 次；
- 同一 provider rate limit 按 retry-after 等待，不盲目重试；
- resume 前要检查 workspace dirty 状态、open run、pending approval；不能在未知脏状态上无限续跑；
- 每次恢复后必须检测是否有新进展，否则进入 cooldown 或升级。

`progress_detected` 的定义必须排除 keepalive/token usage/重复 error。可计为进展的信号包括：新 agent message、完成的工具/命令、git diff hash 改变、issue/run/session 状态推进、verification/commit/issue update 信号。

## 7. 通知策略

### 7.1 用户可见通知类型

系统事件先转成 `notification_intent`，而不是直接 IM：

```json
{
  "intent_id": "...",
  "project_id": "movo-mobile",
  "conversation_id": "...",
  "issue_id": 414,
  "kind": "issue_done",
  "severity": "info|watch|actionable|urgent",
  "source_event_id": "...",
  "summary": "issue #414 done",
  "requires_user": false
}
```

Coordinator 决定：

- `suppress`：不发，只审计；
- `aggregate`：进入批量摘要；
- `send_now`：立即发；
- `ask_pi`：让 PI 生成自然语言说明；
- `escalate_user`：用户必须处理。

### 7.2 默认行为

对 Runner Chat / Feishu Chat 发起的批量执行：

- start：不逐条通知，由 PI 最后一条回复总结；
- done：不逐条通知，进入批量进度摘要；
- pending verification：默认聚合，除非需要用户验收；
- failed：PI 先诊断和自恢复；
- approval：deterministic fast policy 先判断能否自动同意，PI 只参与异步解释/升级；
- blocked/no progress：PI 先恢复；
- PI unavailable：系统直接通知用户。

默认 suppress/aggregate 的前提是 intent 已持久化，并且存在可触发的 digest flush；禁止“只 suppress、不落库”。

### 7.3 用户偏好

用户在对话中表达的通知偏好必须落到状态里，例如：

- “不用每个都通知”；
- “我睡觉了，明天再汇报”；
- “只在失败时找我”；
- “这个项目安静模式”；
- “完成后给我总览”。

建议保存为 project/conversation 级 preference：

```json
{
  "project_id": "movo-mobile",
  "conversation_id": "feishu:...",
  "scope": "run_group|conversation|project",
  "mode": "quiet|digest|normal|verbose",
  "notify_on": ["needs_user", "pi_unavailable", "budget_exhausted"],
  "digest_policy": {
    "on_batch_complete": true,
    "max_interval_minutes": 120
  },
  "expires_at": "2026-06-18T08:00:00Z",
  "effective_after_event_id": 12345,
  "version": 3
}
```

偏好写入规则：

- NL 解析结果必须回显确认，例如“已切到安静模式，到明天 08:00 恢复 normal，只在需要你/预算耗尽/PI 不可用时通知”；
- “今晚/睡觉/明天再说”这类临时偏好必须有 `expires_at`，到期自动恢复；
- 先持久化 preference，再回复用户；后续 coordinator 按 `effective_after_event_id`/`version` 处理竞态；
- 多会话冲突按“run group origin conversation > explicit project preference > conversation preference > default”解析；urgent/needs_user/pi_unavailable 不被 quiet 永久压制。

PI 的自然语言承诺必须和该 preference 写入保持一致；不能只在回复里说“我不会通知”，但系统继续逐条发。

### 7.4 Run group 与 digest flush

批量执行必须有一等 run group，而不是只靠口头“这一批”：

- `pi_run_groups`：`run_group_id`、project、origin conversation、created_by message、expected_issue_count、status、started_at、deadline_at、completed_at；
- `pi_run_group_items`：run_group ↔ issue membership、issue final status、last_intent_id；
- `notification_intents` / digest items：记录每个被 suppress/aggregate 的用户可见事件；
- 独立 `digest_flush` 调度：按 batch complete、`max_interval_minutes`、deadline、PI unavailable 强制 flush。

如果最后一个 issue 卡住，run group 不能永远等待 complete：到 `deadline_at` 或 `max_interval` 后发送“部分完成 + 卡住项 + PI 已尝试动作/下一步”的 digest，并按 severity 决定是否升级用户。

### 7.5 Event inbox 语义与 backpressure

PiGuardian event inbox 至少保证 at-least-once，因此消费端必须有：

- per-source sequence/version；
- `source_event_id + decision_kind + issue_id/run_group_id` 幂等键；
- lease/cooldown，避免同一事件被 supervisor 与 heartbeat 双动作；
- decision batching/backpressure：同一 run group 的 info 级生命周期事件优先合并，不为每个 done/start 都开一次 PI decision turn。

### 7.6 Urgent escalation 与 ack

`urgent` 级别不能只以 outbox sent / `feishuMessageId` 作为完成条件：这只证明平台收到了消息，不证明用户读到或处理。urgent intent 需要记录 `ack_required`、`ack_status`、`ack_deadline_at`；超过 ack deadline 后按策略重复提醒、切换 Runner UI banner，或升级到备用通道。

## 8. PI 自己不可用

这是少数应该由系统直接通知用户的情况，但检测和发送不能依赖 PI 本身。

直接通知触发条件：

- PI runtime 不可用；
- PI decision turn 连续失败；
- notification coordinator 无法运行；
- outbox/dispatcher 连续失败或只能发 fallback；
- supervisor heartbeat 超过阈值且无法自恢复。

通知内容应该清楚说明：

- PI 当前不可用；
- 哪些 project/issue 可能不再被托管；
- runner 是否仍在执行；
- 用户需要做什么；
- 恢复后 PI 会不会补发摘要。

这类 fallback 是系统保底，不需要 PI 生成。

实现上由 `PiGuardianWatchdog` 独立运行：它不创建 PI runtime，不等待 notification coordinator；可直接写 system alert、Runner UI banner，并尝试最小 Feishu text fallback。若 IM 通道也失败，必须持久化未送达告警和下一次重试时间，避免“PI 挂了所以没人知道 PI 挂了”的循环依赖。

## 9. 数据与审计

可优先复用现有表：`issue_events`、`pi_actions`、`im_reply_drafts`、`sync_outbox`、approval records。必要时新增轻量表。

入 PI prompt 前必须先做确定性脱敏：绝对路径、token/key/secret、云凭证、SSH/keychain/browser password、长日志和 stack trace 先在 context builder 层截断/替换，不能只依赖 PI 输出“自觉脱敏”。

建议新增轻量表：

### 9.1 `pi_guardian_decisions`

记录 PI 或 policy 对事件的判断：

- `decision_id`
- `source_event_id`
- `project_id`
- `issue_id`
- `conversation_id`
- `kind`
- `decision`
- `risk_level`
- `requires_user`
- `evidence_json`
- `actions_json`
- `created_at`

### 9.2 `pi_notification_preferences`

记录项目/会话级通知偏好：

- `project_id`
- `conversation_id`
- `mode`
- `notify_on_json`
- `digest_policy_json`
- `source_message_id`
- `scope`
- `expires_at`
- `effective_after_event_id`
- `version`
- `created_at`
- `updated_at`

### 9.3 `pi_recovery_attempts`

记录自动恢复预算和结果：

- `issue_id`
- `session_id`
- `diagnosis_code`
- `action_type`
- `status`
- `progress_detected`
- `created_at`


### 9.4 `pi_run_groups` / `pi_run_group_items`

记录批量执行边界和 digest 触发条件：

- `run_group_id`
- `project_id`
- `conversation_id`
- `source_message_id`
- `expected_issue_count`
- `status`
- `deadline_at`
- `last_digest_at`
- `created_at`
- `updated_at`

items 记录 `run_group_id`、`issue_id`、`status`、`last_intent_id`。

### 9.5 `pi_notification_intents`

记录 suppress/aggregate/send 的每个用户可见事件：

- `intent_id`
- `source_event_id`
- `run_group_id`
- `issue_id`
- `conversation_id`
- `kind`
- `severity`
- `decision`
- `idempotency_key`
- `flush_after_at`
- `created_at`

### 9.6 `pi_guardian_event_inbox`

记录事件消费与仲裁状态：

- `source_event_id`
- `source_sequence`
- `event_type`
- `lease_owner`
- `lease_expires_at`
- `consumed_at`
- `idempotency_key`

## 10. 实现分期

### Phase 1：通知入口收敛

- 将 issue lifecycle 的用户通知改成 `notification_intent`；
- 引入 run group membership，Runner Chat/Feishu Chat 批量执行默认 suppress per-issue start/done，但必须落 digest item；
- 支持“不要逐条通知”的 project/conversation/run-group preference，含确认、TTL、版本；
- 保留 approval/failed 的现有通知作为 fallback，但先进入 coordinator 判定；
- 增加独立 digest flush 调度；
- 增加测试覆盖：批量 done 不逐条发，最终摘要由 PI 或 system digest 发。

### Phase 2：PI 授权托管

- 对 `approval/requested` 增加 deterministic fast classifier 和 deny-list；
- 低风险命令/文件操作在 10s RPC 预算内自动 approve；
- 高风险或不确定立即 deny/decline 本次请求并异步升级用户；
- `approve for session` 只缓存同类低风险请求，每次仍重跑 deny-list；
- 所有 auto approval 写 audit，含 resolver latency；
- 增加审批 resolver 失败和超预算的 fallback 通知。

### Phase 3：Issue Supervisor 自恢复

- 对 stale in-progress、stream disconnect、network error、429、terminal mismatch 建立诊断；
- PI 生成 `resume_session` / `steer_session` / `retry_issue` / `kick_runner` 决策；
- 增加 cooldown、budget、progress detection；
- 恢复失败才升级用户。

### Phase 4：批量摘要与夜间报告

- 对 run group continuation 生成 digest；
- 支持用户醒来后问“昨晚进展怎么样”；
- PI 汇总 completed / retried / blocked / needs_user；
- digest flush 在 batch complete、max interval、deadline、PI unavailable 时都能触发；
- 摘要中只包含关键证据，不泄露本地路径、secret、长日志。

### Phase 5：PI health fallback

- 监控 PI runtime / coordinator / dispatcher；
- watchdog 不依赖 PI runtime，PI 不可用时系统直接通知用户或写 Runner UI 告警；
- PI 恢复后补扫 missed intents 并生成补充摘要。

## 11. 验证要求

至少覆盖以下测试：

- 用户说“不用每个都通知”后，后续 `done` 不再逐条 IM；
- Runner Chat 批量启动 10 个 issue，只产生一条 PI summary；
- 批量 issue 完成后，只产生 batch digest，不产生 10 条 done；
- low-risk Codex approval 自动 approve，并记录 audit；
- high-risk approval 仍通知用户；
- stale session 被 PI resume，且不直接打扰用户；
- transient failure 自动 retry，超过预算后升级；
- PI unavailable 时系统 fallback 通知用户；
- approval fast path 不等待 PI decision turn，超预算/不确定会 deny 并异步升级；
- prompt injection 文本不能绕过 deterministic deny-list；
- supervisor 与 heartbeat 对同一事件不会双动作，幂等键生效；
- digest 因单个 issue 卡住也会按 max interval/deadline flush；
- notification preference 写入有确认、TTL、竞态屏障；
- `issue.state_repair` 需要状态前置条件、改前快照和 audit；
- urgent escalation 需要 ack 或至少记录未 ack 状态；
- notification preference 不影响 issue event/audit 完整性；
- 所有进入 PI prompt 和用户可见消息的内容都经过脱敏，不包含绝对路径、secret、长 stack trace。

## 12. 非目标

- 不让 PI 或任何 LLM 输出绕过 deterministic 安全边界自动批准危险操作；
- 不把所有失败都无限 retry；
- 不要求 PI 直接改业务代码来修复 executor；PI 通过 session/action 管理执行；
- 不删除 per-issue audit；只是减少用户可见噪音；
- 不把 Feishu 做成唯一入口，Runner Chat 应共享同一 notification coordinator。

## 13. 成功标准

用户可以放心说：

> “把剩下的 issue 都做完，我睡觉了。”

系统应表现为：

- PI 接管批量执行；
- 普通 start/done/progress 不刷屏；
- session 网络断开时 PI 自动续聊；
- 低风险授权由 deterministic fast policy 在时序预算内处理；
- failed/no progress 先由 PI 诊断和恢复；
- 需要用户业务判断或危险授权时才打扰；
- 第二天用户看到的是一条清晰进度总结，而不是几十条机械 lifecycle 通知。
