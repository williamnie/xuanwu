# ADR-XW-0089 G11：Qoder 接口新鲜度 Gate

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 当前权威设计：[0090 Qoder Code Agent 产品化接入设计](0090-qoder-code-agent-product-integration-design.md)
- 重新执行日期：2026-08-12
- 状态：**Q0 离线合同通过**；允许后续 Q1/Q2 按冻结版本实现，不代表 runtime ready、真实账号可用或 usage 已完成计费验收

## 1. 结论

当前 gate 冻结以下官方声明版本对：

```text
@qoder-ai/qoder-agent-sdk = 1.0.20
@qoder-ai/qodercli       = 1.1.18
wire protocol expected   = 1.2.0
wire protocol compatible = 1.x（SDK handshake 拒绝跨 major）
verified at              = 2026-08-12
verified platform        = macOS arm64（包与类型只读检查）
```

`@qoder-ai/qodercli` registry latest 是 **1.1.19**，但 SDK 1.0.20 的 `package.json.qoderCliVersion` 与 `dist/runtime-manifest.json.qoderCliVersion` 都是 **1.1.18**。因此 `SDK 1.0.20 + latest CLI` 不是合同；Q1 的受控 ProcessTransport runtime 应 exact pin 1.1.18。1.1.19 必须单独重跑 version-pair gate 后才能替换。

主终态结论也已修正：**只有 `SDKResultMessage` 是主 Query/Run 的权威终态**。`SDKTaskNotificationMessage` 描述 Sub-Agent task 的 `completed | failed | stopped`，只能投影为非终态 progress，不能关闭主 Run。

## 2. 官方证据与执行方式

本次只使用官方 npm 发布包、包内 `.d.ts`/manifest/LICENSE 与 Qoder 官方文档：

- [Qoder Agent SDK TypeScript Reference](https://docs.qoder.com/cli/sdk/references-typescript)
- [Authentication](https://docs.qoder.com/cli/sdk/authentication)
- [Session Control](https://docs.qoder.com/cli/sdk/session-control)
- [Permission Control](https://docs.qoder.com/cli/sdk/permissions)
- [Cost and usage](https://docs.qoder.com/cli/sdk/cost-usage)
- npm registry：`@qoder-ai/qoder-agent-sdk`、`@qoder-ai/qodercli`

执行了以下无登录、无模型调用的只读/离线检查：

```bash
npm view @qoder-ai/qoder-agent-sdk version dist.tarball license dependencies peerDependencies bin --json
npm view @qoder-ai/qodercli version dist.tarball license dependencies optionalDependencies bin --json
npm pack @qoder-ai/qoder-agent-sdk@1.0.20 --ignore-scripts
npm pack @qoder-ai/qodercli@1.1.18 --ignore-scripts
```

没有安装全局 CLI，没有执行 package lifecycle script，没有登录、读取/写入凭据或调用 Qoder 模型服务。

## 3. Version matrix 与历史边界

| SDK | SDK 声明 companion CLI | wire protocol | 默认 transport | Gate 含义 |
| --- | --- | --- | --- | --- |
| 1.0.17（仓库旧 pin） | 1.1.11 | 1.1.0 | process | 仅用于解释旧 skeleton；不再是实现依据 |
| 1.0.17 + 1.1.14（旧 G11 记录） | 非 SDK 包声明的 version pair | 未冻结 | 当时调查为 process | 只是 2026-08-04 的 registry/外部快照，不证明正式配对 |
| **1.0.20 + 1.1.18** | **1.1.18** | **1.2.0** | worker（包默认） | **本次 Q0 冻结合同** |
| 1.0.20 + 1.1.19 | registry latest 组合，SDK 未声明 | 未验 | 未验 | 不进入实现基线 |

SDK 1.0.20 默认 transport 已从 process 变为 worker，postinstall 对应下载 1.1.18 worker runtime。0090 设计选择“受控 qodercli 子进程”，所以 Q1 必须显式配置 `ProcessTransport` 或 `pathToQoderCLIExecutable`，不能依赖 SDK 的包默认值，也不能把 Qoder Desktop launcher 当 runtime。

版本升级规则：SDK、CLI 或 wire major/minor 任一变化，都重新运行本文的 package metadata、类型合同、fixture tests、release packaging 与后续显式 live smoke；不能只改 lockfile。

## 4. 当前 SDK/CLI 合同

### 4.1 Query、主终态与子任务

- 主入口：`query({ prompt, options }): Query`，`Query` 是 `AsyncGenerator<SDKMessage>` 并带控制方法。
- `SDKResultMessage = SDKResultSuccess | SDKResultError`：
  - `subtype='success' && is_error=false` → 主任务成功；
  - `error_during_execution | error_max_turns | error_max_budget_usd`，或 success shape 中 `is_error=true` → 主任务失败；
  - `uuid` 是本轮 result/turn ref，`session_id` 是 Session ref。
- `SDKTaskNotificationMessage` 含 `task_id`、可选 `tool_use_id`、子任务 status 和可选子任务 usage；它不是主终态。
- `status`、`mirror_error`、`permission_denied`、hook、retry 和未知消息都不能独自成功/失败主 Run；无 result 时只能由明确 SDK/process exception 按协议失败收敛。

### 4.2 新 Session 与 resume

`Options` 同时存在两个不同字段：

- `sessionId`：预分配/指定新 Session ID；
- `resume`：恢复已有 Session。

恢复、Sessions send message 和 Run recovery 必须传 `options.resume=<历史 session id>`；禁止把历史 ID 填入 `sessionId`。fork 另有 `forkSession`/`forkSession()` 合同，不能用隐式新 Session 代替失败的 resume。

### 4.3 Session list/read

SDK 1.0.20 导出：

```ts
listSessions(options?: { dir?; limit?; offset?; includeWorktrees? }): Promise<SDKSessionInfo[]>
getSessionInfo(sessionId, options?: { dir? }): Promise<SDKSessionInfo | undefined>
getSessionMessages(sessionId, options?: { dir?; limit?; offset?; includeSystemMessages? }): Promise<SessionMessage[]>
```

`SDKSessionInfo.sessionId` 是 UUID；metadata 包括 `summary/lastModified/fileSize/customTitle/firstPrompt/gitBranch/cwd/tag/createdAt`。`SessionMessage.message` 是 `unknown`，后续 Session adapter 必须做结构守卫。list/read 是本地 Session store 读取，不需要模型调用；执行与读取必须使用同一个 config/session dir。

### 4.4 interrupt

`Query.interrupt(): Promise<SDKControlInterruptResponse | undefined>` 中断当前 turn；旧 CLI 可能返回 `undefined`，支持 `interrupt_receipt_v1` 的 CLI 返回保留队列消息 UUID。它不是全局 interrupt。后续 facade 必须以 invocation-scoped Query handle 管理并发，不能复用单个 `interruptFn`。

### 4.5 auth

`Options.auth` 的公共模式为：

- `accessToken()` / `accessTokenFromEnv()`；
- `serviceAccount()` / `serviceAccountFromEnv()`；
- `qodercliAuth()` 只读复用本地 CLI 登录态。

虽然 TypeScript 字段是 optional，官方类型注释明确：`query()` 必须配置 auth，缺失时会在 spawn 前抛 `auth_not_configured`。玄武只能持久化 secret ref/auth mode，不能写明文凭据；本次 gate 未验证任何登录态。

### 4.6 model 与 effort

- 启动参数：`Options.model?: string`；
- 活跃 Query：`setModel(model?)`、`getAvailableModels({fetchStrategy?,uid?}) -> ModelInfo[]`；
- `ModelInfo` 暴露模型相关 thinking/effort metadata。

SDK 1.0.20 没有独立、稳定的 `Options.effort` typed 字段。后续实现不能把 Codex effort 枚举直接塞入 Qoder query；需按 model metadata/settings 验证，否则留空或 fail closed。

### 4.7 usage 与 Credits

- 主 `result` 提供 `usage`、`modelUsage`、`duration_ms`、`total_cost_usd`，以及可选 `total_credits`；
- 类型注释明确 `total_credits` 与 `modelUsage[*].credits` 是 **Session-cumulative**；
- request-level `usage.credits/original_credits/billable` 是请求粒度；
- `Query.getUsageInfo()` 返回 account quota，并可含 `session.total_credits/model_usage`；
- `task_notification.usage` 只属于 Sub-Agent task。

因此 Q0 只冻结 raw shape。Q5/真实账号 gate 完成同 Session 两轮 delta 验证前，不把 Session 累计 Credits/tokens 重复计入多个 Attempt，也不把 `total_cost_usd=0` 当真实上游成本为零。

### 4.8 permission

`Options` 提供 `permissionMode`、`allowedTools`、`disallowedTools`、`canUseTool`。`CanUseTool(toolName,input,options)` 可读取 `toolUseID/agentID/blockedPath/decisionReason/signal`，返回 typed allow/deny `PermissionResult`。

这只证明 host approval/policy 的 typed surface 存在，不证明它等价于 OS sandbox。Bash/path containment、无人值守 `dontAsk` 规则和 Approval Action Gate 仍由 Q2/Q5 fail closed 实现与验证。

### 4.9 license 与分发

- SDK 1.0.20 `license` 为 `SEE LICENSE IN LICENSE`，包内 LICENSE 指向 Qoder Product Service Terms；
- CLI 1.1.18 包含 Apache-2.0 LICENSE，但产品使用/再分发仍需结合 Qoder 服务条款确认；
- package 可下载、可执行不等于已获得商用再分发许可。Q1 release bundling 前保留法务/采购 gate。

## 5. 离线 contract tests

`backend-ts/src/providers/qoder/sdkContract.test.ts` 直接针对 exact-pinned SDK 类型和包 manifest，且不会调用 `query()`：

- 锁定 SDK 1.0.20 / companion CLI 1.1.18 / wire 1.2.0；
- 类型级锁定 result、Session list/read、interrupt、model、usage、auth 与 permission surface；
- fixture 锁定三种 `task_notification` status 均为 nonterminal；
- fixture 锁定只有 `SDKResultMessage` 产生主终态；
- 锁定 resume 优先于新 `sessionId`，Provider recovery 只传 `resume`。

这些测试是后续 facade/event/session 实现的输入合同，不代表 Qoder runtime、账号、网络、权限隔离或 Credits 语义已 live 验收。

## 6. Gate 判定与后续前置假设

| Gate | Q0 判定 | 后续约束 |
| --- | --- | --- |
| structured headless API | 通过 | Q1 显式管理 ProcessTransport/CLI path，不依赖包默认 worker |
| authoritative terminal | 通过 | Q2 只认主 result；无 result fail closed |
| stable Session/turn refs | 通过 | `session_id`/result `uuid` 只作 provider refs，不替代 Run/Attempt authority |
| resume | 通过 | 历史 Session 只进 `resume` |
| Session list/read | 类型通过 | Q3 对 unknown transcript 做结构守卫和 bounded pagination |
| interrupt | 类型通过 | Q2 必须 invocation scoped；并发行为仍需 fixture/live 验证 |
| auth | 类型通过 | Q1 真实 readiness 必须检查 auth mode/source，不得固定 ready |
| model/effort | 部分通过 | model list 有合同；effort 无稳定 query option，按 metadata fail closed |
| usage/Credits | raw shape 通过 | 累计值不得直接当 Attempt delta；Q5 需两轮 live gate |
| permission/sandbox | typed surface 通过 | policy 不等于 OS sandbox；Q2/Q5 补 action gate 与 containment |
| packaging/license | 待 Q1 | exact CLI 1.1.18、安装/回滚/NOTICE/条款单独验收 |

Q0 的“通过”只允许进入后续 bounded implementation。没有 Q1 runtime packaging/readiness、Q2 facade/conformance 和 Q7 真实账号证据时，Qoder `supportLevel` 必须保持 `preview`。

## 7. Q0 验证记录

2026-08-12 在当前分支执行：

| 验证 | 结果 |
| --- | --- |
| `bun test src/providers/qoder/sdkContract.test.ts src/providers/qoder/provider.test.ts` | 通过：13 pass / 0 fail / 30 assertions；未调用 `query()` |
| touched Qoder files targeted `tsc --noEmit` | 通过：exit 0，无 diagnostics |
| 全仓 `bunx tsc --noEmit --pretty false` | 未通过：exit 1，共 138 条现有非 Qoder diagnostics；`src/providers/qoder/` 为 0 条，本 Q0 不扩大范围修复 |
| `git diff --check` | 通过 |
