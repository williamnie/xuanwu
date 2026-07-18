# OpenConnector 与 PI Assistant Inbox 接入价值调研

> [!WARNING]
> **历史调研（2026-07-19 归档）**：本文保留外部产品研究 provenance，不是当前 connector 或 inbox 规范。当前 source of truth 见 [canonical 架构文档索引](README.md)、[Provider / Connections](xuanwu/0059-provider-presets-connections.md)、[Channel / Connector 合同](xuanwu/0064-channel-connector-contract.md) 与 [Connector Diagnostics](xuanwu/0076-connector-health-secrets-diagnostics.md)。

> 日期：2026-07-09
> Issue：#617
> 范围：只读调研与建议；不改 public schema、runtime 状态机、provider adapter 或根配置。
> 结论摘要：**OpenConnector 不等同于 codex-issue-runner 的 inbox**。OpenConnector 更像外部 SaaS 账号授权、Action catalog、MCP/HTTP/SDK/CLI 执行网关；当前/规划中的 PI Assistant inbox 是“外部事件 → 上下文包 → LLM intake → 待处理事项 → proposal/approval”的工作流入口。两者互补：OpenConnector 可以成为 PI Tool Provider / Source Pull Provider，向 `external_events` 和 action proposal 执行层提供外部系统能力。

## 1. 调研材料

### OpenConnector 官方材料

- GitHub README：<https://github.com/oomol-lab/open-connector>
- Runtime API and MCP：<https://github.com/oomol-lab/open-connector/blob/main/docs/runtime-api.md>
- Credentials and OAuth：<https://github.com/oomol-lab/open-connector/blob/main/docs/credentials.md>
- Configuration：<https://github.com/oomol-lab/open-connector/blob/main/docs/configuration.md>
- SDK and CLI：<https://github.com/oomol-lab/open-connector/blob/main/docs/sdk-cli.md>
- Catalog format：<https://github.com/oomol-lab/open-connector/blob/main/docs/catalog-format.md>
- Cloudflare deployment：<https://github.com/oomol-lab/open-connector/blob/main/docs/cloudflare.md>
- Quickstart：<https://github.com/oomol-lab/open-connector/blob/main/docs/quickstart.md>

### codex-issue-runner 本仓库证据

- PI Runtime Roadmap：`docs/architecture/2026-07-06-pi-assistant-runtime-roadmap.md:1-50`、`:52-73`、`:243-270`、`:367-476`
- Raw / context / intake / inbox schema：`backend-ts/src/db/schema/021_external_events.ts:21-51`、`backend-ts/src/db/schema/033_context_bundles.ts:5-24`、`backend-ts/src/db/schema/034_intake_runs.ts:5-60`
- Repository 层：`backend-ts/src/db/repositories/externalEvents.ts:53-75`、`:109-135`、`:214-218`；`backend-ts/src/db/repositories/contextBundles.ts:57-68`、`:86-113`；`backend-ts/src/db/repositories/intakeRuns.ts:91-180`、`:199-219`；`backend-ts/src/db/repositories/attentionInboxItemUpsert.ts:14-37`
- Intake / routing / automation：`backend-ts/src/pi/llmIntake.ts:120-170`、`backend-ts/src/pi/intakeSkillInput.ts:48-84`、`backend-ts/src/pi/eventRouter.ts:64-154`、`backend-ts/src/pi/manualTrigger.ts:62-99`、`backend-ts/src/pi/manualSourcePull.ts:53-85`、`backend-ts/src/pi/automationRunner.ts:26-61`
- Feishu / IM intake：`docs/feishu-im-connector-contract.md:1-63`、`docs/feishu-im-local-smoke.md:1-81`、`backend-ts/src/http/feishuEventsApi.ts:49-121`、`backend-ts/src/integrations/feishuIngest.ts:44-70`、`:105-144`、`backend-ts/src/integrations/feishuIntakeBridge.ts:31-58`
- API / UI / Activity：`backend-ts/src/http/piApi.ts:60-89`、`backend-ts/src/http/piAttentionInboxApi.ts:27-40`、`:86-128`、`:201-206`、`frontend/src/api/client.js:213-223`、`:280-323`、`frontend/src/pages/AttentionInbox.jsx:28-49`、`:101-168`、`frontend/src/pages/ActivityTimelinePanel.jsx:34-40`、`:74-113`
- Tool Provider / Connector 基础：`backend-ts/src/pi/toolProviderEnvelope.ts:1-42`、`backend-ts/src/pi/cliConnectorManifest.ts:24-28`、`:77-95`、`:126-149`、`backend-ts/src/pi/cliConnectorProvider.ts:59-69`、`:182-226`、`backend-ts/src/pi/cliToolRunner.ts:62-82`、`:165-180`、`backend-ts/src/pi/mcpToolProvider.ts:27-64`、`backend-ts/src/pi/httpToolProvider.ts:3-31`、`backend-ts/src/pi/cliRawEventSync.ts:24-37`、`:45-70`
- 已有 issue 线索：本地 issue #616 已完成，主题是“调研 codex-issue-runner 的 inbox 能力与对接可行性”；#617 是在 #616 内部 inbox 调研基础上补 OpenConnector 对比。

## 2. OpenConnector 概述

OpenConnector 的定位是 **AI Agent connector gateway / auth gateway**：用户连接一次外部应用账号后，Agent 或应用可以通过统一 Action catalog 调用外部 SaaS 能力。README 明确把它描述为 Composio 替代方向，并强调 1,000+ providers、9,400+ prebuilt Actions、Connector SDK、oo CLI、MCP、HTTP/OpenAPI、Web Console、自托管/Cloudflare/OOMOL hosted 等入口。

关键能力：

1. **Provider / Action catalog**
   - Provider 定义在 `src/providers/*/definition.ts`，executor 在 `src/providers/*/executors.ts`，运行时 catalog 会暴露是否本地可执行、是否仅 catalog、是否需要 credential、required scopes / provider permissions。
   - 这说明 OpenConnector 的核心抽象是“可发现、可鉴权、可执行的 provider action”，不是消息 inbox。

2. **Credential / OAuth / runtime token 边界**
   - Local Node runtime 把 connection、OAuth client config、pending OAuth states、recent run logs 放在 SQLite；Cloudflare runtime 放在 D1/R2。
   - 支持 `no_auth`、`api_key`、`custom_credential`、`oauth2`。
   - 可通过 `OOMOL_CONNECT_ENCRYPTION_KEY` 对 provider credentials / OAuth client secrets 做 AES-256-GCM 加密；没有 key 时仍可本地开发，但数据库需当敏感文件处理。
   - `/api`、Web Console、docs 使用 admin token；`/v1` 和 `/mcp` 使用 runtime token。persistent runtime token 只存 hash。
   - action allow/block policy 通过 `OOMOL_CONNECT_ALLOWED_ACTIONS` / `OOMOL_CONNECT_BLOCKED_ACTIONS`，proxy 另有 allow/block。

3. **接入面**
   - SDK：TypeScript client，适合 app / agent runtime 从代码调用 actions。
   - oo CLI：本地 agent relay，可以 search / schema / run connector actions。
   - MCP：`POST /mcp`，暴露 `list_apps`、`search_actions`、`get_action_guide`、`execute_action` 等 discovery-oriented tools。
   - HTTP / OpenAPI：`/v1/actions/*` 执行，`/openapi.json` 导入或生成引用。
   - Web Console：浏览 providers、配置 credentials、创建 runtime tokens、调试 actions、查看 recent runs。

4. **部署形态**
   - Local Docker / Node runtime：SQLite + MCP + HTTP + OpenAPI + Web Console。
   - Cloudflare Workers：Workers + D1 + R2 + Static Assets。
   - OOMOL hosted runtime：hosted auth/runtime，保留同一 provider/action contract，后续可迁回 self-host。

## 3. codex-issue-runner Inbox 现状

### 3.1 目标架构与产品心智

`docs/architecture/2026-07-06-pi-assistant-runtime-roadmap.md` 已把长期目标定义为“多来源输入、LLM-first intake、attention inbox、skills、automation、approval、memory”的通用底座，且明确：

```text
外部来源/CLI/MCP/API
  → Tool Provider / Connector
  → Source Refs / Process Cache / Attachments
  → Context Bundle Builder
  → LLM Intake Run
  → Attention Inbox Item
  → Domain Skill
  → Action Proposal
  → Permission / Approval
  → Runner Issue / Executor / 外部回复 / Reminder / Memory
  → Activity / Audit
```

该 roadmap 同时约束：外部来源不能硬编码为钉钉/飞书/GitHub 特例；raw-first、inbox-after-intake；manual 与 automation 走同一链路；Inbox Item 不限 issue，创建 issue 只是 proposal 的一种；外部回复默认 opt-in / draft / approval。

### 3.2 数据模型

当前 schema 已落地以下核心对象：

- `external_events`：外部事实入口，字段包括 `source`、`provider`、`external_id`、`event_type`、`actor`、`content`、`trust_level`、`dedupe_key`、`raw_payload_ref`、`raw_json`、`attachments_json`、`normalized_message_json`、`project_id`、`status`、`summary_json`，默认 `status='inbox'`，并按 source/dedupe、source/external_id 建索引。
- `context_bundles`：把 raw events / attachments 按窗口、trigger、source_query、evidence_refs 聚合成 LLM intake 输入。
- `intake_runs`：记录 intake skill 运行状态、model/policy、输入摘要、schema output、ignored groups、error。
- `attention_inbox_items`：保存 title、summary、primary/secondary intents、suggested_actions、confidence、urgency、evidence_refs、actor_refs、target_hints、status；默认 `status='new'`。
- `pi_action_proposals`：从 inbox item / domain skill 生成可审批动作，动作包括 issue、message reply、ask_user、watch、memory 等；状态是 `proposed/approved/rejected`。

### 3.3 入口与后台流程

当前已存在 4 条关键链路：

1. **Feishu / IM ingest**
   - `/api/integrations/feishu/events` 收 callback，做 challenge/token/signature、approval/action card、project selection，再把普通消息送入 `ingestFeishuMessageEvent()`。
   - `ingestFeishuMessageEvent()` 归一化 Feishu message、计算 attention decision、写入 `external_events`，并根据 decision 写 status：`ignored`、`needs_project`、`blocked_by_policy`、`inbox_only` 或 mapped/default。
   - 若配置 `feishuIntakeModel`，`routeFeishuMessageToGenericIntake()` 会把 Feishu raw event 送入通用 `routeRawEventToIntake()`，随后可继续 domain skill。

2. **手动上下文 intake**
   - `runManualContextIntake()` 支持用户主动说“看刚刚群里的截图和消息”：先解析 source/time/attachment hints；必要时用 `pullManualSourceEvents()` 从 read-only connector 拉取外部事件；再 select events、persist context bundle、run intake skill、生成 domain proposals。
   - `manualSourcePull` 会从 Tool Registry 找 permission=`read` 且 output_schema 含 `events` 或 metadata `source_contract=raw_events` 的 pull tool，调用后通过 `syncCliRawEvents()` 写入 `external_events`。

3. **Automation / continuous pipeline**
   - `runPiAutomationPipeline()` 从指定 source 取未处理事件，按 step 创建 context bundle、route intake、route domain skill，写 cursor/watermark。
   - `eventRouter` 通过 source policy 控制 `manual_only`、`mention_only`、`scheduled_llm_triage`、`continuous_llm_triage`，并按 `observe_only`、`draft_only`、`propose_actions`、`auto_low_risk` 控制下一步。

4. **Domain skill / proposal / approval**
   - `routeInboxItemToDomainSkill()` 和 `runDomainSkillAndMarkProposal()` 把 `attention_inbox_items` 转成 `pi_action_proposals`，并把 item 标记为 `proposal_created`。
   - Proposal API 支持 list/create/get/approve/reject；approve 后进入受控执行，不直接由 intake 写外部系统。

### 3.4 API、UI 与可观测性

- `registerPiRoutes()` 已注册 attention inbox、action proposals、activity、automations、source policies、tool registry、MCP registry、skills、memory 等 API。
- `registerPiAttentionInboxRoutes()` 暴露：
  - Raw events：`GET /api/pi/attention-inbox/raw-events`、`GET /raw-events/:id`
  - Context bundles：`GET /context-bundles`、`GET /context-bundles/:id`
  - Intake runs：`GET /intake-runs`、`GET /intake-runs/:id`
  - Inbox items：`GET /items`、`GET /items/:id`、`PATCH /items/:id`、ignore/reintake/domain-skill
- 前端 `AttentionInbox.jsx` 已提供 Inbox 列表、状态筛选、triage/domain skill/re-intake/ignore 操作，以及 raw event/context bundle/intake run evidence trace。
- `ActivityTimelinePanel.jsx` 与 `/api/pi/activity` 用于串联 raw event、context bundle、intake run、inbox item、domain skill、proposal、policy、issue/reply。
- Connectors 设置页当前是 connector slots / health / Feishu settings；还不是 OpenConnector 管理台。

### 3.5 Tool Provider / Connector 基础

当前仓库已有一套 provider-neutral tool envelope：`builtin | cli | mcp | http | browser`，tool 有 `permission: read | write | dangerous`、schema、timeout、audit redact。

已落地能力与 OpenConnector 相关性：

- **CLI connector manifest**：可把任意本地/sandbox CLI 描述成 `cli` Tool Provider；auth/env 只声明变量，不保存 token；commands 会映射为 `AssistantTool`。
- **CLI runner**：使用 `spawn`，`shell:false`，JSON stdout，timeout，stderr 摘要，secret redaction。
- **Raw event sync**：CLI 输出如包含 `events[]`，可通过 `syncCliRawEvents()` 映射成 `external_events`。
- **MCP provider**：已有 registry / provider 映射 / tool call audit，但当前 MCP transport 是 stdio command；OpenConnector 的 HTTP MCP endpoint 不能直接无缝接入，除非加 HTTP MCP transport 或用代理命令包装。
- **HTTP provider**：当前是 read-only `url_fetch`（GET/HEAD），不能直接 POST `/v1/actions/:actionId` 执行 OpenConnector Action。

## 4. 两者是否“差不多”

不差不多，但有重叠层。

| 维度 | OpenConnector | codex-issue-runner Inbox | 判断 |
| --- | --- | --- | --- |
| 核心定位 | 外部账号授权 + provider/action gateway | 事件/上下文/待处理事项 intake 工作流 | 不同 |
| 核心对象 | provider、connection、action、runtime token、run log | external_event、context_bundle、intake_run、attention_inbox_item、proposal | 不同 |
| Agent 接入 | SDK、oo CLI、MCP、HTTP/OpenAPI | Tool Provider registry、CLI/MCP/HTTP/browser/builtin、PI APIs | 部分重叠 |
| 鉴权凭据 | 负责 provider credentials / OAuth / runtime tokens / scopes | 只声明或消费 connector env/token，不集中托管第三方 OAuth | OpenConnector 更强 |
| 事件 inbox | 没有“待处理事项”语义；更多是 action discovery/execution 和 run logs | 明确 raw-first、LLM intake、inbox-after-intake | Inbox 是本仓库强项 |
| 上下文聚合 | Action 输出或 provider proxy 可取外部数据，但不定义 PI context bundle | 已有 context bundle builder、manual/automation intake | 本仓库更强 |
| 写操作 | 可以执行外部 provider actions | 默认 proposal-before-write，经 permission/approval | 互补，需接 gate |
| 审计 | run logs、schemas、scopes、connection identity | activity timeline、tool call audit、proposal/issue/reply trace | 双层审计需对齐 |
| 部署 | local Node/Docker、Cloudflare、hosted | 本地 runner + SQLite + 前端 + issue loop | 可并行部署 |

一句话：**OpenConnector 是“怎么安全地连接和调用外部应用”的 gateway；PI Inbox 是“什么时候、为什么、基于什么证据让 PI 注意并提出行动”的 intake/decision 工作流。**

## 5. 接入价值

建议对接，但不要把 OpenConnector 当成 inbox 替代品，也不要短期把它嵌成唯一 connector runtime。

### 5.1 价值点

1. **补外部 SaaS 授权与 action catalog**
   - 当前 PI 已有 Feishu、CLI、MCP、HTTP read-only 等底座，但没有通用 OAuth/credential manager 和 1,000+ SaaS action catalog。
   - OpenConnector 可减少为 Gmail/Slack/Notion/GitHub 等分别写 credential UI 和 provider adapter 的成本。

2. **让 inbox source pull 更快覆盖真实来源**
   - 现有 `manualSourcePull` 只要求 read-only pull tool 输出 `events[]`。OpenConnector 可以先通过 CLI/SDK/HTTP action 拉取外部消息、邮件、issue、PR、calendar 等，再由薄 adapter 转成 `events[]`。

3. **统一 action 执行面**
   - Domain skill proposal 可新增 `connector.action.execute` 或映射到现有 tool invocation，由 approval gate 决定是否调用 OpenConnector action。
   - OpenConnector 负责 provider token/scope/account identity，本仓库负责 proposal、policy、audit、issue/reply 生命周期。

4. **降低供应商特例化风险**
   - Roadmap 明确“不为钉钉、飞书、GitHub 等来源写进核心硬编码逻辑”。OpenConnector 符合“外部来源作为 Tool Provider / Connector”的方向。

### 5.2 不该期待的价值

- 它不会替代 `attention_inbox_items`、`context_bundles`、`intake_runs`、`pi_action_proposals`。
- 它不自动解决“哪个消息需要 PI 关注”“是否创建 issue”“是否发外部回复”。这些仍应由 PI intake、domain skill、source policy、approval gate 决定。
- 它不应绕过本仓库的 proposal-before-write、安全策略和 activity timeline。

## 6. 最小可行接入路径

### 推荐路径：先作为外部 source/action provider，走现有 inbox 链路

**P0：本地 PoC，不改 schema（0.5-1 天）**

- 启动 OpenConnector local runtime 或使用 hosted runtime。
- 创建 runtime token；验证 `/v1/actions`、`/api/actions/:actionId/agent.md`、`oo connector search/schema/run`。
- 只用 no-auth 或只读 action，避免先处理 OAuth UI。
- 产出一个本地运行手册，不接入自动执行。

**P1：OpenConnector → `external_events` read-only source pull（1-3 天，取决于首个 source）**

- 方案 A：写一个小 CLI wrapper，调用 `oo connector run ...` 或 SDK/HTTP action，把结果规范化为：

```json
{
  "source": "openconnector:gmail",
  "provider": "openconnector",
  "processed_watermark": "...",
  "events": [
    {
      "external_id": "...",
      "event_type": "message",
      "actor": "...",
      "content": "...",
      "occurred_at": "...",
      "dedupe_key": "...",
      "normalized_message": {},
      "attachments": []
    }
  ]
}
```

- 通过现有 CLI connector manifest 暴露为 read-only tool；`manualSourcePull()` 和 `syncCliRawEvents()` 可复用。
- 首个 source 建议选“只读、低风险、输出稳定”的 Gmail/Slack/GitHub issue search，而不是发送邮件/发消息。
- 验证：manual trigger → pull source → `external_events` → context bundle → intake → inbox item → activity timeline。

**P2：OpenConnector action execution proposal（2-5 天）**

- 新增受控 action 类型或 tool invocation mapping，例如 `connector.action.execute`。
- Domain skill 只生成 proposal，不直接运行 OpenConnector。
- Approval 后才调用 OpenConnector action；需要把 OpenConnector action id、connection alias、input schema、risk、scope、run result 写入 `pi_action_events` / activity。
- 对写操作默认 `requires_approval=true`；只读 action 可按 source policy 放宽。

**P3：协议深化（3-7 天）**

- 若要直接用 OpenConnector MCP endpoint，需要补 HTTP MCP transport；当前 MCP transport 只支持 stdio command。
- 若要直接用 HTTP `/v1/actions/:id`，需要新增 POST-capable HTTP Tool Provider；当前 HTTP provider 是 GET/HEAD `url_fetch`。
- 若要让用户在 runner UI 内管理 OpenConnector credential/OAuth/runtime token，需要新增 settings UI；否则保持 OpenConnector Web Console 外部管理。

### 暂不推荐路径

- **不要**直接把 OpenConnector DB / run logs 映射成本仓库 inbox 表。
- **不要**让 OpenConnector action 绕过 proposal/approval 直接执行外部写操作。
- **不要**为了一个 provider 先大改 `external_events` / `attention_inbox_items` schema。
- **不要**把 OpenConnector catalog 全量同步成本地工具表；优先按需 discover/cache。

## 7. 风险与前置条件

### 风险

1. **权限边界重叠**：OpenConnector 有 runtime token/action allowlist，本仓库有 source policy/action gate；需要明确“双 gate”如何组合，避免任一边 allow 导致越权。
2. **凭据与审计双存储**：OpenConnector 保存 credentials/run logs，本仓库保存 external_events/activity/tool audit；需要避免把 raw tokens 或敏感 payload 二次写入 runner。
3. **Catalog 规模与 schema 漂移**：1,000+ providers / 9,400+ actions 不适合全量映射到 UI 或 prompt；应按 source/action 选择、按需发现。
4. **MCP 协议形态不匹配**：OpenConnector 是 HTTP MCP endpoint；本仓库当前 MCP transport 是 stdio，短期需要 CLI wrapper 或新增 transport。
5. **HTTP action 执行能力缺口**：本仓库当前 HTTP provider 是 read-only URL fetch，不能 POST action；写 action 需要独立 provider adapter 和 approval 集成。
6. **输出规范化成本**：OpenConnector action 输出是 provider-specific；进入 inbox 前仍要规范化成 `events[]` / `external_events`，这部分需要 per-source adapter 或 action guide 约定。
7. **Hosted runtime 选择**：如果用 OOMOL hosted，凭据边界移到第三方 hosted runtime；如果 self-host，团队要运维 OAuth、tokens、SQLite/D1/R2。

### 前置条件

- 明确首批 source：例如 Gmail、Slack、GitHub、Notion 哪个最有价值。
- 明确运行形态：local self-host、Cloudflare self-host、还是 OOMOL hosted。
- 明确只读 / 写操作策略：是否只先做 read-only source pull；哪些 write actions 可进入 proposal。
- 明确 token 存放方式：OpenConnector runtime token 放 env / local secret，不进入 repo；runner 只保存 provider id 和 redacted metadata。
- 为首个 source 定义 `events[]` 归一化 contract 和 fixture。

## 8. 对接方案选项

### 方案 A：CLI wrapper + CLI connector manifest（推荐起步）

- 做法：用 `oo connector` 或一个 TypeScript wrapper 连接 OpenConnector runtime，输出 JSON `events[]` 或 action result；在本仓库用现有 `pi-cli-connector.v0` 注册。
- 优点：复用现有 CLI runner、env secret redaction、`syncCliRawEvents()`、manual source pull；不改 schema。
- 缺点：每个 source 的输出仍要适配；CLI 依赖部署和登录状态。
- 适合：P1 read-only source pull PoC。

### 方案 B：OpenConnector HTTP Tool Provider

- 做法：新增 POST-capable HTTP provider，配置 base URL/runtime token，按 allowlist 调 `/v1/actions/:id`。
- 优点：不依赖 CLI；更适合服务端自动化和 action execution。
- 缺点：需要新增 provider adapter、token 管理、action schema discovery/cache、tool audit；比 A 改动大。
- 适合：P2/P3 长期形态。

### 方案 C：OpenConnector MCP Provider

- 做法：把 OpenConnector `/mcp` 接入本仓库 MCP Tool Provider。
- 优点：最符合 Agent tool discovery 心智，OpenConnector 已暴露 `search_actions` / `execute_action`。
- 缺点：当前本仓库 MCP transport 只支持 stdio command；需要 HTTP MCP transport 或本地 stdio bridge。
- 适合：当需要通用 action discovery 时做，但不作为第一步。

### 方案 D：只作为参考，不接入

- 做法：继续用自研 CLI/MCP/HTTP provider，OpenConnector 仅作为设计参考。
- 优点：最小工程风险。
- 缺点：会继续承担每个 SaaS 的 OAuth/credential/action adapter 成本。
- 适合：如果首批来源只需要 Feishu/本地 CLI/GitHub CLI，且不急需 SaaS catalog。

## 9. 推荐结论

1. **是否类似**：不类似。OpenConnector 是 connector/auth/action gateway；PI inbox 是事件/上下文/待处理事项 intake 和决策入口。
2. **是否建议对接**：建议，但定位为 **可选 OpenConnector Tool Provider / Source Provider**，不要替换 inbox。
3. **优先级**：中高。若近期 PI Assistant 要扩展 Gmail/Slack/GitHub/Notion 等外部工作源，对接价值高；若近期只做本地 runner/Feishu，则可延后。
4. **最小可行路径**：先做 CLI wrapper/manifest 的 read-only source pull PoC，把一个 OpenConnector action 输出规范化成 `events[]`，复用 `manualSourcePull()` → `syncCliRawEvents()` → `external_events` → context bundle → intake → inbox → proposal/activity。
5. **不建议现在做的事**：不改 schema、不引入全量 catalog 同步、不绕过 approval 执行写 action、不把 OpenConnector 管理台复制到 runner UI。

## 10. 开放问题

1. “我们的 inbox”是否仅指本仓库 PI Assistant attention inbox，还是还包括另一个产品/系统的 inbox？本报告假设指本仓库当前/规划中的 `external_events` + `context_bundles` + `intake_runs` + `attention_inbox_items`。
2. 首个要验证的外部 source 是什么？Gmail/Slack/GitHub/Notion 的 action 输出差异会直接影响 adapter 设计。
3. 是否接受使用 OOMOL hosted runtime 处理 OAuth/credentials？还是必须 self-host/local/Cloudflare？
4. 写操作是否允许进入 proposal？如果允许，哪些 action 类型第一批可做 approval-gated execution？
5. 是否需要多用户/多 connection alias？当前 runner 多数能力偏本地单 runtime；OpenConnector 支持 named connection，会影响 source policy 和审计展示。
