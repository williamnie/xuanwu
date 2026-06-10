# PI Agent 独立架构计划

> 状态：架构/产品计划文档，不是实现记录。  
> 目标读者：后续实现 agent、人工 reviewer、产品决策者。  
> 当前日期：2026-05-28。  
> 范围：`codex-issue-runner` 内建设独立 PI Agent 层；底层 Codex 只作为 code agent/provider 之一。

## 1. 目标愿景

PI Agent 是 `codex-issue-runner` 的项目主控 agent，而不是 Codex 的 subagent。用户主要和 PI 对话，由 PI 负责把需求转成 issue 面板、管理项目进度、追踪执行状态、在需要人工决策时通知用户，最终由用户验收。

目标形态：

```text
用户
  ↕ 对话 / 决策 / 验收
PI Agent（独立主 agent）
  ↕ issue 管理 / project 管理 / session 观察 / 任务派发 / 记忆 / MCP / skills
Runner Control Plane
  ↕ 受控 actions / events / policies / audit
Code Agent Providers
  ├─ Codex（写代码、跑测试、回写 issue）
  ├─ Claude Code（可选执行 provider）
  ├─ opencode / Kimi / future providers
  └─ fake/test providers
```

关键原则：

- PI 是上层 orchestrator，负责项目和 issue 生命周期。
- Codex 是底层 code agent/provider，不再等同于系统主 agent。
- PI 可以读项目代码、读 issue、读 session、读运行日志，但默认不直接改项目代码。
- PI 可以驱动 Codex 等底层 agent 写代码。
- Codex 也可以通过 runner skills/API 创建 issue；一旦 issue 进入 runner 项目，就归 PI 管理。
- PI 有自己的 provider 配置、会话、记忆、权限、工具、审计和 UI。
- PI 能接 MCP、skills、项目上下文、runner 内部 actions。

## 2. 当前状态判断

当前 PI 已收敛为 issue-first orchestration：

```text
用户/PI chat
  → 创建或更新 issue description/comment
  → 需要执行时 move/enqueue
  → executor/verifier/reviewer/report workflows
```

当前限制：

- issue 规格直接写入 `description` / comments，不再维护独立结构化规格区块。
- PI 仍默认只读项目代码，写操作通过 issue/action proposal 闭环。
- provider/session 由 executor workflow 和 agent profile 选择链管理。
- 不具备长期记忆。
- 不具备 project manager loop。
- 不自动管理 issue 状态。
- 不具备独立 action permission。
- 不具备 MCP/skills 作为 PI 工具层的一等接入。

已有可复用基础：

- Issue 状态机、issue events、comments、runs、workflow snapshot。
- Runner project loop、auto-run、hold、auto-retry、restart recovery。
- Provider seam：Codex、Claude execution-only、fake provider。
- Agent Profile v0。
- Sessions 页面和 Codex session 读写能力。
- CLI/API 回写 issue 状态的完成门禁。
- Verification gate 和 Verifier report 雏形。

## 3. 目标能力清单

### 3.1 用户和 PI 对话

用户应能在 PI 对话里表达：

- 新功能需求。
- bug 反馈。
- 优先级调整。
- 项目方向。
- 验收反馈。
- 暂停/继续某项开发。

PI 应能：

- 提问澄清。
- 读取项目代码和已有 issue。
- 自动拆解 issue。
- 写入 issue 面板。
- 维护 roadmap/backlog。
- 汇报当前项目进度。
- 请求用户确认高风险动作。

### 3.2 PI 管理 Issue

PI 应接管 issue 生命周期：

```text
intake
  → clarify
  → shape description
  → plan
  → create/update issues
  → prioritize
  → assign executor
  → enqueue
  → monitor execution
  → verify evidence
  → request user acceptance
  → close / retry / split follow-up
```

PI 可执行的 issue actions：

- 创建 issue。
- 编辑 issue title/description。
- 写 comment。
- 调整 priority。
- 设置 executor profile/provider。
- move triage → todo。
- enqueue/retry/cancel。
- 创建 follow-up issue。
- 关联 session/source turn。
- 汇总 issue 进度。
- 触发 verifier。
- 给 accept/reject/request changes 建议。

### 3.3 PI 管理 Project

PI 应理解 project：

- 项目目标。
- 项目代码结构。
- 当前工作区状态。
- project provider/executor 配置。
- project hold 原因。
- auto-run 状态。
- 近期 issue/run/session 活动。

PI 可执行的 project actions：

- 汇总项目状态。
- 生成项目 roadmap。
- 建议开启/暂停 auto-run。
- 建议默认 executor profile。
- 发现 dirty worktree/hold 并解释原因。
- 规划 PI 驱动的 issue 执行批次。
- 维护项目级记忆。

第一版不允许 PI 自动修改高风险 project 设置；只允许提出 action proposal，由用户确认。

### 3.4 PI 观察和干预 Codex Sessions

PI 应能看到底层 Codex session/turn 的进度，包括：

- 当前运行中 session。
- 所属 project/issue。
- provider/codex thread id。
- turn 状态。
- 最近文本输出。
- 最近 tool/command/file patch 事件。
- pending approval。
- token/usage 摘要。

PI 应能和 session 对话：

- 对运行中 Codex turn 发 steer 指令。
- 对已完成 session 发 follow-up。
- 请求 Codex 总结当前状态。
- 请求 Codex 停止/收束。

所有 PI→Codex 干预必须写审计事件，并受权限控制。第一版建议只开放：

- summarize session。
- steer running turn with human-approved message。
- request status update。

### 3.5 PI 读代码但不改代码

PI 默认有 read-only project context 能力：

- 读取文件。
- 搜索文件。
- 读取目录树。
- 读取 git diff/status/log。
- 读取 package/test/build 配置。
- 读取已有 docs。

PI 不直接执行写文件 patch。写代码通过 executor provider 完成：

```text
PI 生成 execution spec
  → 创建/更新 issue
  → 选择 executor profile
  → enqueue issue
  → Codex/Claude executor 修改代码
  → executor 回写 issue 状态
  → PI/Verifier 汇总证据
```

如果未来允许 PI 直接改项目代码，必须作为单独高风险能力开关，不进入本计划第一阶段。

### 3.6 PI 独立记忆系统

PI 需要自己的长期记忆，不依赖 Codex session 历史。

记忆分层：

```text
Global memory
  - 用户偏好
  - 通用工作方式
  - 常用验收标准

Project memory
  - 项目目标
  - 架构概览
  - 关键目录
  - 开发约定
  - 已知坑
  - provider/executor 偏好

Issue memory
  - 决策记录
  - 验收口径
  - 失败原因
  - follow-up

Session memory
  - 会话摘要
  - 关键结论
  - 需要追踪的承诺
```

记忆能力：

- 写入受控，不能把未经确认的猜测当事实。
- 每条 memory 有 source、confidence、scope、created_at、updated_at。
- 可被 PI 检索并注入 prompt。
- 用户可查看、编辑、禁用、删除。
- 高敏信息默认不写入。

### 3.7 PI 接 MCP / Skills

PI 应能把 MCP 和 skills 作为工具能力，而不是自然语言建议。

目标能力：

- 列出可用 skills。
- 读取 skill metadata。
- 根据任务选择 skill intent。
- 调用 runner 内置 tools/actions。
- 连接 MCP server capability registry。
- 为 executor issue 写入需要使用的 skill/plugin intent。
- 记录 PI 使用了哪些 tools/skills。

边界：

- PI 不能绕过 Codex/runner 的权限模型。
- PI 不能自行安装未知插件或连接未授权 MCP。
- PI 对 MCP/skills 的调用必须进入 audit log。
- 第一版优先做 skills metadata/read-only intent，不做任意 MCP tool execution。

## 4. 目标架构

### 4.1 分层

```text
Frontend
  ├─ PI Chat / PI Dashboard
  ├─ Issue Board
  ├─ Project Dashboard
  ├─ Sessions Monitor
  └─ Approval / Notification UI

API Layer
  ├─ /api/pi/agents
  ├─ /api/pi/conversations
  ├─ /api/pi/actions
  ├─ /api/pi/memory
  ├─ /api/pi/projects/:id/status
  └─ existing /api/issues /api/projects /api/sessions

PI Orchestrator
  ├─ Conversation service
  ├─ Planning service
  ├─ Action proposal/execution engine
  ├─ Issue manager
  ├─ Project manager
  ├─ Session observer
  ├─ Memory service
  ├─ Tool registry / skills / MCP bridge
  └─ Notification policy

Runner Control Plane
  ├─ Issue store/events/runs
  ├─ Provider registry
  ├─ Session adapters
  ├─ Scheduler/cron
  └─ Verification/hold/retry

Provider Layer
  ├─ Codex provider
  ├─ Claude provider
  ├─ future providers
  └─ read-only project context provider
```

### 4.2 PI Agent 与 Executor Agent 分离

新增 agent roles：

```text
pi_manager
  - 上层主 agent
  - 管 issue/project/session/memory
  - 默认 read-only code access
  - 可以调用受控 runner actions

executor
  - 底层 code agent
  - 修改代码、跑测试
  - 必须显式回写 issue 状态

verifier
  - 只读验证 agent
  - 汇总证据，给验收建议
```

### 4.3 Provider 角色拆分

project 不应只有一个 provider。建议拆成：

```json
{
  "project_id": "codex-issue-runner",
  "pi_agent_id": "pi-default",
  "default_executor_profile_id": "codex-dev",
  "default_verifier_profile_id": "codex-verifier"
}
```

PI 可以使用自己的 provider：

```json
{
  "id": "pi-default",
  "role": "pi_manager",
  "provider": "codex",
  "model": "...",
  "sandbox": "read-only",
  "approval_policy": "always",
  "instructions": "你是项目 PI...",
  "action_policy_id": "pi-safe-default"
}
```

注意：第一版 PI provider 可以仍然是 Codex，但系统身份必须是 PI，不再把 PI 等同于 Codex session。

## 5. 数据模型计划

### 5.1 `pi_agents`

建议新增表：

```sql
create table pi_agents (
  id text primary key,
  name text not null,
  role text not null default 'pi_manager',
  provider text not null default 'codex',
  model text not null default '',
  reasoning_effort text not null default '',
  approval_policy text not null default 'always',
  sandbox text not null default 'read-only',
  instructions text not null default '',
  action_policy_id text not null default '',
  memory_policy_id text not null default '',
  enabled integer not null default 1,
  created_at text not null,
  updated_at text not null
);
```

### 5.2 `project_pi_settings`

```sql
create table project_pi_settings (
  project_id text primary key,
  pi_agent_id text not null,
  auto_manage integer not null default 0,
  auto_triage integer not null default 0,
  auto_enqueue integer not null default 0,
  notify_on_needs_user integer not null default 1,
  max_actions_per_cycle integer not null default 5,
  created_at text not null,
  updated_at text not null
);
```

### 5.3 `pi_conversations`

```sql
create table pi_conversations (
  id text primary key,
  project_id text not null default '',
  pi_agent_id text not null,
  title text not null default '',
  status text not null default 'active',
  created_at text not null,
  updated_at text not null
);
```

### 5.4 `pi_turns`

```sql
create table pi_turns (
  id text primary key,
  conversation_id text not null,
  role text not null,
  content text not null default '',
  provider text not null default '',
  provider_session_id text not null default '',
  provider_turn_id text not null default '',
  status text not null default 'completed',
  created_at text not null
);
```

### 5.5 `pi_actions`

```sql
create table pi_actions (
  id text primary key,
  project_id text not null default '',
  issue_id integer not null default 0,
  conversation_id text not null default '',
  turn_id text not null default '',
  action_type text not null,
  status text not null,
  risk_level text not null default 'low',
  requires_confirmation integer not null default 0,
  payload_json text not null default '{}',
  result_json text not null default '{}',
  rationale text not null default '',
  created_at text not null,
  updated_at text not null
);
```

状态：

```text
proposed | approved | rejected | executing | completed | failed | cancelled
```

### 5.6 `pi_memory_items`

```sql
create table pi_memory_items (
  id text primary key,
  scope text not null,
  scope_id text not null default '',
  kind text not null,
  content text not null,
  source_type text not null default '',
  source_id text not null default '',
  confidence text not null default 'medium',
  pinned integer not null default 0,
  disabled integer not null default 0,
  created_at text not null,
  updated_at text not null
);
```

scope 示例：

```text
global | project | issue | session | conversation
```

### 5.7 Provider-aware session index

不要继续把 Sessions 完全绑定 Codex。新增轻量 index：

```sql
create table agent_sessions (
  session_key text primary key,
  provider text not null,
  provider_session_id text not null,
  agent_id text not null default '',
  role text not null default '',
  project_id text not null default '',
  issue_id integer not null default 0,
  title text not null default '',
  preview text not null default '',
  status text not null default '',
  origin text not null default '',
  updated_at text not null,
  created_at text not null
);
```

第一版可以只做 PI 会话落库，Codex session 仍从 Codex list/read 读取，但 UI/API 要开始使用 `session_key`。

## 6. API 计划

### 6.1 PI Agents

```text
GET    /api/pi/agents
POST   /api/pi/agents
GET    /api/pi/agents/:id
PATCH  /api/pi/agents/:id
DELETE /api/pi/agents/:id
```

### 6.2 Project PI Settings

```text
GET   /api/projects/:id/pi-settings
PATCH /api/projects/:id/pi-settings
POST  /api/projects/:id/pi/run-once
POST  /api/projects/:id/pi/pause
POST  /api/projects/:id/pi/resume
```

### 6.3 PI Conversations

```text
GET  /api/pi/conversations?project_id=
POST /api/pi/conversations
GET  /api/pi/conversations/:id
POST /api/pi/conversations/:id/messages
POST /api/pi/conversations/:id/interrupt
```

### 6.4 PI Actions

```text
GET  /api/pi/actions?project_id=&issue_id=&status=
POST /api/pi/actions/:id/approve
POST /api/pi/actions/:id/reject
POST /api/pi/actions/:id/execute
```

### 6.5 PI Memory

```text
GET    /api/pi/memory?scope=&scope_id=
POST   /api/pi/memory
PATCH  /api/pi/memory/:id
DELETE /api/pi/memory/:id
```

### 6.6 Session Observation

```text
GET  /api/pi/projects/:id/sessions/status
POST /api/pi/sessions/:session_key/summarize
POST /api/pi/sessions/:session_key/steer
POST /api/pi/sessions/:session_key/request-status
```

第一版 `steer` 默认需要人工确认。

## 7. PI Action Policy

PI action 必须分风险等级。

### 7.1 Safe auto actions

可默认自动执行：

- summarize_project_status
- summarize_issue
- create_issue_comment
- update_issue_description
- propose_executor
- create_pi_memory_from_confirmed_summary

### 7.2 Soft-confirm actions

默认需要确认，可由 project 设置放开：

- create_issue
- move_issue_to_todo
- change_issue_priority
- assign_executor_profile
- enqueue_issue
- retry_issue
- create_followup_issue
- steer_codex_session

### 7.3 Hard-confirm actions

必须人工确认：

- cancel_running_issue
- accept_verification
- reject_verification
- request_changes
- change_project_provider
- change_project_pi_settings
- enable_auto_manage
- bulk_issue_update
- delete_memory

## 8. PI Loop 计划

### 8.1 手动 `Run PI once`

第一版优先实现手动运行一次：

```text
用户点击 Run PI once
  → PI 读取 project 状态
  → PI 读取 triage/todo/in_progress/pending_verification/failed issue 摘要
  → PI 读取 running sessions 摘要
  → PI 产出 project status + proposed actions
  → safe actions 自动执行
  → risky actions 等待确认
```

### 8.2 Event-triggered loop

第二版增加事件触发：

- issue.created
- issue.comment
- issue.failed
- issue.pending_verification
- issue.stale
- project.hold
- session.approval_requested
- session.completed

### 8.3 Auto-manage loop

第三版允许项目开启自动管理：

```text
每 N 分钟 / event trigger
  → PI 扫描项目
  → 生成 action proposals
  → 执行 safe actions
  → 通知用户需要确认的 actions
```

限制：

- 每轮最多执行 `max_actions_per_cycle`。
- 同一 issue 有 cooldown。
- 失败三次进入 needs_user。
- 不允许无限自触发。

## 9. PI 与 Codex 的关系

Codex 是 executor provider，不是 PI 的主身份。

### 9.1 Codex 创建 issue

Codex 可以通过 runner skills/API 创建 issue：

```text
Codex session
  → codex-issue-runner issue create --status triage
  → issue 进入 runner
  → PI 接管 issue
```

PI 接管动作：

- 记录 intake source 为 Codex session。
- 读取 source session 摘要。
- 补充 issue description/comment。
- 判断是否需要用户确认。
- 指派 executor。

### 9.2 PI 驱动 Codex 写代码

```text
PI conversation
  → PI 创建/更新 issue
  → PI 选择 executor profile=codex-dev
  → PI enqueue issue
  → runner 启动 Codex issue run
  → Codex 修改代码/跑测试/回写状态
  → PI 观察 run/session
  → PI 总结并通知用户验收
```

### 9.3 PI 与运行中 Codex session 对话

PI 不直接混入 Codex turn，除非通过受控 action：

```text
pi.action.steer_codex_session
  → requires_confirmation=true by default
  → approved
  → runner.StartSessionTurn(mode=steer)
  → audit event
```

## 10. MCP / Skills 集成计划

### 10.1 Skill Registry

新增 PI 可读 skill registry：

- skill id
- name
- description
- trigger rules
- allowed roles
- risk level
- source path/metadata

PI 可用它来：

- 判断创建 issue 时应推荐哪些 skill。
- 给 executor profile 加 skill intents。
- 在 PI 自身对话中读取流程说明。

第一版只读 metadata，不直接运行任意 skill。

### 10.2 MCP Registry

新增 MCP capability registry：

- server id
- tool/resource names
- description
- auth/readiness status
- allowed PI actions
- risk level

第一版建议：

- 只接 read-only MCP resources/list。
- 不允许 PI 直接调用高风险 MCP tool。
- 所有 MCP 调用写 `pi_actions` 或 `pi_tool_events`。

### 10.3 PI Tool Envelope

PI 不直接拿系统级工具，而是通过统一 envelope：

```json
{
  "tool": "issue.create",
  "arguments": {},
  "risk_level": "medium",
  "requires_confirmation": true
}
```

Runner 决定是否执行。

## 11. Frontend 计划

### 11.1 PI Chat

新增页面/面板：

```text
/pi
/projects/:id/pi
```

功能：

- 和 PI 对话。
- 选择 project context。
- 查看 PI 当前读取的上下文。
- 查看 proposed actions。
- 一键 approve/reject。
- 查看 PI memory 命中。

### 11.2 Project PI Dashboard

在 Project detail 或 Projects 页增加：

- PI Agent 配置。
- Auto manage 开关。
- Run PI once。
- 当前 project health。
- 最近 PI actions。
- needs user 列表。

### 11.3 Issue Detail 增强

Issue detail 增加：

- Managed by PI badge。
- PI decisions timeline。
- Proposed actions。
- Ask PI。
- Source sessions。
- Executor assignment。

### 11.4 Sessions Monitor 增强

Sessions 页面增加：

- agent/provider/role badge。
- issue linkage。
- PI-visible progress summary。
- PI actions: summarize / request status / steer。

## 12. 通知计划

PI 需要通知用户：

- 需要澄清需求。
- 高风险 action 等待确认。
- issue pending verification。
- issue failed 且 PI 无法自行恢复。
- project hold。
- batch 完成。
- 最终验收。

通知渠道复用现有 notification settings，新增 event types：

```text
pi.needs_user
pi.action_pending
pi.project_blocked
pi.issue_ready_for_acceptance
pi.batch_summary
```

## 13. 验收标准

### 13.1 Phase 1 验收

- 可以创建 PI Agent 配置。
- project 可以绑定 PI Agent。
- PI issue/chat workflow 读取 PI Agent provider，不依赖旧草稿生成接口。
- PI 会话以 PI conversation 记录落库。
- UI 能看到 PI Agent 配置和 PI 对话。
- PI 仍然只读，不改项目代码。

### 13.2 Phase 2 验收

- 用户能和 PI 聊需求。
- PI 能自动创建 triage issue proposal。
- PI 能写 issue comment，并通过 issue proposal 创建结构化 description。
- PI 能提出 move-to-todo/enqueue action。
- 需要确认的 action 不会自动执行。
- 所有 PI actions 可审计。

### 13.3 Phase 3 验收

- PI 能 Run once 汇总项目状态。
- PI 能扫描 issue 面板并识别 blocked/failed/pending verification。
- PI 能观察 Codex running session 摘要。
- PI 能通知用户需要决策。
- PI 能驱动 Codex executor 处理 issue。

### 13.4 Phase 4 验收

- PI 有独立 memory。
- PI 能检索 project memory 并引用来源。
- PI 能读取 skills metadata。
- PI 能为 issue 写入 skill intents。
- PI 能通过受控 envelope 调用 read-only MCP/runner tools。

## 14. 实施拆分建议

### Milestone A：PI 一等身份和配置

1. 新增 PI Agent 数据模型。
2. 新增 project PI settings。
3. 新增 PI Agent API。
4. Projects UI 增加 PI 配置。
5. 移除旧草稿生成路径，PI 直接服务 issue description/comment workflow。
6. 保持只读、人工保存。

### Milestone B：PI Conversation 和 Action Proposal

1. 新增 PI conversations/turns。
2. 新增 PI Chat UI。
3. 新增 PI action proposal model。
4. 实现 comment/create issue proposals。
5. 实现 approve/reject/execute action。
6. 所有 actions 写 issue/project events。

### Milestone C：PI Project Manager Loop

1. 实现 project status snapshot。
2. 实现 Run PI once。
3. 实现 issue board analysis prompt。
4. 实现 failed/pending_verification/hold 识别。
5. 实现 needs_user 通知。
6. 增加 auto-manage loop，但默认关闭。

### Milestone D：Session Observation 和 Codex Delegation

1. provider-aware session index v1。
2. 给 Codex sessions 增加 issue/project linkage summary。
3. PI 可 summarize Codex session。
4. PI 可提出 steer action。
5. 人工确认后 PI 可 steer running Codex turn。
6. UI 展示 PI 对 Codex session 的干预历史。

### Milestone E：PI Memory / Skills / MCP

1. 新增 PI memory store/API/UI。
2. Project memory 自动摘要但需确认保存。
3. Skill registry read-only 接入。
4. PI prompt 注入相关 skill metadata。
5. MCP registry read-only 接入。
6. Tool envelope 和 audit log。

## 15. 风险与约束

### 15.1 最大风险：范围过大

这是平台级改造，不应作为单个 issue 实现。必须拆 milestone，每个 milestone 都能单独验收。

### 15.2 最大架构风险：过早统一所有 provider session

Provider-aware sessions 很重要，但第一阶段不应强行统一 Codex/Claude/opencode/Kimi 全 transcript。建议先让 PI 自己有 conversation/session store，再逐步把底层 sessions 纳入 observation index。

### 15.3 最大安全风险：PI 自动执行过多动作

PI 是 manager，权限比 executor 更敏感。默认只允许 safe actions 自动执行，高风险动作必须人工确认。

### 15.4 最大产品风险：PI 只会多说话不做事

PI 的输出不能只停留在自然语言总结。每次 PI run 应产生结构化结果：

- project summary
- issue updates
- proposed actions
- notifications
- memory candidates

### 15.5 最大实现风险：把 PI 绑死到 Codex

第一版可以底层使用 Codex provider，但必须保证系统模型中 PI 是独立身份：

```text
PI conversation / PI action / PI memory / PI settings
```

不要继续把 PI 的状态只存在 Codex thread 里。

## 16. 推荐第一步

建议第一批 issue 只做 Milestone A，并明确不做自动管理：

```text
目标：PI Agent 成为项目一等配置，并接管 issue description/comment workflow。
```

第一批拆成 5 个 triage issue：

1. `PI Agent data model and API v1`
2. `Project PI settings and UI binding`
3. `PI conversation store v1 for issue planning turns`
4. `Remove legacy draft path and use issue description workflow`
5. `PI architecture guardrails: read-only policy, action risk taxonomy, audit events`

完成后系统仍然不会自动管理项目，但 PI 已经从“Codex 临时 subagent”升级为“项目绑定的独立主 agent 配置”。后续 Milestone B/C 再让它开始真正管理 issue 和 project。
