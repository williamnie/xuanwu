# Bun + TypeScript 后端重写计划

> 状态：架构决策 + 迁移计划。  
> 日期：2026-05-28。  
> 决策：停止把 Go 后端继续扩成 PI/agent 平台，改为用 Bun + TypeScript 重写后端；PI SDK 成为一等运行时。  
> 分发目标：单个 Bun 编译二进制，保留当前前端与 CLI/daemon 使用体验。  
> 重要边界：这是计划文档，不是已经完成的实现。  
> 并行策略：Go 版本保持可用，不抢占现有端口；Bun/TS 版本在独立分支、独立端口、独立数据目录中开发，直到明确切换。

## 1. 结论

当前 Go 后端已经适合做 runner/control plane 原型，但继续往 PI 主 agent、skills、extensions、session runtime、MCP/tool ecosystem 方向扩，会越来越别扭。PI SDK 已经提供 TypeScript SDK、AgentSession、AgentSessionRuntime、事件流、工具、extensions、skills、session management、settings management、RPC mode 等能力；继续用 Go 重造这些能力会拖慢产品。

因此后续方向改为：

```text
Bun + TypeScript = 新一代后端目标
PI SDK = 主 agent runtime
Codex / Claude / future code agents = executor providers
SQLite = 持久化
React frontend = 先保留，逐步只改 API client 兼容差异
单个 Bun executable = 分发形态
Go 后端 = 冻结维护的稳定版本，继续占用原端口并服务日常使用
```

不再采用：

```text
Go 后端 + TS sidecar + Go gateway
```

也不再采用：

```text
Go-native PI runtime 重造 agent loop/tools/session/memory
```


## 1.1 并行开发决策

新版本开发周期会比较长，因此不直接替换当前 Go 服务。并行策略如下：

```text
main / current Go service
  - 保持可用
  - 继续监听现有端口 127.0.0.1:3008
  - 继续使用现有 data/ 与 DB
  - 只做关键 bugfix，不再承载 PI 平台大功能

bun-ts-rewrite branch / Bun service
  - 新分支开发
  - 默认监听新端口 127.0.0.1:3018
  - 默认使用新数据目录 data-bun/
  - 默认使用独立 SQLite: data-bun/runner.db
  - 可以只读导入 Go DB 快照，但不得直接写生产 Go DB
  - 前端开发可用独立 Vite/API target
```

切换前的原则：

- Go 版本一直能用。
- Bun 版本不抢占 Go 的端口。
- Bun 版本不直接改 Go 正在使用的 DB。
- 两套 launchd label 区分，避免互相重启。
- Bun 版本达到核心功能可用后，再做显式 migration/switchover。

建议分支名：

```bash
git switch -c feat/bun-ts-pi-runtime
```

建议默认端口：

```text
Go stable:  127.0.0.1:3008
Bun dev/preview: 127.0.0.1:3018
```

## 2. 依据

### 2.1 PI SDK 已覆盖核心 agent runtime

PI SDK 文档说明它用于把 pi 的 agent 能力嵌入其他应用、构建自定义 UI、自动化 pipeline、custom tools、sub-agents 和程序化测试。

关键 API/能力：

- `createAgentSession()`
- `AgentSession`
- `createAgentSessionRuntime()`
- `AgentSessionRuntime`
- session event streaming
- prompt / steer / followUp
- Agent state access
- built-in tools
- custom tools
- extensions
- skills
- context files
- slash commands
- session management
- settings management
- run modes / RPC mode

官方安装包：

```bash
npm install @earendil-works/pi-coding-agent
```

参考：

- https://pi.dev/docs/latest/sdk

### 2.2 Bun 适合 TypeScript 后端和单文件分发

Bun 官方定位是 JavaScript/TypeScript all-in-one toolkit，包含 runtime、package manager、test runner、bundler。

Bun 支持：

```bash
bun run src/main.ts
bun test
bun build ./src/main.ts --compile --outfile ../dist/codex-issue-runner-bun
```

Bun `--compile` 可以把 TypeScript/JavaScript entrypoint 生成 standalone executable，并包含 Bun runtime 与导入包。它也支持 cross-compile target。

参考：

- https://bun.sh/docs
- https://bun.sh/docs/bundler/executables
- https://bun.sh/docs/typescript

### 2.3 Bun 与 PI SDK 的兼容性需要第一阶段硬验证

PI SDK 是 Node.js/TypeScript SDK；Bun 大体兼容 Node 包生态，但不能凭文档假定所有 SDK 功能都能在 Bun runtime 与 Bun compiled executable 下无差异运行。

必须先做 Spike 0：

```text
bun install @earendil-works/pi-coding-agent
bun run examples/pi-smoke.ts
bun build src/pi-smoke.ts --compile --outfile dist/pi-smoke
./dist/pi-smoke
```

验收重点：

- SDK 能在 Bun runtime 下创建 session。
- `AgentSession.prompt()` 能完成一次简单响应。
- event streaming 正常。
- read-only tools 正常。
- session file / settings / auth 路径可控。
- 编译后的 executable 能启动并跑通同样 smoke。
- 如果 compiled executable 不支持某些动态 extension 加载，核心 server 仍可运行，extension 动态加载作为 dev/runtime 功能保留。

如果 Bun runtime 通过但 Bun executable 不通过，则临时允许：

```text
开发/部署用 bun run
release binary 延后
```

但主语言仍然保持 TypeScript，不回退 Go。

## 3. 目标架构

### 3.1 总体结构

```text
codex-issue-runner-bun executable
  ├─ HTTP API / SSE / WebSocket
  ├─ PI Runtime（Pi SDK）
  ├─ Issue Manager
  ├─ Project Manager
  ├─ Session Manager
  ├─ Provider Runtime
  │   ├─ Codex provider adapter
  │   ├─ Claude provider adapter
  │   └─ future providers
  ├─ Action Engine
  ├─ Memory Engine
  ├─ Skills / Extensions / MCP Registry
  ├─ Scheduler / Nightly / Cron
  ├─ Notification Engine
  ├─ CLI commands
  └─ SQLite Store
```

### 3.2 单进程职责

Bun 后端在新版本内是唯一主进程；与现有 Go 稳定服务并行运行时，它不接管 Go 的端口和数据目录：

- 提供 HTTP API。
- 服务现有 React frontend。
- 跑 PI Agent。
- 管 issue/project/session/memory。
- 直接调 PI SDK。
- 直接拉起 Codex/Claude executor。
- 管 SQLite。
- 发 SSE/WebSocket events。
- 提供 CLI subcommands。
- 打包成单 binary。

不再有 Go gateway，不再有 TS sidecar。

### 3.3 PI 是主 agent

PI 不再是 Codex subagent。PI 是系统主 agent：

```text
用户 ↔ PI Agent
PI Agent ↔ issue/project/session/memory/actions
PI Agent ↔ Codex/Claude executors
用户最终验收
```

PI 可以：

- 和用户长期对话。
- 读取项目代码。
- 自动创建 issue 面板。
- 管理 issue 生命周期。
- 管理 project roadmap。
- 观察 Codex session 进度。
- 对 Codex session 发 steer/follow-up。
- 调用 skills/extensions/custom tools。
- 写入独立记忆。
- 在需要用户时发通知。

PI 默认不直接修改项目代码。写代码交给 executor provider。

### 3.4 Executor provider

底层 code agent provider 负责写代码、跑验证、回写状态：

- Codex provider：优先保留现有 app-server JSON-RPC 能力，迁移到 TypeScript。
- Claude provider：迁移现有 `claude -p --output-format stream-json` execution-only 能力。
- Future providers：opencode / Kimi / other code agents。

Provider 只做 executor，不做 project manager。

## 4. 技术选型

### 4.1 Runtime

选择 Bun。

原因：

- 原生运行 TypeScript。
- 内置 package manager/test runner/bundler。
- 单 binary 分发路径清晰。
- 内置 `bun:sqlite`，避免第一版引入 native DB driver。
- 对本地 daemon/CLI/server 组合场景更直接。

### 4.2 HTTP 层

第一版建议使用 `Bun.serve` + 自研轻量 router，而不是引入重框架。

原因：

- 降低 compiled executable 风险。
- 保持 API handler 可控。
- 当前 API 面以 JSON/SSE 为主，不需要复杂框架。

如果后续 handler 过多，再引入 Hono。第一版不引入 Elysia/Prisma/Nest。

### 4.3 DB 层

选择 SQLite + `bun:sqlite`。

约束：

- 第一版不使用 Prisma。
- 第一版不使用 Drizzle native migration runtime。
- 自研 SQL migration runner。
- 使用 typed row mapper + Zod/TypeBox schema 做边界校验。

原因：

- 更利于 Bun compiled executable。
- 当前 Go 版本已是 SQLite，迁移成本低。
- 避免 native driver/package postinstall 影响二进制分发。

### 4.4 Schema / Validation

建议使用 `typebox` 或 `zod`。

优先级：

```text
typebox > zod
```

原因：PI SDK custom tools 示例使用 TypeBox；action/tool schema 更容易和 PI SDK 对齐。

### 4.5 PI SDK

使用：

```ts
@earendil-works/pi-coding-agent
```

核心使用方式：

- `createAgentSessionRuntime()` 管 PI 会话生命周期。
- `createAgentSession()` 处理单 session。
- `SessionManager.create()` 持久化 PI session。
- `createReadOnlyTools()` 或 tools `['read', 'grep', 'find', 'ls']` 作为 PI 读代码能力。
- `defineTool()` 暴露 runner action tools。
- `DefaultResourceLoader` 读取 project/global skills/extensions/context。
- `session.steer()` / `session.followUp()` 管运行中指导。

### 4.6 前端

短期保留 React frontend。

迁移策略：

- Bun 后端先兼容现有 `/api/*` contract。
- 前端新增 PI 页面时再扩展 API。
- 不在第一阶段重写前端。

### 4.7 分发

目标命令：

```bash
bun build ./src/main.ts --compile --outfile dist/codex-issue-runner-bun
```

目标形态：

```text
dist/codex-issue-runner serve
./dist/codex-issue-runner issue status --id 1
./dist/codex-issue-runner pi chat --project codex-issue-runner
```

单 binary 内含：

- Bun runtime。
- 后端代码。
- API handlers。
- CLI command dispatcher。
- embedded frontend assets，可作为后续目标。

运行时外部依赖仍允许：

- SQLite DB 文件。
- user auth/settings files。
- PI agent dir。
- Codex/Claude CLI。
- project workspaces。

## 5. 目录规划

建议新增 TypeScript 后端目录，先和 Go 并存，验证后替换：

```text
backend-ts/
  package.json
  bun.lock
  tsconfig.json
  src/
    main.ts
    config/
      env.ts
      paths.ts
    http/
      server.ts
      router.ts
      auth.ts
      sse.ts
      errors.ts
    db/
      database.ts
      migrations.ts
      schema.ts
      repositories/
        issues.ts
        projects.ts
        sessions.ts
        piAgents.ts
        piMemory.ts
        piActions.ts
    pi/
      runtime.ts
      agent.ts
      prompts.ts
      tools.ts
      actionPlanner.ts
      memory.ts
      projectSnapshot.ts
      sessionObserver.ts
    providers/
      types.ts
      codex/
        adapter.ts
        jsonRpc.ts
        events.ts
      claude/
        runner.ts
        stream.ts
    runner/
      issueRunner.ts
      projectLoop.ts
      hold.ts
      retry.ts
      recovery.ts
      verification.ts
    scheduler/
      cron.ts
      nightly.ts
    cli/
      index.ts
      issue.ts
      project.ts
      pi.ts
      system.ts
    notifications/
      notifier.ts
    frontend/
      static.ts
    util/
      ids.ts
      time.ts
      redact.ts
      childProcess.ts
  tests/
    unit/
    integration/
    fixtures/
```

长期替换后可以把 `backend-ts/` 提升为 `backend/`，Go 代码进入 `legacy/go-backend/` 或删除。

## 6. 数据模型

### 6.1 兼容已有表

第一阶段直接读取现有 SQLite 表，减少迁移风险：

- `projects`
- `issues`
- `issue_events`
- `issue_runs`
- `issue_templates`
- `agent_profiles`
- `session_turn_references`
- `session_command_events`
- `cron_tasks`
- `nightly_batches`
- `project_holds`
- `notification_settings`
- `uploads`

TypeScript 后端必须兼容当前 DB schema。

### 6.2 新增 PI 表

新增：

```sql
create table if not exists pi_agents (
  id text primary key,
  name text not null,
  provider text not null default 'pi-sdk',
  model_provider text not null default '',
  model_id text not null default '',
  thinking_level text not null default 'medium',
  cwd_policy text not null default 'project',
  tools_json text not null default '[]',
  instructions text not null default '',
  enabled integer not null default 1,
  created_at text not null,
  updated_at text not null
);

create table if not exists project_pi_settings (
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

create table if not exists pi_conversations (
  id text primary key,
  project_id text not null default '',
  pi_agent_id text not null,
  title text not null default '',
  status text not null default 'active',
  session_file text not null default '',
  pi_session_id text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists pi_actions (
  id text primary key,
  project_id text not null default '',
  issue_id integer not null default 0,
  conversation_id text not null default '',
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

create table if not exists pi_memory_items (
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

### 6.3 Session Index

新增 provider-aware session index：

```sql
create table if not exists agent_sessions (
  session_key text primary key,
  provider text not null,
  provider_session_id text not null,
  agent_role text not null default '',
  project_id text not null default '',
  issue_id integer not null default 0,
  title text not null default '',
  preview text not null default '',
  status text not null default '',
  raw_ref text not null default '',
  created_at text not null,
  updated_at text not null
);
```

用于统一 PI session、Codex session、Claude session 的列表和进度观察。

## 7. API 兼容目标

Bun 版本的 API contract 目标是兼容现有前端和 CLI，但开发期默认服务地址是 `http://127.0.0.1:3018`，不是 Go 稳定服务的 `http://127.0.0.1:3008`。前端开发时通过 env/API target 指向 Bun；日常使用继续走 Go。


### 7.1 必须兼容的现有 API

第一阶段 Bun 后端必须兼容：

```text
GET    /health
GET    /api/events
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:id
GET    /api/issues
POST   /api/issues
GET    /api/issues/:id
PATCH  /api/issues/:id
POST   /api/issues/:id/comments
GET    /api/issues/:id/events
GET    /api/issues/:id/runs
POST   /api/issues/:id/enqueue
POST   /api/issues/:id/retry
POST   /api/issues/:id/cancel
POST   /api/issues/:id/verification
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id
POST   /api/sessions/:id/messages
POST   /api/sessions/:id/interrupt
GET    /api/system/status
GET    /api/system/doctor
GET    /api/system/logs
POST   /api/system/restart
```

前端先不大改，靠 API compatibility 降低迁移风险。

### 7.2 新增 PI API

```text
GET    /api/pi/agents
POST   /api/pi/agents
GET    /api/pi/agents/:id
PATCH  /api/pi/agents/:id

GET    /api/pi/conversations?project_id=
POST   /api/pi/conversations
GET    /api/pi/conversations/:id
POST   /api/pi/conversations/:id/messages
POST   /api/pi/conversations/:id/interrupt

GET    /api/pi/actions?project_id=&issue_id=&status=
POST   /api/pi/actions/:id/approve
POST   /api/pi/actions/:id/reject
POST   /api/pi/actions/:id/execute

GET    /api/pi/memory?scope=&scope_id=
POST   /api/pi/memory
PATCH  /api/pi/memory/:id
DELETE /api/pi/memory/:id

POST   /api/projects/:id/pi/run-once
POST   /api/projects/:id/pi/pause
POST   /api/projects/:id/pi/resume
```

## 8. PI SDK 集成设计

### 8.1 PI session 创建

PI session 根据 project 创建：

```ts
const { session } = await createAgentSession({
  cwd: project.cwd,
  agentDir: config.piAgentDir,
  tools: ['read', 'grep', 'find', 'ls'],
  customTools: runnerActionTools,
  sessionManager: SessionManager.create(project.cwd),
  authStorage,
  modelRegistry,
});
```

### 8.2 PI custom tools

PI 不直接拿 DB 连接，而是通过受控 tools 调 runner action layer。

工具分组：

```text
issue.list
issue.read
issue.create_proposal
issue.comment
issue.update_refinement
issue.enqueue_proposal
issue.retry_proposal
project.status
project.list
session.list
session.read_summary
session.steer_proposal
memory.search
memory.write_candidate
notification.request_user
```

### 8.3 PI action engine

PI tool 不直接执行高风险动作。所有动作进入 action engine：

```text
PI calls tool
  → validate payload
  → classify risk
  → if safe: execute
  → if confirm required: create pi_action pending
  → publish SSE
  → user approve/reject
  → execute approved action
```

### 8.4 PI read-only code access

PI 默认工具：

```text
read, grep, find, ls
```

不默认启用：

```text
edit, write, unrestricted bash
```

如需 bash，只允许 read-only command allowlist：

```text
git status --short
git diff --stat
git log --oneline -n <N>
rg ...
find ...
cat ...
ls ...
```

### 8.5 PI 与 Codex session 对话

PI 通过 runner tool 发起：

```text
session.steer_proposal
```

默认 `requires_confirmation=true`。用户确认后：

```text
Codex provider adapter → turn/steer
```

所有 steer 写入：

- `pi_actions`
- `issue_events`
- `agent_sessions`
- SSE event

## 9. Provider 迁移设计

### 9.1 Codex provider

迁移 Go 中 `backend/internal/codex` 的 stdio JSON-RPC adapter 到 TypeScript：

```text
codex app-server --listen stdio://
  ← initialize
  ← thread/start
  ← thread/list
  ← thread/read
  ← thread/resume
  ← thread/name/set
  ← turn/start
  ← turn/steer
  ← turn/interrupt
  ← model/list
  → notifications/events
```

TS 文件：

```text
backend-ts/src/providers/codex/jsonRpc.ts
backend-ts/src/providers/codex/adapter.ts
backend-ts/src/providers/codex/events.ts
```

### 9.2 Claude provider

迁移现有 execution-only provider：

```text
claude -p --verbose --bare --output-format stream-json
```

保留边界：

- issue_execution only。
- 不接 Sessions 页面第一版。
- provider run completed 不等于 issue done。
- 必须显式回写 issue status。

### 9.3 PI provider

PI provider 不是 executor provider。PI 是 manager role。不要把 PI 放到 `project.provider` 里和 Codex/Claude 混用。

推荐字段：

```text
project_pi_settings.pi_agent_id
issue.agent_profile_id for executor
issue_runs.provider for executor runtime
```

## 10. CLI / Daemon / 分发

### 10.1 单 binary 多模式

入口：

```text
codex-issue-runner serve
codex-issue-runner issue ...
codex-issue-runner project ...
codex-issue-runner session ...
codex-issue-runner pi ...
codex-issue-runner system ...
```

无参数默认 `serve`，兼容当前行为。

### 10.2 launchd

开发期不替换当前 Go launchd。新增独立 Bun launchd label：

```text
Go stable label:  com.xiaobei.codex-issue-runner
Bun preview label: com.xiaobei.codex-issue-runner-bun
```

Bun launchd 默认参数：

```text
ProgramArguments:
  /path/to/dist/codex-issue-runner-bun
  serve
  --addr
  127.0.0.1:3018
  --db
  /path/to/data-bun/runner.db
  --state-dir
  /path/to/data-bun
```

只有正式切换时，才把原 Go label 指向 Bun binary 或停掉 Go label。

Go stable 与 Bun preview 在并行期必须保持隔离：

```text
Go stable:
  addr:       127.0.0.1:3008
  data dir:   data/
  db:         data/app.db 或 data/runner.db（以当前 Go 启动参数为准）
  launchd:    com.xiaobei.codex-issue-runner
  token file: data/auth_token

Bun preview:
  addr:       127.0.0.1:3018
  data dir:   data-bun/
  db:         data-bun/runner.db
  launchd:    com.xiaobei.codex-issue-runner-bun
  token file: data-bun/auth_token
```

并行 smoke 时不要把 Bun 指到 `127.0.0.1:3008`，也不要把 Bun DB 指到 Go stable 正在使用的 `data/runner.db`。token 只从对应 token file 读取到环境或 `--token-file`，不要把实际 token 粘贴到文档、issue、日志或截图。

最小 smoke 命令：

```bash
# Go stable 日常路径
curl -fsS http://127.0.0.1:3008/health
codex-issue-runner system status \
  --addr 127.0.0.1:3008 \
  --token-file data/auth_token \
  --json

# Bun preview 路径
curl -fsS http://127.0.0.1:3018/health
./dist/codex-issue-runner-bun system status \
  --addr 127.0.0.1:3018 \
  --token-file data-bun/auth_token \
  --json

# launchd 隔离状态
./scripts/status-launchd.sh
./scripts/status-bun-preview.sh
```

### 10.3 Build

开发：

```bash
cd backend-ts
bun install
bun run dev
bun test
```

构建（不会覆盖 Go stable 的 `dist/codex-issue-runner`）：

```bash
bun run build:binary
# 等价核心命令：bun build ./src/main.ts --compile --outfile ../dist/codex-issue-runner-bun
```

脚本会输出 version/build stamp 摘要，并写入 `dist/codex-issue-runner-bun.build.stamp`。

跨平台后续：

```bash
bun build --compile --target=bun-darwin-arm64 ./src/main.ts --outfile dist/codex-issue-runner-darwin-arm64
bun build --compile --target=bun-linux-x64 ./src/main.ts --outfile dist/codex-issue-runner-linux-x64
```

## 11. 迁移路线

### Phase 0：Bun + PI SDK 可行性 Spike

目标：证明 Bun 能跑 PI SDK，并能编译基本 executable。该阶段必须在新分支和新端口策略下进行，不触碰 Go 稳定服务。

任务：

1. 创建分支 `feat/bun-ts-pi-runtime`。
2. 创建 `backend-ts/`。
3. 创建默认数据目录 `data-bun/`，加入 `.gitignore`。
4. 安装 `@earendil-works/pi-coding-agent`、`typebox`、`@types/bun`。
5. 写 `src/spikes/piSmoke.ts`。
6. 跑 `bun run src/spikes/piSmoke.ts`。
7. 跑 `bun build src/spikes/piSmoke.ts --compile --outfile dist/pi-smoke`。
8. 跑 `./dist/pi-smoke`。
9. 验证 session、events、read-only tools、auth paths。

通过标准：

- Bun runtime 下 PI SDK 可用。
- compiled executable 至少能启动 session 并完成 prompt。
- 如果 compiled executable 失败，必须记录具体失败原因；迁移仍继续，但 release binary milestone 延后。

P00.05 结论（2026-05-28）：`backend-ts/src/spikes/piSmoke.ts` 已通过 `bun build --compile`
生成 `dist/pi-smoke`，并在 `backend-ts` cwd 下跑通 prompt、events 与 read-only tool boundary smoke。
兼容性风险收敛为打包形态问题：PI SDK 在 Bun binary 模式会从 executable 旁解析包资源，smoke 通过启动时设置
`PI_PACKAGE_DIR` 指向本地 `backend-ts/node_modules/@earendil-works/pi-coding-agent` 解决；后续 release binary
需要复制这些 PI 包资源或提供等价 `PI_PACKAGE_DIR`。Phase 0 允许进入 P01。

### Phase 1：TS 后端骨架 + DB 兼容

目标：Bun 后端能在 `127.0.0.1:3018` 启动，读独立 SQLite，提供基础 API；Go 服务继续在 `127.0.0.1:3008` 可用。

任务：

1. `Bun.serve` HTTP server。
2. Bearer token auth。
3. `/health`。
4. SQLite connection，默认连接 `data-bun/runner.db`。
5. migration runner。
6. projects/issues read API。
7. SSE event bus。
8. system status。

通过标准：

- React frontend 能读 project/issue list。
- 现有 DB 不需要迁移即可只读展示。
- token 不泄漏。

### Phase 2：Issue API 写能力 + CLI

目标：TS 后端替代 Go issue CRUD 和 CLI。

任务：

1. issue create/update/comment。
2. enqueue/retry/cancel。
3. issue events/runs。
4. verification review。
5. CLI auth/token flags。
6. CLI issue status/create/update/logs。

通过标准：

- 现有 frontend Issues 页面基本可用。
- `codex-issue-runner issue update --status done/failed` 可用。
- executor 回写 contract 可用。

### Phase 3：Codex provider 迁移

目标：TS 后端能启动 Codex executor 跑 issue。

任务：

1. Port Codex JSON-RPC adapter。
2. Normalize events。
3. issue run start thread/turn。
4. consume events。
5. explicit status update gate。
6. interrupt/cancel。
7. model list。
8. session list/read/resume/steer。

通过标准：

- 单个 todo issue 能由 Codex 执行。
- issue run 记录 provider_session_id/provider_turn_id。
- Sessions 页面能显示 Codex sessions。
- interrupt 可收口状态。

### Phase 4：PI Agent 一等化

目标：PI SDK 成为主 agent runtime。

任务：

1. `pi_agents` / `project_pi_settings` / `pi_conversations` / `pi_actions` / `pi_memory_items`。
2. PI Chat API。
3. PI custom tools。
4. PI Run once。
5. PI action proposal。
6. PI memory search/write candidate。
7. PI project status snapshot。
8. PI issue creation/refinement/comment。

通过标准：

- 用户能和 PI 聊需求。
- PI 能创建 issue proposal。
- PI 能写 refinement/comment。
- PI 能管理 issue 到 todo/enqueue，但高风险动作需要确认。
- PI session 不再是 Codex session。

### Phase 5：Project Manager Loop

目标：PI 自动管理开发进度。

任务：

1. Auto-manage loop。
2. failed/pending_verification/hold scanner。
3. needs-user notification。
4. stale issue detection。
5. session progress observer。
6. PI summary dashboard。

通过标准：

- PI 能汇报项目状态。
- PI 能发现卡住的 issue。
- PI 能触发 verifier。
- PI 能请求用户验收。

### Phase 6：Claude provider + 多 provider 恢复

目标：恢复并增强 Go 版本已有 Claude execution-only 能力。

任务：

1. Port Claude stream-json parser。
2. Port execution-only issue runner。
3. Provider settings/doctor。
4. provider runtime metadata。
5. cancel timeout shield。

通过标准：

- Claude issue_execution 可用。
- 不误写 Codex thread 字段。
- 显式 status gate 仍生效。

### Phase 7：并行预览服务

目标：Bun 后端作为独立预览服务长期运行，不影响 Go 稳定服务。

任务：

1. build Bun binary，输出 `dist/codex-issue-runner-bun`。
2. 新增 Bun launchd install script，label 使用 `com.xiaobei.codex-issue-runner-bun`。
3. 默认监听 `127.0.0.1:3018`。
4. 默认使用 `data-bun/runner.db`。
5. 增加 Go DB 只读导入命令，将当前 projects/issues/templates 复制到 Bun DB。
6. update preview deploy scripts。
7. update skill/CLI docs，明确 Go stable 与 Bun preview 的 addr 区别。
8. start Bun preview service。
9. smoke `3018/health`、`3018/api/system/status`、issues、sessions、pi。

通过标准：

- Go stable 仍在 `127.0.0.1:3008` 可用。
- Bun preview 在 `127.0.0.1:3018` 可用。
- 两者 launchd label、DB、日志目录互不覆盖。
- 前端可通过配置切到 Bun preview。
- Codex issue execution 在 Bun preview 可用。
- PI Chat 在 Bun preview 可用。
- preview 可连续运行，不影响日常使用。

### Phase 8：显式切换

目标：只有当 Bun preview 通过完整验收后，才执行正式切换。

任务：

1. 停止新 issue 写入 Go stable，进入维护窗口。
2. 备份 Go DB 和 Bun DB。
3. 执行最终数据迁移。
4. 停止 Go launchd 或改为 fallback 端口。
5. 将 Bun 服务切到 `127.0.0.1:3008`，或将前端/CLI 默认 addr 切到 Bun。
6. smoke health/status/issues/sessions/pi/issue execution。
7. 保留 Go binary 和 DB backup 至少一个稳定周期。

通过标准：

- live 主入口由 Bun binary 提供。
- 前端主要功能可用。
- Codex issue execution 可用。
- PI Chat 可用。
- rollback path 明确。

## 12. 回滚策略

直到 Phase 8 显式切换完成并稳定运行前，Go 服务不删除、不停用、不迁移端口。

回滚方式：

```text
Go stable 未切换前：直接停止 Bun preview，不影响 Go。

正式切换后：
launchd 指回 Go dist binary
恢复 Go DB backup
停止 Bun service
启动 Go service
```

DB migration 必须满足：

- 新增表优先。
- 不破坏 Go 读取旧表。
- 修改旧表前必须有 backup。
- Phase 8 前不删除旧字段。

## 13. 风险

### 13.1 Bun compiled executable 与动态 extension

PI SDK 的 extensions/skills 可能依赖动态文件加载。Bun compiled executable 可以打包导入文件，但动态路径加载仍可能需要磁盘文件。

策略：

- core server 编译进 binary。
- PI global/project skills/extensions 保持外部目录。
- executable 只保证 server/runtime 核心可运行。
- extension 动态加载按 runtime 文件系统处理。

### 13.2 Node API 兼容风险

PI SDK 面向 Node.js/TypeScript。Bun 兼容大部分 Node API，但必须 smoke。

策略：

- Phase 0 先跑。
- 每次升级 Pi SDK 都跑 compatibility test。
- 如果某个 SDK 功能只在 Node 下稳定，局部以 `node` runner 作为临时 dev fallback，但主后端仍保持 TS/Bun 目标。

### 13.3 全量重写范围大

策略：

- API compatibility 优先。
- 前端先不重写。
- DB schema 尽量兼容。
- Go 只冻结，不立刻删除。
- 每个 phase 都有可运行状态。

### 13.4 二进制体积

Bun executable 会包含 runtime，体积会比 Go binary 大。

接受原因：

- 换来 TS/PI SDK 生态。
- 单文件分发仍成立。
- 本项目主要是本机/小团队 runner，不是极限嵌入式场景。

### 13.5 PI 权限过大

策略：

- PI 默认 read-only code tools。
- 写代码交给 executor issue。
- 高风险 action 人工确认。
- 所有 PI actions 审计。
- 不允许 PI 直接改 auth/secrets。

## 14. 立即执行建议

下一步不要再继续往 Go 后端加 PI 大功能。新工作放到 `feat/bun-ts-pi-runtime` 分支，默认端口 `3018`、数据目录 `data-bun/`。建议创建第一批 triage issues：

1. `Bun TS rewrite Spike 0: verify Pi SDK runtime and compiled executable`
2. `Bun TS backend skeleton: health/auth/sqlite/system status`
3. `Bun TS issues API compatibility v1`
4. `Bun TS Codex provider adapter port`
5. `Bun TS PI Agent runtime v1 with Pi SDK`
6. `Bun TS preview launchd/deploy binary packaging on port 3018`
7. `Bun TS explicit switchover plan after preview parity`

第一条必须最先做。只有 Spike 0 通过，才开始大规模迁移。

## 15. 决策记录

```text
Decision: Rewrite backend in Bun + TypeScript.
Reason: PI SDK is TypeScript-first and already owns agent/session/tools/extensions/skills abstractions.
Rejected: Continue growing Go backend into PI platform.
Rejected: Go gateway + TS PI sidecar as final architecture.
Accepted risk: Bun/PI SDK compiled executable compatibility must be proven by Spike 0.
Distribution target: single Bun executable.
Migration style: develop on separate branch with separate port/data/launchd; keep Go stable usable until explicit switchover.
```
