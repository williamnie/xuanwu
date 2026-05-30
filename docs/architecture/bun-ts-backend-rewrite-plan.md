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

#### P08.01 Preview parity readiness gate（P08.05 前置）

P08.05 正式切换前必须在维护窗口按下面 checklist 留存结果。`must-pass` 任一未达标都阻止
P08.05；`can-defer` 只允许在有 follow-up issue、owner 和 rollback 影响说明时延后。所有命令不得
输出 token/secrets；API 调用优先用 `--token-file` 或临时 curl config，日志摘要必须 redacted。

准备变量（不打印 token）：

```bash
export GO_ADDR=127.0.0.1:3008
export GO_DB=data/runner.db
export GO_TOKEN_FILE=data/auth_token
export BUN_ADDR=127.0.0.1:3018
export BUN_STATE_DIR=data-bun
export BUN_DB=data-bun/runner.db
export BUN_TOKEN_FILE=data-bun/auth_token
export SMOKE_PROJECT=<已导入 Bun preview 的项目 id>

umask 077
curl_auth_config="$(mktemp)"
trap 'rm -f "$curl_auth_config"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$BUN_TOKEN_FILE")" > "$curl_auth_config"
```

| Gate | Level | 验收项 | 命令或验证方法 |
| --- | --- | --- | --- |
| Isolation | must-pass | Go stable 继续在 `3008` 可用，Bun preview 只在 `3018` 可用；Bun 不抢占 Go port。 | `curl -fsS "http://$GO_ADDR/health" >/dev/null`；`curl -fsS "http://$BUN_ADDR/health" >/dev/null`；`./scripts/status-launchd.sh`；`./scripts/status-bun-preview.sh`。 |
| Isolation | must-pass | Bun preview 只写 `data-bun/runner.db`，不直接写 Go stable 的 `data/runner.db`。 | `test "$BUN_DB" != "$GO_DB"`；`./dist/codex-issue-runner-bun db import-go --source "$GO_DB" --target "$BUN_DB" --json >/tmp/bun-import.json && jq -e '.source_readonly == true and .source_mtime_unchanged == true' /tmp/bun-import.json`。 |
| Health / status | must-pass | `/health`、`/api/system/status`、runtime doctor 都成功，且 status 显示 DB、auth、Codex command/capabilities 可用。 | `./dist/codex-issue-runner-bun system status --addr "$BUN_ADDR" --token-file "$BUN_TOKEN_FILE" --json >/tmp/bun-status.json && jq -e '.service.alive == true and .db.ok == true and (.config.auth_enabled // .auth.enabled) == true and .codex.command_ok == true' /tmp/bun-status.json`；`./dist/codex-issue-runner-bun system doctor --addr "$BUN_ADDR" --token-file "$BUN_TOKEN_FILE" --json >/tmp/bun-doctor.json`。 |
| Issues API | must-pass | imported projects/issues 可读；issue create/read/update/comment/events/runs/retry/cancel 行为与 Go stable 关键路径一致。 | `curl -fsS --config "$curl_auth_config" "http://$BUN_ADDR/api/issues?projectId=$SMOKE_PROJECT" -o /tmp/bun-issues.json && jq -e 'type == "array"' /tmp/bun-issues.json`；创建一次 disposable issue：`issue_json="$(./dist/codex-issue-runner-bun issue create --addr "$BUN_ADDR" --token-file "$BUN_TOKEN_FILE" --project "$SMOKE_PROJECT" --title "P08 parity smoke" --body "disposable" --status triage --json)"`，再用 `issue_id="$(jq -r '.id' <<<"$issue_json")"` 执行 `issue status/update/logs/retry/cancel` 并确认最终状态可读。 |
| Sessions API | must-pass | Sessions 页面依赖的 list/create/read/resume/interrupt API 在 Bun preview 可用，provider session id 与 turn id 能持久化到 `agent_sessions`。 | `curl -fsS --config "$curl_auth_config" "http://$BUN_ADDR/api/sessions?limit=5" >/tmp/bun-sessions.json`；用前端或 API 创建一次短 session（prompt: `Reply ok only.`），随后 `GET /api/sessions/:id`、`POST /api/sessions/:id/messages`、必要时 `POST /api/sessions/:id/interrupt`，并用 `sqlite3 "$BUN_DB" 'select session_key,status from agent_sessions order by updated_at desc limit 5;'` 核对记录存在。 |
| PI | must-pass | PI agents/settings/conversations/actions/memory API 可用；PI Chat 能完成一次最小对话；PI run-once 失败时必须是可解释的配置错误而非 5xx/崩溃。 | `curl -fsS --config "$curl_auth_config" "http://$BUN_ADDR/api/pi/agents" -o /tmp/bun-pi-agents.json && jq -e 'type == "array"' /tmp/bun-pi-agents.json`；`curl -fsS --config "$curl_auth_config" "http://$BUN_ADDR/api/projects/$SMOKE_PROJECT/pi-settings" -o /tmp/bun-pi-settings.json && jq -e 'has("project_id")' /tmp/bun-pi-settings.json`；创建/恢复一个 PI conversation 后 `POST /api/pi/conversations/:id/messages`，确认响应含 `conversation_id`、`pi_session_id` 或明确配置错误。 |
| Issue execution | must-pass | Bun preview 能 claim 一个 `todo` issue、启动 Codex executor、写 `issue_runs`、消费事件，并通过显式 `issue update --status done/failed` gate 收口。 | 创建 disposable execution issue 并 enqueue：`./dist/codex-issue-runner-bun issue create --addr "$BUN_ADDR" --token-file "$BUN_TOKEN_FILE" --project "$SMOKE_PROJECT" --title "P08 execution smoke" --body "Run: test -f docs/architecture/bun-ts-backend-rewrite-plan.md. Then update this issue done if it passes." --status todo --run --json`；轮询 `issue status`，最终必须为 `done`，并用 `GET /api/issues/:id/runs` 确认 latest run 有 provider session/turn 和 `exit_reason=explicit_status_update`。 |
| Frontend | must-pass | React frontend 指向 Bun preview 时，Projects、Issues、Issue Detail、Sessions、Settings runtime health、PI 入口均可加载；无 mock/fallback 数据冒充成功。 | `VITE_API_BASE_URL="http://$BUN_ADDR" npm --prefix frontend run build`；用浏览器或 Playwright 打开预览构建/开发页，逐页确认 Network 请求命中 `3018`，关键按钮（issue create/update/retry/cancel、session send、PI chat）返回 2xx 或受控错误。 |
| CLI | must-pass | Bun binary 的核心 CLI 可替代 Go 日常闭环：`system status/doctor/logs`、`project create`、`issue create/status/update/logs/retry/cancel`，并支持 `--addr`、`--token-file`、`--json`。 | `./dist/codex-issue-runner-bun system logs --addr "$BUN_ADDR" --token-file "$BUN_TOKEN_FILE" --lines 80 >/tmp/bun-logs.txt`，确认 `/tmp/bun-logs.txt` 不含实际 token；复用 Issues API disposable issue 验证 `issue` 子命令。 |
| Rollback | must-pass | 正式切换前已有 Go DB/Bun DB 备份、Go binary/plist 可恢复，且 preview 停止不会影响 Go stable。 | `mkdir -p data/backups/p08-cutover && cp "$GO_DB" data/backups/p08-cutover/go-runner.db && cp "$BUN_DB" data/backups/p08-cutover/bun-runner.db`；`test -x dist/codex-issue-runner`；`./scripts/uninstall-bun-launchd.sh --dry-run`；dry-run 后再次 `curl -fsS "http://$GO_ADDR/health" >/dev/null`。 |
| Observability | must-pass | preview logs、system logs、doctor 输出可用于故障定位，且 redaction 生效。 | `./scripts/deploy-bun-preview.sh --dry-run`；`./dist/codex-issue-runner-bun system logs --addr "$BUN_ADDR" --token-file "$BUN_TOKEN_FILE" --lines 120 >/tmp/bun-logs.txt`；`rg -i 'token' /tmp/bun-logs.txt; rg -i 'secret' /tmp/bun-logs.txt; rg -i 'authorization' /tmp/bun-logs.txt` 只能出现 redacted 文本或无结果。 |
| Extended frontend parity | can-defer | cron/nightly/notifications/usage/upload 等非切换核心页面若未完整迁移，不阻止 P08.05，但必须在 release notes 中隐藏入口或标注 preview limitation。 | 建 follow-up issue，列出受影响页面、API 路径、用户影响和回滚影响；P08.05 前确认主导航不会把用户引到假成功页面。 |
| Advanced PI automation | can-defer | PI auto-manage loop、action 自动 approve/execute、memory ranking 的高级体验可延后；PI Chat 与受控 action API 不能延后。 | 建 follow-up issue；`GET /api/pi/actions`、`GET /api/pi/memory` 至少可读，run-once 不得导致服务崩溃或污染 Go DB。 |
| CLI long tail | can-defer | 与正式切换无关的长尾 CLI 子命令可延后；executor 回写、issue/status/system/project 核心 CLI 不能延后。 | 在 CLI parity follow-up 中列出缺口；P08.05 release notes 写明替代 API/UI 操作。 |
| One-command rollback | can-defer | 可以先用人工 rollback runbook，不强制 P08.05 前完成一键 rollback 脚本。 | runbook 必须包含 Go launchd 恢复、Go DB backup 恢复、Bun service 停止、health/status smoke，并在维护窗口演练一次 dry-run。 |

#### P08.03 正式切换 runbook（P08.05 前置）

本 runbook 只定义正式切换步骤，不在文档编写阶段执行任何 live 切换。P08.05 执行前必须由用户在维护窗口内明确确认
一种策略；没有确认时，Go stable 继续占用 `127.0.0.1:3008`，Bun preview 继续使用
`127.0.0.1:3018`、`data-bun/`、`data-bun/runner.db`。

可选策略：

- 策略 A：停止 Go stable 后，让 Bun live 监听 `127.0.0.1:3008`。前端/CLI 仍访问原 live addr。
- 策略 B：Go stable 保持在 `127.0.0.1:3008` 作为 fallback；Bun 继续监听 `127.0.0.1:3018`，
  只把前端代理目标和默认 CLI 调用切到 Bun。

共同硬门禁：

- P08.01 的所有 `must-pass` gate 已通过并留存结果。
- P08.02 最终迁移演练已通过，`reconciliation.all_match == true`。
- 维护窗口、rollback owner、smoke 项目 id、选择的策略已经由用户确认。
- 关闭 `set -x`，所有 token 只通过 `--token-file` 或临时 curl config 使用；日志、截图、issue 评论不得输出 token/secrets。
- 切换前、切换中、失败回滚时都不得让 Bun 直接写 Go stable 正在使用的 `data/runner.db`。

维护窗口准备命令（只在用户确认后执行）：

```bash
set -euo pipefail
set +x

export GO_ADDR=127.0.0.1:3008
export GO_DB=data/runner.db
export GO_TOKEN_FILE=data/auth_token
export GO_LABEL=com.xiaobei.codex-issue-runner
export GO_PLIST="$HOME/Library/LaunchAgents/$GO_LABEL.plist"

export BUN_ADDR=127.0.0.1:3018
export BUN_STATE_DIR=data-bun
export BUN_DB=data-bun/runner.db
export BUN_TOKEN_FILE=data-bun/auth_token
export BUN_LABEL=com.xiaobei.codex-issue-runner-bun
export BUN_PLIST="$HOME/Library/LaunchAgents/$BUN_LABEL.plist"

export SMOKE_PROJECT=<已导入 Bun preview 的项目 id>
export SWITCHOVER_STRATEGY=<A 或 B>
export CUTOVER_DIR="data/backups/p08-cutover/$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$CUTOVER_DIR"
umask 077
go_curl_auth_config="$(mktemp)"
bun_curl_auth_config="$(mktemp)"
trap 'rm -f "$go_curl_auth_config" "$bun_curl_auth_config"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$GO_TOKEN_FILE")" > "$go_curl_auth_config"
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$BUN_TOKEN_FILE")" > "$bun_curl_auth_config"

printf 'Type CONFIRM_P08_SWITCHOVER_%s to continue: ' "$SWITCHOVER_STRATEGY"
read -r confirmation
test "$confirmation" = "CONFIRM_P08_SWITCHOVER_$SWITCHOVER_STRATEGY"
```

冻结写入与最终演练：

```bash
# 基线健康检查。
curl -fsS "http://$GO_ADDR/health" >/dev/null
curl -fsS "http://$BUN_ADDR/health" >/dev/null
./scripts/status-launchd.sh > "$CUTOVER_DIR/go-launchd-before.txt"
./scripts/status-bun-preview.sh > "$CUTOVER_DIR/bun-launchd-before.txt"

# 停止新 auto-run claim；人工维护窗口内也不得再创建/更新 Go issue。
curl -fsS --config "$go_curl_auth_config" "http://$GO_ADDR/api/projects" \
  -o "$CUTOVER_DIR/go-projects-before.json"
jq -r '.[] | select(.auto_run == 1) | .id' \
  "$CUTOVER_DIR/go-projects-before.json" > "$CUTOVER_DIR/go-auto-run-projects.txt"
while read -r project_id; do
  [ -n "$project_id" ] || continue
  curl -fsS -X PATCH --config "$go_curl_auth_config" \
    -H 'Content-Type: application/json' \
    -d '{"auto_run":0}' \
    "http://$GO_ADDR/api/projects/$project_id" >/dev/null
done < "$CUTOVER_DIR/go-auto-run-projects.txt"

# 不允许带着 Go in-progress issue 切换。
curl -fsS --config "$go_curl_auth_config" "http://$GO_ADDR/api/issues?status=in_progress" \
  -o "$CUTOVER_DIR/go-in-progress.json"
jq -e 'length == 0' "$CUTOVER_DIR/go-in-progress.json"

# Bun preview 也要冻结，避免最终导入时同一个 `data-bun/runner.db` 还有写入者。
curl -fsS --config "$bun_curl_auth_config" "http://$BUN_ADDR/api/projects" \
  -o "$CUTOVER_DIR/bun-projects-before.json"
jq -r '.[] | select(.auto_run == 1) | .id' \
  "$CUTOVER_DIR/bun-projects-before.json" > "$CUTOVER_DIR/bun-auto-run-projects.txt"
while read -r project_id; do
  [ -n "$project_id" ] || continue
  curl -fsS -X PATCH --config "$bun_curl_auth_config" \
    -H 'Content-Type: application/json' \
    -d '{"auto_run":0}' \
    "http://$BUN_ADDR/api/projects/$project_id" >/dev/null
done < "$CUTOVER_DIR/bun-auto-run-projects.txt"
curl -fsS --config "$bun_curl_auth_config" "http://$BUN_ADDR/api/issues?status=in_progress" \
  -o "$CUTOVER_DIR/bun-in-progress.json"
jq -e 'length == 0' "$CUTOVER_DIR/bun-in-progress.json"

# 停止 Bun preview 后再写 `data-bun/runner.db`；策略 B 会在导入后重新拉起 preview。
launchctl print "gui/$(id -u)/$BUN_LABEL" > "$CUTOVER_DIR/bun-launchd-print-before-stop.txt" 2>&1 || true
launchctl bootout "gui/$(id -u)" "$BUN_PLIST" >/dev/null 2>&1 || true

# 最终备份与迁移演练；该命令写 backup/rehearsal 目录，不写 Go live DB。
./dist/codex-issue-runner-bun db rehearse-final-migration \
  --go-db "$GO_DB" \
  --bun-db "$BUN_DB" \
  --backup-dir "$CUTOVER_DIR" \
  --json > "$CUTOVER_DIR/final-rehearsal.json"
jq -e '.ok == true and .reconciliation.all_match == true' "$CUTOVER_DIR/final-rehearsal.json"

# 最终导入只允许 Go -> Bun，不允许 Bun 写 Go DB。
test "$BUN_DB" != "$GO_DB"
./dist/codex-issue-runner-bun db import-go \
  --source "$GO_DB" \
  --target "$BUN_DB" \
  --json > "$CUTOVER_DIR/final-import.json"
jq -e '.source_readonly == true and .source_mtime_unchanged == true' "$CUTOVER_DIR/final-import.json"
```

策略 A：Bun 接管 `127.0.0.1:3008`

适用场景：希望所有现有前端/CLI 默认入口继续使用 `3008`。该策略必须先停止 Go stable；不得在 Go 仍监听
`3008` 时启动 Bun live。现有 `scripts/install-bun-launchd.sh` 是 preview 脚本，带有拒绝 `3008` 的安全护栏；
策略 A 使用单独可审查的 live plist，不复用 preview install 脚本抢占端口。

```bash
test "$SWITCHOVER_STRATEGY" = "A"

# 构建并 stage Bun live binary，不覆盖 Go stable binary。
(cd backend-ts && bun run build:binary)
export BUN_LIVE_LABEL=com.xiaobei.codex-issue-runner-bun-live
export BUN_LIVE_PLIST="$HOME/Library/LaunchAgents/$BUN_LIVE_LABEL.plist"
export BUN_LIVE_BINARY="$(pwd)/data-bun/bin/codex-issue-runner-bun-live"
mkdir -p "$(dirname "$BUN_LIVE_BINARY")" "$(pwd)/data-bun/logs"
install -m 0755 dist/codex-issue-runner-bun "$BUN_LIVE_BINARY"

# 停止 Go stable，确认 3008 已释放。
launchctl print "gui/$(id -u)/$GO_LABEL" > "$CUTOVER_DIR/go-launchd-print-before-stop.txt" 2>&1 || true
launchctl bootout "gui/$(id -u)" "$GO_PLIST" >/dev/null 2>&1 || true
for _ in {1..40}; do
  ! lsof -nP -iTCP:3008 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.5
done
! lsof -nP -iTCP:3008 -sTCP:LISTEN

# 写入 Bun live launchd plist。注意：DB/token/state-dir 全部仍指向 data-bun。
python3 - <<'PY'
import os
import plistlib
from pathlib import Path

root = Path.cwd()
plist = {
    "Label": os.environ["BUN_LIVE_LABEL"],
    "Program": os.environ["BUN_LIVE_BINARY"],
    "ProgramArguments": [
        os.environ["BUN_LIVE_BINARY"],
        "serve",
        "--addr", os.environ["GO_ADDR"],
        "--state-dir", str(root / os.environ["BUN_STATE_DIR"]),
        "--db", str(root / os.environ["BUN_DB"]),
        "--auth-token-file", str(root / os.environ["BUN_TOKEN_FILE"]),
    ],
    "EnvironmentVariables": {
        "HOME": os.environ["HOME"],
        "PATH": os.environ["PATH"],
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "StandardOutPath": str(root / "data-bun/logs/live.out.log"),
    "StandardErrorPath": str(root / "data-bun/logs/live.err.log"),
}
with open(os.environ["BUN_LIVE_PLIST"], "wb") as f:
    plistlib.dump(plist, f)
PY
plutil -lint "$BUN_LIVE_PLIST"
launchctl bootstrap "gui/$(id -u)" "$BUN_LIVE_PLIST"
launchctl enable "gui/$(id -u)/$BUN_LIVE_LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$(id -u)/$BUN_LIVE_LABEL"
```

策略 A 验证：

```bash
curl -fsS "http://$GO_ADDR/health" >/dev/null
./dist/codex-issue-runner-bun system status \
  --addr "$GO_ADDR" \
  --token-file "$BUN_TOKEN_FILE" \
  --json > "$CUTOVER_DIR/bun-live-status.json"
jq -e '.service.runtime == "bun" and .db.ok == true and (.auth.enabled == true)' \
  "$CUTOVER_DIR/bun-live-status.json"

curl -fsS --config "$bun_curl_auth_config" "http://$GO_ADDR/api/issues?projectId=$SMOKE_PROJECT" \
  -o "$CUTOVER_DIR/bun-live-issues.json"
jq -e 'type == "array"' "$CUTOVER_DIR/bun-live-issues.json"

smoke_issue_json="$(./dist/codex-issue-runner-bun issue create \
  --addr "$GO_ADDR" \
  --token-file "$BUN_TOKEN_FILE" \
  --project "$SMOKE_PROJECT" \
  --title "P08 strategy A smoke" \
  --body "Runbook smoke; mark done after review." \
  --status triage \
  --json)"
smoke_issue_id="$(jq -r '.id' <<<"$smoke_issue_json")"
./dist/codex-issue-runner-bun issue update \
  --addr "$GO_ADDR" \
  --token-file "$BUN_TOKEN_FILE" \
  --id "$smoke_issue_id" \
  --status done \
  --json > "$CUTOVER_DIR/strategy-a-smoke-issue.json"

# 浏览器验证：打开 live UI，Projects / Issues / Issue Detail / Sessions / PI 入口必须可用。
# 如果 Bun live binary 尚未服务前端静态资源，必须有同源前端代理；否则策略 A 判失败并回滚。
```

策略 A 失败判定：

- `3008` 在停止 Go 后仍被非预期进程占用。
- `system status` 不显示 Bun runtime、DB 不可用、auth 不可用，或 API 返回 5xx。
- `final-import.json` 显示 Go source mtime 改变，或 Bun DB 路径等于 Go DB 路径。
- frontend 主入口不可用、SSE/issue execution/PI smoke 失败，或需要输出 token 才能诊断。

策略 A rollback：

```bash
launchctl bootout "gui/$(id -u)" "$BUN_LIVE_PLIST" >/dev/null 2>&1 || true
rm -f "$BUN_LIVE_PLIST"

# 如 final import 或 Bun live 写入导致 Bun DB 污染，恢复 Bun backup；Go DB 正常情况下不需要恢复。
cp "$CUTOVER_DIR/bun-runner.db" "$BUN_DB"

launchctl bootstrap "gui/$(id -u)" "$GO_PLIST"
launchctl enable "gui/$(id -u)/$GO_LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$(id -u)/$GO_LABEL"
curl -fsS "http://$GO_ADDR/health" >/dev/null
./dist/codex-issue-runner system status \
  --addr "$GO_ADDR" \
  --token-file "$GO_TOKEN_FILE" \
  --json > "$CUTOVER_DIR/go-rollback-status.json"

while read -r project_id; do
  [ -n "$project_id" ] || continue
  curl -fsS -X PATCH --config "$go_curl_auth_config" \
    -H 'Content-Type: application/json' \
    -d '{"auto_run":1}' \
    "http://$GO_ADDR/api/projects/$project_id" >/dev/null
done < "$CUTOVER_DIR/go-auto-run-projects.txt"
```

策略 B：前端/CLI 默认指向 Bun preview

适用场景：不动 Go stable live port，让 Go 继续作为 fallback；只把操作者入口和前端代理切到 Bun。该策略不停止
Go stable，不让 Bun 监听 `3008`。

```bash
test "$SWITCHOVER_STRATEGY" = "B"

# 重新拉起已冻结的 Bun preview；Go stable 仍保持在 3008。
launchctl bootstrap "gui/$(id -u)" "$BUN_PLIST" >/dev/null 2>&1 || true
launchctl enable "gui/$(id -u)/$BUN_LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$(id -u)/$BUN_LABEL"

curl -fsS "http://$GO_ADDR/health" >/dev/null
curl -fsS "http://$BUN_ADDR/health" >/dev/null

# 前端本地 live 入口使用同源 Vite proxy 指向 Bun，避免跨源 EventSource 无法带 Authorization header。
VITE_API_TARGET="http://$BUN_ADDR" npm --prefix frontend run build
VITE_API_TARGET="http://$BUN_ADDR" \
  npm --prefix frontend run preview -- --host 127.0.0.1 --port 3568 \
  > "$CUTOVER_DIR/frontend-preview.log" 2>&1 &
echo $! > "$CUTOVER_DIR/frontend-preview.pid"

# CLI 默认使用 Bun binary 和 Bun token file；不要依赖 PATH 上可能仍指向 Go 的旧 wrapper。
export CODEX_RUNNER_BUN_ADDR="$BUN_ADDR"
export CODEX_RUNNER_BUN_AUTH_TOKEN_FILE="$BUN_TOKEN_FILE"
./dist/codex-issue-runner-bun system status --json > "$CUTOVER_DIR/bun-cli-status.json"
jq -e '.service.runtime == "bun" and .db.ok == true and (.auth.enabled == true)' \
  "$CUTOVER_DIR/bun-cli-status.json"
```

策略 B 验证：

```bash
# Go fallback 仍可用。
./dist/codex-issue-runner system status \
  --addr "$GO_ADDR" \
  --token-file "$GO_TOKEN_FILE" \
  --json > "$CUTOVER_DIR/go-fallback-status.json"

# 前端代理入口命中 Bun。
curl -fsS "http://127.0.0.1:3568/health" >/dev/null
curl -fsS --config "$bun_curl_auth_config" "http://127.0.0.1:3568/api/system/status" \
  -o "$CUTOVER_DIR/frontend-proxy-status.json"
jq -e '.service.runtime == "bun" and .db.ok == true' "$CUTOVER_DIR/frontend-proxy-status.json"

# Bun CLI issue smoke。
smoke_issue_json="$(./dist/codex-issue-runner-bun issue create \
  --project "$SMOKE_PROJECT" \
  --title "P08 strategy B smoke" \
  --body "Runbook smoke; mark done after review." \
  --status triage \
  --json)"
smoke_issue_id="$(jq -r '.id' <<<"$smoke_issue_json")"
./dist/codex-issue-runner-bun issue update \
  --id "$smoke_issue_id" \
  --status done \
  --json > "$CUTOVER_DIR/strategy-b-smoke-issue.json"

# 浏览器验证：打开 http://127.0.0.1:3568，Network 中 /api 与 /api/events 必须经同源 proxy 到 Bun。
```

策略 B 失败判定：

- Go fallback 不可用，或 Bun preview 不可用。
- 前端 Network 仍命中 Go `3008`，或 `/api/events` 因跨源/auth 失败。
- Bun CLI 未默认连到 `3018`，或 status/issue smoke 失败。
- 任何 smoke 需要输出 token 才能继续诊断。

策略 B rollback：

```bash
if [ -f "$CUTOVER_DIR/frontend-preview.pid" ]; then
  kill "$(cat "$CUTOVER_DIR/frontend-preview.pid")" >/dev/null 2>&1 || true
fi
unset CODEX_RUNNER_BUN_ADDR CODEX_RUNNER_BUN_AUTH_TOKEN_FILE

# 如 Bun DB 被 smoke 污染且需要完全回退，先停止 Bun preview，再恢复 Bun backup；Go stable 未停止也未写入。
launchctl bootout "gui/$(id -u)" "$BUN_PLIST" >/dev/null 2>&1 || true
cp "$CUTOVER_DIR/bun-runner.db" "$BUN_DB"

curl -fsS "http://$GO_ADDR/health" >/dev/null
./dist/codex-issue-runner system status \
  --addr "$GO_ADDR" \
  --token-file "$GO_TOKEN_FILE" \
  --json > "$CUTOVER_DIR/go-after-strategy-b-rollback.json"

while read -r project_id; do
  [ -n "$project_id" ] || continue
  curl -fsS -X PATCH --config "$go_curl_auth_config" \
    -H 'Content-Type: application/json' \
    -d '{"auto_run":1}' \
    "http://$GO_ADDR/api/projects/$project_id" >/dev/null
done < "$CUTOVER_DIR/go-auto-run-projects.txt"

# 如果仍需要保留 Bun preview，可在 rollback 完成并确认 Go 可用后重新执行：
# ./scripts/deploy-bun-preview.sh
```

最终成功记录：

- 保存 `final-rehearsal.json`、`final-import.json`、strategy smoke JSON、launchd/status 输出到 `$CUTOVER_DIR`。
- smoke 全部通过且用户确认恢复自动执行后，把 `$CUTOVER_DIR/go-auto-run-projects.txt` 中原本开启的项目在
  当前 Bun active addr 上逐个 `PATCH {"auto_run":1}`；恢复前不得让新 issue 自动 claim。
- 在 release notes 中写明实际采用策略、维护窗口起止时间、rollback 文件位置、已知 can-defer 项。
- 只有上述验证全部通过，才可把 P08.05 标记为切换成功；否则执行对应 rollback，不得宣称已切换完成。

恢复自动执行命令（仅在 smoke 全部通过且用户确认后）：

```bash
if [ "$SWITCHOVER_STRATEGY" = "A" ]; then
  ACTIVE_ADDR="$GO_ADDR"
else
  ACTIVE_ADDR="$BUN_ADDR"
fi
while read -r project_id; do
  [ -n "$project_id" ] || continue
  curl -fsS -X PATCH --config "$bun_curl_auth_config" \
    -H 'Content-Type: application/json' \
    -d '{"auto_run":1}' \
    "http://$ACTIVE_ADDR/api/projects/$project_id" >/dev/null
done < "$CUTOVER_DIR/go-auto-run-projects.txt"
```

#### P08.04 rollback runbook 与 dry-run 验证（P08.05 前置）

本 runbook 只用于切换失败后的人工 rollback，以及正式切换前的 dry-run 验证。dry-run 阶段不得修改 live
主入口、不得停止 Go stable、不得把 Bun 指向 `127.0.0.1:3008`、不得直接写 Go stable 正在使用的 DB。

rollback 触发条件：

- 策略 A 切换后 `3008/health`、`system status`、issues/sessions/PI/issue execution 任一 must-pass smoke 失败。
- 策略 B 切换后 Bun preview 或前端代理 smoke 失败，或需要立即恢复操作者默认入口到 Go stable。
- 发现 Bun DB 路径等于 Go DB 路径、Go source DB mtime 被导入流程改变、诊断需要输出 token/secrets，或 rollback owner 要求中止。

准备变量（执行真实 rollback 前设置；dry-run 也复用这些变量）：

```bash
set -euo pipefail
set +x

export GO_ADDR=127.0.0.1:3008
export GO_LABEL=com.xiaobei.codex-issue-runner
export GO_PLIST="$HOME/Library/LaunchAgents/$GO_LABEL.plist"
export GO_BINARY=dist/codex-issue-runner
export GO_STAGED_BINARY="$(pwd)/data/bin/codex-issue-runner"
export GO_TOKEN_FILE=data/auth_token
# 以 Go launchd plist 为准；不要假设固定是 data/runner.db。
export GO_DB="$(python3 - "$GO_PLIST" <<'PY'
import plistlib, sys
args = plistlib.load(open(sys.argv[1], "rb")).get("ProgramArguments", [])
print(args[args.index("--db") + 1] if "--db" in args else "")
PY
)"
test -n "$GO_DB"
export GO_DB_BACKUP="<CUTOVER_DIR 中保留的 go-runner.db 或等价备份路径>"

export BUN_ADDR=127.0.0.1:3018
export BUN_LABEL=com.xiaobei.codex-issue-runner-bun
export BUN_PLIST="$HOME/Library/LaunchAgents/$BUN_LABEL.plist"
export BUN_LIVE_LABEL=com.xiaobei.codex-issue-runner-bun-live
export BUN_LIVE_PLIST="$HOME/Library/LaunchAgents/$BUN_LIVE_LABEL.plist"
export BUN_DB=data-bun/runner.db
export BUN_DB_BACKUP="<CUTOVER_DIR 中保留的 bun-runner.db 或等价备份路径>"
export CUTOVER_DIR="<P08.03 生成的 cutover 目录>"
```

策略 B / Go stable 未停止时的轻量 rollback：停止 Bun preview 或前端 preview，取消 Bun 相关环境变量，验证
`127.0.0.1:3008` 的 Go stable 仍可用；不得覆盖 Go DB。若 Bun smoke 污染了 `data-bun/runner.db`，只在停止 Bun
preview 后恢复 `$BUN_DB_BACKUP` 到 `$BUN_DB`。

策略 A / live `3008` 已切到 Bun 后的 rollback 步骤（只在维护窗口内由 rollback owner 明确确认后执行）：

```bash
# 0. 前置检查：Go binary、Go DB backup、Go plist 都必须存在；备份至少保留一个稳定周期。
test -x "$GO_BINARY"
test -f "$GO_DB_BACKUP"
test -f "$GO_PLIST"
test "$GO_DB" != "$BUN_DB"

# 1. 停止 Bun service。策略 A 使用 bun-live label；preview label 也允许幂等停止，避免残留 Bun 写入者。
launchctl bootout "gui/$(id -u)" "$BUN_LIVE_PLIST" >/dev/null 2>&1 || true
rm -f "$BUN_LIVE_PLIST"
launchctl bootout "gui/$(id -u)" "$BUN_PLIST" >/dev/null 2>&1 || true

# 2. 恢复 Go DB backup。只有确认 live 3008 已释放且 GO_DB 指向真实 Go DB 后，才覆盖 Go DB。
if lsof -nP -iTCP:3008 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "refusing to restore Go DB while port 3008 is still serving; stop Bun/Go first" >&2
  exit 1
fi
install -m 0600 "$GO_DB_BACKUP" "$GO_DB"

# 3. launchd 指回 Go dist/staged binary 并启动 Go service。
# 源码部署的 Go plist 应指向 data/bin/codex-issue-runner；先把保留的 Go dist binary stage 回去。
go_plist_program="$(python3 - "$GO_PLIST" <<'PY'
import plistlib, sys
print(plistlib.load(open(sys.argv[1], "rb")).get("Program", ""))
PY
)"
test "$go_plist_program" = "$GO_STAGED_BINARY"
install -m 0755 "$GO_BINARY" "$GO_STAGED_BINARY"
launchctl bootstrap "gui/$(id -u)" "$GO_PLIST" >/dev/null 2>&1 || true
launchctl enable "gui/$(id -u)/$GO_LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$(id -u)/$GO_LABEL"

# 4. smoke：Go stable 必须重新服务 live 主入口；输出不得包含 token。
curl -fsS "http://$GO_ADDR/health" >/dev/null
./dist/codex-issue-runner system status \
  --addr "$GO_ADDR" \
  --token-file "$GO_TOKEN_FILE" \
  --json > "$CUTOVER_DIR/go-rollback-status.json"
jq -e '.service.runtime != "bun" and .db.ok == true' "$CUTOVER_DIR/go-rollback-status.json"
./scripts/status-launchd.sh > "$CUTOVER_DIR/go-launchd-after-rollback.txt"
```

rollback 后处理：

- 不要删除 `dist/codex-issue-runner`、`data/bin/codex-issue-runner`、`$GO_DB_BACKUP`、`$BUN_DB_BACKUP` 或 `$CUTOVER_DIR`；至少保留一个稳定周期。
- 在 Go smoke 通过前，不恢复任何 auto-run 项目，也不重新启动 Bun preview。
- 策略 B 轻量 rollback 不覆盖 Go DB；只有策略 A 或 Go stable 已停止的正式切换失败，才执行 Go DB restore。
- 如需恢复 auto-run，只对 `$CUTOVER_DIR/go-auto-run-projects.txt` 中原本开启的项目执行，并用 Go token file 访问 `$GO_ADDR`。
- 如需保留 Bun preview，必须等 Go stable smoke 通过后重新执行 `./scripts/deploy-bun-preview.sh`；不得复用 rollback 中停止前的未知状态。

dry-run 验证（可在当前并行预览期执行；不得改 live 主入口）：

```bash
set -euo pipefail
set +x

export GO_ADDR=127.0.0.1:3008
export GO_LABEL=com.xiaobei.codex-issue-runner
export GO_PLIST="$HOME/Library/LaunchAgents/$GO_LABEL.plist"
export GO_BINARY=dist/codex-issue-runner
export GO_DB="$(python3 - "$GO_PLIST" <<'PY'
import plistlib, sys
args = plistlib.load(open(sys.argv[1], "rb")).get("ProgramArguments", [])
print(args[args.index("--db") + 1] if "--db" in args else "")
PY
)"
export BUN_ADDR=127.0.0.1:3018
export BUN_LABEL=com.xiaobei.codex-issue-runner-bun
export BUN_DB=data-bun/runner.db

# 1. 读取状态，不停止/启动任何 live 服务。
./scripts/status-launchd.sh || true
./scripts/status-bun-preview.sh --dry-run
./scripts/uninstall-bun-launchd.sh --dry-run

# 2. 校验路径隔离与 rollback 依赖。
test -x "$GO_BINARY"
test -f "$GO_PLIST"
test -n "$GO_DB"
test "${BUN_ADDR##*:}" != "3008"
test "$BUN_LABEL" != "$GO_LABEL"
test "$GO_DB" != "$BUN_DB"
test "$BUN_DB" != "data/runner.db"
test "$BUN_DB" != "data/app.db"
case "$GO_DB" in *data-bun/*) echo "Go DB points into data-bun; abort" >&2; exit 1 ;; esac

# 3. 如已有 cutover 目录，用备份文件做只读检查；不覆盖 live DB。
if [ -n "${CUTOVER_DIR:-}" ]; then
  test -f "$CUTOVER_DIR/go-runner.db"
  test -f "$CUTOVER_DIR/bun-runner.db"
fi

# 4. 生成 Bun preview plist dry-run，验证不会抢占 Go stable。
CODEX_RUNNER_BUN_ADDR="$BUN_ADDR" \
CODEX_RUNNER_BUN_DB="$BUN_DB" \
CODEX_RUNNER_BUN_LAUNCHD_LABEL="$BUN_LABEL" \
  ./scripts/install-bun-launchd.sh --dry-run

# 5. dry-run 后 Go live 入口仍应可用；若本机未运行 Go stable，可记录为环境未验证，不得标记切换成功。
curl -fsS "http://$GO_ADDR/health" >/dev/null
```

dry-run 通过标准：

- 所有命令只读取状态或使用 `--dry-run`，不会 `bootout` Go stable、不会写 Go DB、不会安装 Bun live plist。
- Go stable 的 `127.0.0.1:3008/health` 在 dry-run 前后均可用。
- Bun dry-run 输出 label 仍为 `com.xiaobei.codex-issue-runner-bun`，addr 仍为 `127.0.0.1:3018`，DB 仍为 `data-bun/runner.db`。
- Go binary 和 Go DB backup 路径明确；备份保留策略写入 release notes 或 cutover 记录。

## 12. 回滚策略

直到 Phase 8 显式切换完成并稳定运行前，Go 服务不删除、不停用、不迁移端口。

回滚方式见 P08.04 runbook；摘要如下：

```text
Go stable 未切换前：直接停止 Bun preview，不影响 Go，不覆盖 Go DB。

正式切换后：
停止 Bun service
launchd 指回 Go dist/staged binary
恢复 Go DB backup
启动 Go service
health/status smoke 通过后再恢复 auto-run
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
