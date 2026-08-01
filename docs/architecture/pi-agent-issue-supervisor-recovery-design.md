# PI Agent Issue Supervisor Recovery 设计

> [!WARNING]
> **历史设计（2026-07-19 归档）**：本文保留旧 recovery 方案 provenance，不再定义当前 supervisor lifecycle。当前 source of truth 见 [canonical 架构文档索引](README.md)、[Run / Attempt 生命周期](xuanwu/0020-run-attempt-lifecycle-contract.md)、[Run command service](xuanwu/0023-run-lifecycle-command-service.md) 与 [重启恢复不变量](xuanwu/0069-restart-recovery-invariants.md)。

> 状态：完整功能设计与 backlog 拆分，不是实现记录。  
> 日期：2026-06-10  
> 范围：`codex-issue-runner` 的 PI Agent 对执行中 issue/session 进行巡查、判断、恢复、等待或升级。  
> 背景样例：issue #298 在 Codex stream `Reconnecting... 1/5` 后停滞，直到人工进入 session 发消息才继续。

## 1. 目标

PI Agent 应成为真正的 issue supervisor：不仅创建/拆解/排队 issue，也负责持续观察 issue 执行状态，在底层 executor/provider 出现可恢复异常时做出上下文判断，并通过受控 action 恢复或等待。

目标能力：

- 发现 `in_progress` issue 的真实执行状态，而不是只看 kanban status。
- 识别 transient execution/provider failure，包括 stream disconnect、429/rate limit、临时网络错误、provider idle timeout 等。
- 读取 issue、run、session、recent events、provider error、usage/rate-limit、workspace 状态摘要。
- 由 PI 根据上下文生成恢复策略和恢复消息，不写死“继续”。
- 支持等待到 provider 建议的恢复时间后再行动，例如 429 `retry_after` / reset time。
- 所有 PI 干预都有 policy、cooldown、retry budget、audit trail，并在 issue detail / Feishu IM 审批链路中可追踪。
- 避免自动撞墙：同一 issue/session 短时间反复失败时转 `needs_user` 或 `blocked`。

非目标：

- 不让 PI 绕过 executor 的验证/commit/issue update 契约。
- 不让 PI 直接修改项目代码来“补救” executor 失败；PI 仍通过 issue/session action 管理执行。
- 不把所有失败都自动重试；业务失败、测试失败、权限错误、明确用户输入需求仍应升级。

## 2. 概念模型

新增一层 `PI Issue Supervisor`，位于 heartbeat / state manager / session observer / action gate 之间。

```text
Issue / Run / Session / Events / Provider Health
        ↓
Issue Supervisor Signal Collector
        ↓
PI Recovery Context Builder
        ↓
PI Supervisor Decision Turn
        ↓
PiActionEnvelope + Gate + Cooldown + Budget
        ↓
Action Dispatcher
   ├─ session.resume_followup
   ├─ session.steer
   ├─ issue.retry_after
   ├─ issue.comment / needs_user.escalate
   └─ issue.state_repair
        ↓
Audit / Heartbeat Timeline / Issue Events / Reports
```

## 3. 状态与诊断

### 3.1 Supervisor diagnosis

在现有 `issueStateManager` 的 `stale_in_progress` 基础上，增加更细粒度诊断：

- `executor_stream_disconnected`
  - 示例：`Reconnecting... 1/5`、`responseStreamDisconnected`、`stream disconnected before completion`。
- `provider_rate_limited`
  - 示例：HTTP 429、`rate limit`、`too many requests`、`quota temporarily unavailable`。
- `provider_retry_after_waiting`
  - 已解析到未来 retry-after/reset time，尚未到恢复窗口。
- `provider_retry_after_ready`
  - 已到恢复窗口，可由 PI 判断是否恢复。
- `provider_transient_network_error`
  - 临时 DNS/timeout/socket/body decode 等。
- `session_no_recent_progress`
  - 没明显 error，但 session/run/issue 长时间无新事件。
- `session_recovery_exhausted`
  - 超过 recovery budget 或连续恢复无进展。
- `requires_human_decision`
  - PI 判断上下文不足、风险过高或疑似需要人工确认。

诊断只给“候选信号”和证据，不直接决定最终动作。

### 3.2 429 / retry-after 解析

新增 provider error parser，输入来自：

- `issue_events.payload.raw_payload`
- normalized provider event `error`
- provider health / usage rate-limit snapshot
- CLI/API stderr/stdout 中的 HTTP error body

需要提取：

- `status_code=429`
- `retry_after_seconds`
- `retry_after_at`
- `rate_limit_reset_at`
- `limit_id` / `limit_name`
- `provider` / `model` / `service_tier`
- 原始错误摘要（redacted）

兼容来源：

- HTTP `Retry-After` 秒数或 HTTP date。
- JSON body 中 `retry_after`, `retry_after_ms`, `reset_at`, `rate_limit_reset`, `retryAt`。
- 文本：`try again in 42s`、`retry after 1m`、`reset at 2026-...`。

如果无法解析恢复时间，但错误属于 transient/rate-limit，使用策略默认 cooldown（如 5/15/30 分钟）并交给 PI 决策。

## 4. PI 决策：不写死 prompt

### 4.1 决策不是规则模板

规则层只收集 evidence 和安全边界；最终动作由 PI supervisor turn 判断。PI 可以选择：

- 等待到 retry window。
- 对 session 发恢复 follow-up。
- 对 running turn 发 steer。
- retry issue 新 attempt。
- 评论说明状态并 `needs_user`。
- 标记 blocked/failed。
- 什么都不做，继续观察。

### 4.2 Recovery context

PI 决策输入必须结构化，包含：

```json
{
  "issue": { "id": 298, "status": "in_progress", "title": "...", "attempt_count": 1 },
  "project": { "id": "movo-web", "cwd": "...", "auto_run": true },
  "latest_run": { "id": "issue-298-attempt-1", "status": "in_progress", "started_at": "...", "ended_at": "" },
  "session": { "provider": "codex", "provider_session_id": "...", "provider_turn_id": "...", "status": "running" },
  "recent_events": [
    { "type": "error", "at": "...", "summary": "Reconnecting... 1/5" }
  ],
  "provider_error": {
    "category": "stream_disconnect|rate_limit|network|unknown",
    "status_code": 429,
    "retry_after_at": "...",
    "raw_summary": "..."
  },
  "workspace_snapshot": {
    "git_status_summary": "modified files / clean / unknown",
    "last_commands": ["pnpm exec vitest ... exit 0"],
    "last_agent_message": "..."
  },
  "recovery_history": {
    "attempts_24h": 1,
    "last_action_at": "...",
    "last_outcome": "no_progress|progress|completed|unknown"
  },
  "policy": {
    "allowed_actions": ["session.resume_followup", "session.steer", "issue.retry_after", "needs_user.escalate"],
    "cooldown": "...",
    "budget_remaining": 2
  }
}
```

### 4.3 PI 输出 schema

PI 决策必须返回结构化 JSON，而不是自由文本：

```json
{
  "decision": "wait|resume_session|steer_running_turn|retry_issue|needs_user|blocked|noop",
  "confidence": "low|medium|high",
  "rationale": "...",
  "recovery_message": "...",
  "wait_until": "2026-06-10T02:10:00Z",
  "risk_level": "low|medium|high",
  "evidence_refs": ["event:157762", "run:issue-298-attempt-1"],
  "expected_outcome": "...",
  "fallback_if_no_progress": "needs_user|retry_issue|blocked"
}
```

`recovery_message` 由 PI 根据上下文生成，不能是固定模板。系统只提供要求：必须检查当前状态、避免重复操作、遵守 issue completion contract。

## 5. Action 类型

新增或扩展 action：

### 5.1 `session.resume_followup`

对已断连/已结束/未知状态 session 发送 follow-up message，启动新 turn。

Payload：

```json
{
  "issue_id": 298,
  "provider": "codex",
  "provider_session_id": "...",
  "prompt": "PI generated recovery message",
  "decision_id": "...",
  "diagnosis_code": "executor_stream_disconnected"
}
```

风险：medium。delegated/autonomous 下允许，但必须满足 policy + cooldown + budget。

### 5.2 `session.steer`

已有 action。用于 turn 仍 active 且 provider 支持 steer 时。风险 high 或 confirm，默认更保守。

### 5.3 `issue.retry_after`

记录等待计划，不立即执行。到期后 cron/heartbeat 再唤起 PI 判断。

Payload：

```json
{
  "issue_id": 298,
  "reason": "provider_rate_limited",
  "retry_after_at": "...",
  "source_event_id": 123
}
```

### 5.4 `issue.supervisor_decision`

只记录 PI 判断，不执行副作用；用于审计和 UI 展示。

### 5.5 `needs_user.escalate`

当 PI 判断不该自动恢复或恢复预算耗尽时，写入 issue comment / notification。

## 6. Policy / 安全边界

### 6.1 Project policy

扩展 `project_pi_policies`：

- `allowed_supervisor_actions_json`
- `supervisor_mode`: `off | propose_only | assisted | autonomous`
- `supervisor_cooldown_seconds`
- `supervisor_max_recoveries_per_issue`
- `supervisor_max_recoveries_per_project_per_hour`（兼容字段，固定为 `0`，表示项目级不限制）
- `supervisor_rate_limit_wait_policy`: `respect_retry_after | default_cooldown | ask`

### 6.2 默认策略

默认建议：

- `propose_only`：只诊断和提 action proposal。
- 用户开启 delegated/autonomous 后，才自动执行 `session.resume_followup` 和 `issue.retry_after`。
- `session.steer` 默认需要确认，除非 project policy 明确授权。
- 429 必须尊重 retry-after/reset time；如果无明确时间，使用 exponential cooldown。
- 连续两次恢复没有新增 meaningful progress，则升级 `needs_user`。

### 6.3 Meaningful progress

恢复后需要观察是否有进展，不能只看是否产生新 turn。

算 progress：

- 新 agent message。
- 新 tool command 完成。
- git diff 变化。
- issue status 更新。
- run/session 更新。
- verification/commit/issue update 事件。

不算 progress：

- 单纯 token usage。
- 重复同类错误。
- 只产生空 turn。

## 7. Scheduler / Heartbeat 集成

### 7.1 快速 watchdog

新增 supervisor scheduler，每 1-5 分钟扫描：

- `in_progress` issues
- open `issue_runs`
- recent provider errors
- due retry-after actions

它只创建 supervisor candidate 或触发 PI decision，不直接执行恢复。

### 7.2 Heartbeat 集成

`collectProjectHeartbeatSignals` 增加：

- `supervisor_candidates`
- `provider_retry_windows`
- `recovery_budget`
- `stale_session_diagnostics`

`planHeartbeatActions` 可以把 candidate 变成 PI action proposal，但 PI supervisor decision 是独立 agent turn，不能只靠规则。

### 7.3 PI runtime integration

需要一个 `runPiSupervisorDecision`，复用 PI runtime / SDK tools，但输入是 supervisor context，输出是 decision JSON。

PI 可用工具：

- `issue_read`
- `issue_state_diagnose`
- `session_read_summary`
- `project_status`
- `sdk.grep/find/ls`（只读，可选）
- `issue_supervisor_context_read`
- `issue_supervisor_action_propose`

## 8. UI / 报告

### 8.1 Issue detail

显示：

- 审批主路径：Feishu IM interactive card；issue detail 保留 provider approval / supervisor state 的备份可视入口。
- Settings 只保留 runtime doctor、PI Agent、PI Memory 与 Feishu 设置；Guardian alert 统一走全局 banner。

- Supervisor diagnosis
- Last provider error
- Retry-after countdown
- Recovery history
- PI decision rationale
- Executed recovery message

### 8.2 Issue detail / heartbeat timeline

新增 timeline stage：

- `supervisor_signal`
- `supervisor_decision`
- `supervisor_action`
- `supervisor_result`

### 8.3 Reports

Night summary/report 增加：

- recovered issues
- rate-limit waits
- exhausted recoveries
- needs_user escalations from supervisor

## 9. Data model

建议新增表：`issue_supervisor_events`

字段：

- `id`
- `issue_id`
- `project_id`
- `run_id`
- `provider`
- `provider_session_id`
- `provider_turn_id`
- `diagnosis_code`
- `provider_error_category`
- `retry_after_at`
- `decision`
- `confidence`
- `action_id`
- `payload_json`
- `created_at`

也可先复用 `pi_actions` / `pi_action_events` / `issue_events`，但完整功能建议保留专用 supervisor event，以便 UI 和报表查询稳定。

## 10. 验证策略

需要覆盖：

- stream disconnect 断连后 PI 读取上下文并恢复。
- 429 带 retry-after：未到时间只 wait，到时间后 PI 判断恢复。
- 429 无 retry-after：按 policy cooldown。
- 连续恢复无进展：升级 needs_user。
- 权限/认证错误：不自动恢复。
- 测试失败/业务失败：不误判为 provider transient。
- policy propose_only：只记录 proposal，不执行。
- delegated/autonomous：满足授权才执行。
- audit：所有 action/event 可追溯。
- UI/API：timeline 能展示完整链路。

## 11. Backlog 拆分

### P0 设计/契约

- 定义 supervisor diagnosis/action/decision schema。
- 定义 policy 和 data model。
- 写测试 fixture：#298 stream disconnect、429 retry-after、无进展恢复循环。

### P1 信号采集与错误解析

- provider error parser。
- 429 retry-after/reset parser。
- issue/session/run context builder。
- meaningful progress detector。

### P2 PI 决策 runtime

- `runPiSupervisorDecision`。
- supervisor tools。
- structured JSON decision validation。
- PI 自生成 recovery message。

### P3 Action 执行与 gate

- `session.resume_followup` action。
- `issue.retry_after` action。
- cooldown/recovery budget。
- dispatch + audit。

### P4 Scheduler / Heartbeat

- supervisor scheduler。
- heartbeat signals/action plan 集成。
- retry-after due wakeup。

### P5 UI / Reports

- Issue detail supervisor panel。
- Issue detail heartbeat timeline stages。
- reports/notifications 汇总。

### P6 Hardening

- chaos tests / fixtures。
- live migration / backfill。
- redaction / sensitive payload review。
- launchd/live deploy smoke。
## 12. 上线与运维 Runbook

### 12.1 默认策略

Supervisor recovery 的 live 默认值是保守防护：

- `supervisor_mode='propose_only'`：只采集信号、写入 decision/proposal/audit，不自动恢复 session。
- `allowed_supervisor_actions_json='[]'`：即使切到 `autonomous`，没有显式 allowlist 也不会执行恢复动作。
- `supervisor_cooldown_seconds=300`，`supervisor_max_recoveries_per_issue=6`，`supervisor_max_recoveries_per_project_per_hour=0`（项目级不限制）；同一 Session 24 小时最多续跑 6 次。
- `supervisor_rate_limit_wait_policy='respect_retry_after'`：429 带 `Retry-After` / reset 时必须等窗口；429 无窗口时按 policy cooldown 生成等待候选。
- `session.steer` 仍是 high-risk action；默认不进 supervisor allowlist。
- 401/auth、permission、quota、业务失败、测试失败只允许 `needs_user` / `blocked`，不得自动恢复。

### 12.2 开启 delegated / autonomous

先读当前策略：

```bash
export CODEX_RUNNER_ADDR="${CODEX_RUNNER_ADDR:-127.0.0.1:3008}"
export CODEX_RUNNER_AUTH_TOKEN="${CODEX_RUNNER_AUTH_TOKEN:-$(cat data/auth_token)}"
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  "http://${CODEX_RUNNER_ADDR}/api/projects/<project-id>/pi-policy"
```

建议分两步上线：

1. `supervisor_mode='propose_only'` 观察 `/api/pi/heartbeat-timeline` 和 issue detail 的 supervisor panel。
2. 只对可恢复动作开启 autonomous，例如：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR}/api/projects/<project-id>/pi-policy" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "supervisor_mode":"autonomous",
    "allowed_supervisor_actions":["issue.retry_after","session.resume_followup"],
    "supervisor_cooldown_seconds":900,
    "supervisor_max_recoveries_per_issue":6,
    "supervisor_max_recoveries_per_project_per_hour":0,
    "supervisor_rate_limit_wait_policy":"respect_retry_after"
  }'
```

### 12.3 暂停 / 回滚

最小回滚是把 supervisor 切回只提案，并清空可执行 allowlist：

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR}/api/projects/<project-id>/pi-policy" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"supervisor_mode":"propose_only","allowed_supervisor_actions":[]}'
```

如需停止整个 PI project loop，使用已有 project PI control API；审批与人工介入主路径是 Feishu IM，issue detail 作为备份入口，不要直接改 SQLite。

### 12.4 排查

- 单 issue 视图：`GET /api/issues/<issue-id>/supervisor`。
- 全局 timeline：`GET /api/pi/heartbeat-timeline?issue_id=<issue-id>`，关注 `supervisor_signal`、`supervisor_decision`、`supervisor_action`、`supervisor_result`。
- project policy：`GET /api/projects/<project-id>/pi-policy`，确认 mode、allowlist、cooldown、budget。
- 固定 chaos fixtures：`backend-ts/src/pi/issueSupervisorRecoveryFixtures.ts` 覆盖 #298 stream disconnect、429 retry-after、429 无 retry-after、401、测试失败、连续恢复无进展。
- 回归命令：

```bash
cd backend-ts
bun test ./src/pi/providerErrorParser.test.ts \
  ./src/pi/issueSupervisorContext.test.ts \
  ./src/pi/issueSupervisorDecision.test.ts \
  ./src/pi/issueSupervisorActions.test.ts \
  ./src/pi/issue-supervisor-recovery.test.ts \
  ./src/http/pi-supervisor-api.test.ts \
  ./src/http/piProjectPolicyApi.test.ts
```

### 12.5 live deploy smoke

上线后最小验证：

```bash
./scripts/status-launchd.sh
./redeploy.sh
curl -fsS http://127.0.0.1:3008/health
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" http://127.0.0.1:3008/api/system/status
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" http://127.0.0.1:3008/api/projects
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" http://127.0.0.1:3008/api/pi/heartbeat-timeline
```
