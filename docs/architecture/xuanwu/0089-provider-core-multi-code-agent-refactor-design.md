# ADR-XW-0089：Provider Core 多 Coding Agent 重构 — 架构设计（落地版 v2）

- 关联计划：[0089 Provider Core 多 Coding Agent 重构计划](0089-provider-core-multi-code-agent-refactor-plan.md)
- 关联评审：[0089 Provider Core 重构方案 Review](0089-provider-core-multi-code-agent-refactor-review.md)（计划评审）、[0089 架构设计 Review](0089-provider-core-multi-code-agent-refactor-design-review.md)（设计评审）
- 版本说明：v2 按设计 Review 的 11 条意见（3 高 + 6 中 + 2 轻）修订：补两阶段执行合同、policy effect-set 模型、ProcessProviderFacet、Registry 两级生命周期、事件归一化职责边界、恢复计划原始 DAG、Session composite cursor、raw_ref versioned envelope 等；并修正 v1 中 "deno lint" 表述（仓库为 Bun）。
- 设计来源：architect 只读架构设计（2026-08-04）+ 设计 Review 意见，主代理整合修订；关键引用已抽查复核
- 状态：设计稿 v2，待 §10 的 blocking decisions 定案后再冻结 P1/P2 合同
- 本文性质：把计划细化为可落地的模块边界、契约签名、流程与工程任务边界；不改变计划中的 authority 与门禁

---

## 1. 分层与模块边界

### 1.1 目标目录与依赖方向

```text
backend-ts/src/providers/
  core/            ← 唯一被 runtime/domain/http/runner 依赖的层
    contracts.ts   ProviderId/ProviderExecutionRef/ExecutionInvocation/ExecutionCompletion/ExecutionRequest
    manifest.ts    ExecutorProviderManifest/ProviderCapabilities/ProviderSettingsDescriptor
    registry.ts    ProviderRegistry/RegistryEntry/ProviderError
    facets.ts      ExecutorProvider/SessionProviderFacet/ControlProviderFacet/ModelProviderFacet/ProcessProviderFacet
    eventNormalization.ts  NormalizedEventCandidate 的 provider-neutral 校验/裁剪/投影
    policyResolution.ts    ResolvedExecutionPolicy（effect-set 模型）+ policy_unsupported
    sessionContracts.ts    SessionSummary/SessionDetail/TranscriptItem/SessionPage/ProviderSessionCursorV1
    legacyProjection.ts    唯一 thread_id/turn_id 产出点
    conformance.ts         注册期 capability/method 一致性校验 + 测试断言
  codex/           ← 既有 codex/* 整体迁入，依赖 core/contracts + facets
  claude/          ← 既有 claude/* 迁入
  piCodingAgent/   ← 新增
  qoder/           ← 新增
  testing/         ← executionOnlyProvider/resumableProvider/fullProvider/conformanceFixtures
```

**依赖方向（单向，禁止环）**：

- Provider Core 拥有 provider-native 的 usage observation（Provider 报告的 token/cost、进程 lease）；Run Domain 层把它投影为 `RunCost` 等持久化模型。Core 不拥有 `ProviderAttemptRef`——那是 Run Domain 的持久化投影，Core 只提供 `ProviderExecutionRef`（review 2.5）。
- `core/` 只 import 纯值/纯类型共享 kernel（如 `shared/contracts` 中的 `ProviderExecutionRef` 本身），不 import `domain/`、`runner/`、`http/`，也不 import 任何 adapter。
- 各 adapter 只 import `core/*` 与自身 SDK/CLI 模块；禁止 import `http/`、`runner/`、`domain/`。
- `runtime/core.ts`、`runner/*`、`http/*` 只 import `core/registry.ts` 与 `core/contracts.ts`，不 import 具体 adapter 的 `provider.ts`。

**边界门禁（review 2.11）**：不用 `deno lint`（仓库为 Bun，`backend-ts/package.json`）。改为交付一个 focused architecture test：扫描 `providers/core` 与各 adapter 的 import graph，断言满足上述单向规则，在 Bun test / CI 中执行；`core/BOUNDARY.md` 只作说明文档，不代替自动门禁。

### 1.2 接线点映射（现状 → 目标）

| 现状文件 | 现状职责 | 目标落点 |
| --- | --- | --- |
| `providers/types.ts:3,5` | 闭合联合 `EXECUTOR_PROVIDER_IDS` | `core/contracts.ts` branded `ProviderId`；`registry.has(id)` 替代枚举校验 |
| `runtime/core.ts:191-202` `executorProviders()` | 手写 codex/claude map | `core/registry.ts` `startConfigured(config)`；`core.ts` 只持有 registry 引用 |
| `runtime/core.ts:249` `installTerminationHandlers` | `provider.stop?.()` | `registry.stopAll()`（幂等、有界并发） |
| `runtime/core.ts:53-70` `runtimeMemoryRows()` | 只含 runner/worker/Codex ownership snapshot | `registry.collectProcessLeases()` 聚合所有 Provider lease（review 2.3） |
| `http/systemStatus.ts:212-260` `providerStatus()` | 手写 codex/claude status | `registry.list()` 投影；systemStatus 只读消费 |
| `http/sessionApi.ts:75,122,126,357` | Codex index/retry/fallback 分支 | 下沉到 `codex/` adapter；sessionApi 只调 facet |
| `runner/providerRuntime.ts` event sink | 持久化 + `SessionRef{turnId}` | 消费 `ProviderExecutionRef`；terminal 事件驱动 `onRunComplete` |
| `runner/projectLoop.ts:92-132` `reconcileProviderOutcome()` | provider.run 返回后二次 reconcile | 与 terminal completion 合并为单一 reconciliation 路径 |
| `runner/interrupt.ts:325-336` `sessionRef()`/`providerID()` | 硬编码 provider 枚举 | `registry.assertCapability(id,'interrupt')` + `ControlProviderFacet` |
| `runner/recovery.ts:13` `RecoveryInput.providers` | `Partial<Record<ExecutorProviderId,…>>` | registry 引用 |
| `providers/types.ts:1`（import `RunCost`） | Core ↔ Domain 双向依赖种子 | 收口：usage observation 归 Core，`RunCost` 投影归 Domain（review 2.5） |
| `frontend/src/pages/sessions/sessionOptions.js:25-31` | 静态 `PROVIDER_OPTIONS`（含 opencode/kimicode disabled） | `/api/providers` catalog context；占位项删除 |
| `frontend/src/utils/issueRuns.js:2` | `SESSION_CAPABLE_PROVIDERS` | catalog capability 投影 |

---

## 2. 核心契约精化

### 2.1 ProviderId（branded string）

```ts
// core/contracts.ts
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export type ProviderId = string & { readonly __brand: "ProviderId" };
export function asProviderId(value: string): ProviderId {
  if (!PROVIDER_ID_RE.test(value) || value.includes(":")) {
    throw new ProviderError({ category: "not_registered", providerId: value, operation: "validate", message: "invalid provider id" });
  }
  return value as ProviderId;
}
```

校验在 `registry.registerFactory()` 与 `ProviderExecutionRef` 构造时执行。禁止 `:` 因 session key 为 `<providerId>:<sessionRef>`（`domain/run/contracts.ts:180` `observation_ref` 既有约定）。内置 ID：`codex`、`claude`、`pi-coding-agent`、`qoder`。`isExecutorProviderId` 调用点（约 12 处）改为 `registry.has(id)` 或 `registry.assertCapability`。

### 2.2 ProviderExecutionRef 取值规则

```ts
export type ProviderExecutionRef = {
  providerId: ProviderId;
  invocationRef: string;   // 必需；Provider 无原生 ID 时用持久化 intent 派生的本地 ref（如 `xw-inv:<intentId>`）
  sessionRef?: string;     // 可跨 invocation 恢复
  messageRef?: string;     // 本次 invocation 对应的 provider message/turn
  cursorRef?: string;      // 树形 Session 的 branch/entry；不得伪装成 turn
};
```

- `invocationRef` 在 `execute` 接受时即返回：Codex 用 run/turn ID，Claude 用 result UUID，Pi 用 RPC request ID，Qoder 用 SDK message UUID。
- `sessionRef` 迟到时不得新建 Attempt（计划 §7.3）；`providerRuntime.ts:persistRuntimeResult` 改为补齐而非新建。
- `messageRef` 对应现状 `provider_turn_id`（`domain/run/service.ts:106` 附近）；execution-only Provider 留空。
- `cursorRef` 仅 Pi/Qoder fork 使用；Codex/Claude 恒空。
- Core 只持有此 canonical ref；`ProviderAttemptRef`（含 `turn_ref`）是 Run Domain 的持久化投影，由 Domain 层映射（review 2.5）。

### 2.3 两阶段执行合同（review 2.1，新增）

现状缺陷：Codex 在 `startTurn` 后立即返回（`codex/provider.ts:74-101`），Claude 等 stream/process 终态返回（`claude/provider.ts:227-269`）；`runIssueWithProvider` 在 `await provider.run()` 后统一执行 `flush/persistRuntimeResult/onRunComplete`（`runner/providerRuntime.ts:56-101`），provider 返回时机不一致会导致终态等待竞态。P1 冻结以下两阶段合同：

```ts
type ExecutionInvocation = {
  accepted: ExecutionHandle;            // execute resolve 时可用，含 invocationRef（可最终补齐）
  completion: Promise<ExecutionCompletion>;  // 唯一终态交付渠道
};

type ExecutionCompletion = {
  ref: ProviderExecutionRef;            // 终态时补齐的完整 refs
  terminal: "succeeded" | "failed" | "interrupted" | "cancelled";
  terminalSourceRef: string;            // 幂等关联键，与 terminal event 的 sourceRef 一致
};
```

合同要点：

1. `execute()` 的 resolve 时机：adapter 建立本地 invocation anchor 后即可 resolve `accepted`；不要求等到原生终态。
2. terminal completion 是唯一终态渠道：`completion` promise 与 terminal event 必须以 `terminalSourceRef` 幂等关联（同一 Attempt 只能产生一个 authoritative terminal outcome）。
3. event pump ownership：adapter 拥有原生事件读取/订阅；Core/Runner 只通过 `onEvent` 回调消费。pump 的 abort、backpressure、异常传播由 adapter 负责并在 manifest 或合同文档声明。
4. `onRunComplete` 语义改为 "provider terminal"（由 terminal completion 驱动），不再由 `execute` 返回驱动；W1 的 `ProviderRunResult` bridge 只作兼容投影，不承担 W2 终态协议。
5. accepted 后进程启动失败、无 terminal、restart 的收敛规则：accepted 但尚无 terminal 且无 sessionRef 的 invocation，restart 时按 intent/outcome 审计恢复，不重复发起 Provider call（0069 fail closed）；超时未终态按 ProviderError `timeout` 收敛为 failed/cancelled。
6. `reconcileProviderOutcome`（`runner/projectLoop.ts:92-132`）与 terminal completion 合并为单一 reconciliation 路径，删除二次 reconcile 入口。

### 2.4 ExecutorProviderManifest 完整字段表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `ProviderId` | 唯一 |
| `displayName` | `string` | UI 展示 |
| `supportLevel` | `"experimental"\|"preview"\|"tested"` | 见 §2.5 的 capability-aware 提升路径 |
| `transports` | `Array<"rpc"\|"stdio-json"\|"stream-json"\|"sdk"\|"acp">` | 声明运行形态 |
| `capabilities` | `ProviderCapabilities` | 见 §2.6 |
| `executionSettings` | `ProviderSettingsDescriptor` | TypeBox schema，首版仅 string/enum/boolean/secret-ref |
| `sessionPresentation?` | `{ emptySession?: boolean; nativeActions?: NativeAction[] }` | 是否支持空 Session；Codex "Open in Codex App" 走 native action |
| `processObservability?` | `"none"\|"lease"` | 进程治理模式，见 §6.3 |

### 2.5 supportLevel 提升路径（review 2.10，修订）

supportLevel 使用 capability-aware acceptance profile，不绑定 Session 能力，也不绑定 Pi/Qoder 的 G10/G11：

- **所有 Provider** 的 `tested` 前提：execution terminal/restart/redaction/policy 证据 + W2 release 无 parity drift。
- 只有**声明 Session/control capability** 的 Provider，才额外要求对应的 resume/interrupt/approval acceptance。
- execution-only Provider 可被充分测试并标 `tested`，不要求 resume/interrupt。
- G10/G11 只约束 Pi/Qoder 的实施版本新鲜度，不成为 Codex/Claude supportLevel 的依赖。
- 禁止自动探测降级或升级；`preview→tested` 由独立 live acceptance 证据决定。

### 2.6 ProviderRegistry：factory catalog 与 runtime instance 两级模型（review 2.4，修订）

```ts
// core/registry.ts
export interface ProviderFactory {
  manifest: ExecutorProviderManifest;
  parseConfig(raw: unknown): ProviderRuntimeConfig;   // adapter 自己解析 provider-specific config
  autoDetect(): { installed: boolean; ready: boolean; reason?: string };  // CLI/SDK 探测
  create(config: ProviderRuntimeConfig, deps: ProviderDeps): RegisteredProvider;
}

export type RegistryState =
  | "registered"     // factory 已注册，未启动
  | "disabled"       // config 显式禁用
  | "starting"
  | "not_ready"      // 已实例化但 CLI/SDK 不可用
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";        // 启动/运行失败，含脱敏诊断

export interface RegistryEntry {
  id: ProviderId;
  manifest: ExecutorProviderManifest;
  state: RegistryState;
  instance?: RegisteredProvider;       // ready/not_ready 时存在
  failure?: { category: ProviderErrorCategory; message: string };
}

export interface ProviderRegistry {
  registerFactory(factory: ProviderFactory): void;       // 启动期编译期内置；校验 ID 唯一、manifest schema
  startConfigured(config: ProviderRuntimeConfigs): Promise<void>;  // 遍历 factory catalog（不写死 ID 列表）
  getReady(id: ProviderId): RegisteredProvider;          // 只返回 ready instance；否则抛对应 category
  describe(id: ProviderId): RegistryEntry;               // 未安装/未配置也可返回 catalog entry
  list(): RegistryEntry[];                               // 全量状态（manifest + 脱敏 runtimeStatus）
  stopAll(): Promise<void>;                              // 幂等；有界并发，单失败有独立 status 不阻塞其余
  collectProcessLeases(): readonly ProviderProcessLease[]; // 聚合全部 Provider lease（见 §2.7）
  assertCapability(id: ProviderId, facet: FacetName, method?: string): void;
  injectFactoryForTest(factory: ProviderFactory): Disposable;  // 测试注入；生产 build-time 剥离
}
```

关键语义：

- `registerFactory` 只建 catalog；`startConfigured` 由 factory 自己 `parseConfig/autoDetect/create` 生成 0 或 1 个 instance，避免 `ProviderRuntimeConfigs` 演化成新的闭合联合类型。
- `enabled === false` → `disabled`；CLI 未安装 → 注册但 `not_ready`，不报全局 unhealthy。
- `getReady` 与 `describe` 分离：未安装/未配置 Provider 在 catalog 可见（`describe`），不可提交（`getReady` 抛错）。
- `register` 时 `conformance.ts` 校验 capability/method 一致性：声明 true 但方法缺失 → 注册失败（fail closed）；声明 false 但方法存在 → 不自动曝光。
- 生产禁止 `injectFactoryForTest`（build-time 剥离）。

### 2.7 ProcessProviderFacet 与 ProviderProcessLease（review 2.3，新增）

```ts
// core/facets.ts
export interface ProcessProviderFacet {
  processLeases(): readonly ProviderProcessLease[];
  reconcileProcessLeases?(): Promise<ProcessReconciliation>;
}

export type ProviderProcessLease = {
  provider: ProviderId;
  invocationOwner: string;      // 关联的 invocation ref / run id
  pid: number;
  pgid?: number;
  startedAt: string;
  commandLabel: string;         // 可安全展示的 command 摘要，不含敏感参数
};

export type ProcessReconciliation = {
  adopted: ProviderProcessLease[];
  released: string[];           // 已退出/归还的 lease id
  errors: Array<{ provider: ProviderId; message: string }>;
};
```

- `registry.collectProcessLeases()` 聚合所有 Provider 的 lease，作为 `processGroupMemory`（RSS/footprint 预算）、shutdown（`stopAll`）和 restart reconciliation 的**同一进程清单**（review 2.3 风险：现 `observability/processGroupMemory.ts:128-168` 只对 `inspect()` PID 集合求和，需替换为 lease 聚合）。
- Codex 现有 ownership snapshot（`runtime/core.ts:53-70` 的 `runtimeSnapshot()`）经 Codex adapter 的 bridge 投影到同一 `ProcessProviderFacet`，`runtime/core.ts` 不再直接读取 Codex 私有类型。
- `active_sessions` 只是状态指标，不能替代 PID 观测；`processObservability: "none"` 的 Provider 仍须返回空 lease 列表（允许 execution-only 无进程）。

### 2.8 Facet 与 capability 一致性

```ts
// core/facets.ts
export interface ExecutorProvider {
  readonly manifest: ExecutorProviderManifest;
  execute(input: ExecutionRequest): Promise<ExecutionInvocation>;
  runtimeStatus(): ProviderRuntimeStatus;
  stop?(): Promise<void>;
}
export interface SessionProviderFacet {
  createSession?(input: CreateSessionRequest): Promise<SessionMutationResult>;
  listSessions?(input: SessionListRequest): Promise<SessionPage>;
  readSession?(ref: string, cursor?: string): Promise<SessionDetail>;
  sendMessage?(input: SendSessionMessageRequest): Promise<SessionMutationResult>;
  forkSession?(input: ForkSessionRequest): Promise<SessionMutationResult>;
}
export interface ControlProviderFacet {
  interrupt?(input: InterruptRequest): Promise<ControlReceipt>;
  steer?(input: SteerRequest): Promise<ControlReceipt>;
  resolveApproval?(input: ApprovalResolutionRequest): Promise<ControlReceipt>;
}
export interface ModelProviderFacet { listModels?(): Promise<ModelCatalog>; }
```

一致性校验：`conformance.checkManifest(provider)` 遍历 `capabilities`，对每个声明为 true 的 method 检查 `typeof provider[method] === 'function'`。`steer` 仅当 `capabilities.sessions.steerWhileRunning===true` 时校验；`resolveApproval` 仅当 `capabilities.control.approvals==="host-callback"` 时校验。所有偏差抛 `capability_unsupported`。

---

## 3. 关键流程设计

### 3.1 注册与启动装配（startConfigured）

```text
runtime/core.ts startCoreRuntime()
  → registry.registerFactory(BUILTIN_FACTORIES)   // 编译期 import map：codex/claude/piCodingAgent/qoder/testing
  → registry.startConfigured(config.providers)
    → for each factory in catalog:
        if config[factory.manifest.id].enabled === false → state=disabled，跳过
        parsed = factory.parseConfig(config[id])
        probe = factory.autoDetect()
        if !probe.installed → state=not_ready，记录 reason，继续
        instance = factory.create(parsed, deps)
        conformance.checkManifest(instance)        // fail closed
        state=ready（runtimeStatus().ready 决定 not_ready/ready）
    → registry.list()/collectProcessLeases() 供 runtime 与 processGroupMemory 接线
```

`startConfigured` 遍历 factory catalog 而非写死的 `codex/claude/pi/qoder`；新增 adapter 只增加注册点和 factory（review 2.4）。未安装 → `not_ready` 不报全局 unhealthy（计划 §25.4）。

### 3.2 一次 Run 执行时序（两阶段）

```text
projectLoop/selectProvider → registry.getReady(providerId) + assertCapability('execute')
  → runIssueWithProvider(provider, input)          // runner/providerRuntime.ts 改造
    → const { accepted, completion } = await provider.execute(ExecutionRequest)
       ├─ adapter 建本地 invocation anchor（invocationRef）→ accepted
       ├─ onEvent(started/progress/approval/...) → NormalizedEventCandidate → 归一化管线
       └─ completion resolve 时携带终态 refs + terminalSourceRef
    → terminal completion 驱动：eventSink.flush → persistRuntimeResult → onRunComplete(terminal)
    → reconcileProviderOutcome 与 completion 合并为单一 reconciliation 路径
```

- `persistRuntimeResult` 改为在 terminal/首个 session 事件时补齐 upsert，`sessionRef` 迟到不新建 Attempt。
- `onRunComplete` 语义 = "provider terminal"（见 §2.3-4）。
- W1 保留 `ProviderRunResult` 双写作为兼容投影，W2 移除。

### 3.3 事件归一化：职责边界（review 2.6，修订）

现状链路：adapter 产出 `ProviderEvent` → `providerRuntime.ts:providerEventSink` → `runEvents.ts:normalizedRunEvent()` → 持久化。目标职责边界：

- **adapter 负责**：native event（Codex JSON-RPC、Claude stream、Pi JSONL、Qoder SDK message）→ `NormalizedEventCandidate`，并完成自身语义归一化（何时 start/progress/completed 由 adapter 判定）。
- **Core 只做 provider-neutral 校验**：schema validation、metadata size bound、统一 redaction、terminal invariant（同一 Attempt 单终态）、unknown-preserve（非 terminal）。
- **原生 payload 不进入通用 discriminated union**：仅通过 versioned bounded envelope 进入 Evidence（`agent_sessions.raw_ref`），Core 不 import adapter 的 mapper。

```ts
// core/eventNormalization.ts
type NormalizedEventCandidate = {
  providerId: ProviderId;
  kind: "started" | "progress" | "approval" | "error" | "completed" | "unknown";
  refs: Partial<ProviderExecutionRef>;
  payload: unknown;                 // adapter 已脱敏/裁剪
  rawRef?: { version: number; size: number };
};
export function validateCandidate(c: NormalizedEventCandidate): NormalizedRunEvent; // provider-neutral
```

`runEvents.ts:providerEventSourceRef` 现拼 `provider:method:session:turn`；改为 `provider:method:invocationRef:messageRef`（terminal 事件幂等去重键，与 §2.3 `terminalSourceRef` 一致）。

### 3.4 resume / recovery（canonical refs 恢复）

- resume 不再强制 `messageRef`：`domain/run/service.ts:549` 改为 `session_ref` 必需、`turn_ref` 可空。
- recovery 用 `ProviderExecutionRef.sessionRef` 恢复：`recovery.ts:13` 的 `providers` 改为 registry；`recoverIssueWithProvider` 调用 `ControlProviderFacet` 或 `ExecutorProvider.execute({resume:{sessionRef}})`。
- accepted 但尚无 sessionRef 的 invocation 恢复：按 intent/outcome 审计 + `registry.collectProcessLeases()` 收敛，不重复发起 Provider call（0069 fail closed）。
- intent→outcome 链路不变；`providerRecoveryInput.session` 改为 `{sessionRef, cursorRef?}`。

### 3.5 interrupt / steer / approval 控制流与 stale 防护

- `ControlProviderFacet.interrupt(InterruptRequest)` 接收 `{ providerId, invocationRef?, sessionRef? }`；优先 active `invocationRef`，manifest 声明 session-level fallback 时允许仅 `sessionRef`。
- `ApprovalResolutionRequest` 必须验证 request ref 与当前 invocation 绑定，跨 Provider/跨 invocation 拒绝（`stale_control_ref`）；duplicate/stale resolution 幂等或 fail closed，保留 0063 审计链。
- `interrupt.ts:325` 的 `sessionRef()` 解析保留；`providerID()` 删除，改 `registry.assertCapability(ref.provider,'interrupt')`。
- 现状冲突处理：`interrupt.ts:105` 对 Codex 无 turn 的静默跳过 → 改为 invocationRef 优先 + manifest 声明的 session-level fallback。

### 3.6 Session list / read / create / resume / fork（review 2.8，修订）

`sessionApi.ts` 重构为纯调度层，并定义聚合分页合同：

```ts
type ProviderSessionCursorV1 = {
  version: 1;
  dbWatermark: string;                        // agent_sessions 水位（updated_at/rowid）
  perProvider: Record<ProviderId, string>;    // 各 provider opaque cursor
  sortKey: "updated_at" | "created_at";
  filterDigest: string;                       // 过滤条件哈希
};
```

聚合语义：

- **authority 优先级**：`agent_sessions` 对 Xuanwu lifecycle status / Run 关联有优先权；Provider discovery 只补充标题、preview、native metadata，不覆盖 authority 字段。
- **分页**：composite cursor 包含 DB watermark + 各 Provider opaque cursor + 稳定排序键 + filter digest；下一页从 cursor 继续，不重复/不漏项；版本化（`version: 1`）。
- **错误隔离**：单 Provider 有独立 timeout/cancellation 与结构化 `provider_errors`；未指定 provider 的聚合查询允许 partial success（其他 Provider 与 DB index 仍返回），指定 provider 的查询直接返回该 Provider 错误。
- **dedupe key**：固定 `<providerId>:<sessionRef>`。
- **有界性**：列表永不读取完整 transcript；单 Provider 慢查询不拖垮全局。
- 现状 `sessionApi.ts:49-96` 的单页 best-effort merge（固定 `nextCursor: ""`）由上述 cursor 合同替换。
- `reconcileCodexSessionIndexes`（`sessionApi.ts:75`）、`pendingCodexSessionFallback`（`sessionApi.ts:357`）下沉 Codex adapter；`sessionApi` 不再出现 `provider.id === "codex"` 分支；未注册 provider 抛 `not_registered`（替代 `sessionApi.ts:59` 的静默 indexed 返回）。
- `steer`/`fork` 新增独立路由（`POST /:key/steer`、`POST /:key/fork`），按 capability 显示。

### 3.7 frontend catalog 动态发现

`/api/providers` → `ProviderCatalogContext`（只读 store）。替换：

- `sessionOptions.js:25` `PROVIDER_OPTIONS` → catalog；`opencode/kimicode` disabled 项删除（不进入 catalog）。
- `sessionOptions.js` `CAPABILITY_LABELS`（含 `transcript_export`，后端 `ExecutorCapability` 无此项）→ 由 manifest `capabilities` 投影；`transcript_export` 作为 Codex `nativeActions` 而非通用 capability（消除 drift）。
- `issueRuns.js:2` `SESSION_CAPABLE_PROVIDERS` → `catalog.capabilities.sessions` 判断。
- `issueRuns.js:19` `providerLabel` switch → catalog `displayName`。
- disabled 与 not_ready 状态在 UI 可区分：not_ready 可见但不可提交，展示 readiness reason。

---

## 4. 数据与兼容

### 4.1 零 schema 迁移下的列映射语义（第一阶段）

| 现有列 | 新语义 | 说明 |
| --- | --- | --- |
| `run_attempts.provider_invocation_ref` | `invocationRef` | 不变 |
| `run_attempts.provider_session_id` | `sessionRef` | 不变 |
| `run_attempts.provider_turn_id` | `messageRef`（legacy carrier） | 允许空；execution-only 留空 |
| `issue_runs.provider_session_id` | `sessionRef` | 不变 |
| `issue_runs.provider_turn_id` | `messageRef` | 允许空 |
| `agent_sessions.provider_session_id` | `sessionRef` | 不变 |
| `agent_sessions.raw_ref` | versioned envelope（见 §4.2） | 唯一 merge writer |

`domain/run/contracts.ts:169` `providerAttemptRef()` 的 `turn_ref !== "" && session_ref === ""` 校验需放宽：允许 `messageRef` 单独存在（execution-only 可能只有 invocationRef）。`service.ts:549` 同步放宽。

### 4.2 raw_ref versioned envelope 与唯一 merge writer（review 2.9，新增）

现状 `upsertAgentSession()` 对非空 `raw_ref` 是整段替换（`db/repositories/agentSessions.ts:19-35`），Session API、runtime event/result 和 settings 都会写该字段，直接塞 `cursorRef` 会互相覆盖。P3 前冻结：

```ts
type AgentSessionRawRefV2 = {
  version: 2;
  namespaces: {
    runtime?: unknown;          // provider runtime 事实
    settings?: unknown;         // 用户/项目设置摘要
    native_refs?: { cursorRef?: string; messageRef?: string };
    provenance?: { updatedAt: string; revision: number };
  };
  sizeBound: number;            // 有界，超限裁剪
};
```

- 所有 writer 通过**同一 repository merge command** 更新（namespace 级合并），不使用散落 SQL。
- monotonic `revision/observedAt` 防止旧 native event 回写覆盖新 cursor。
- 若 cursor 需要查询、约束或频繁更新，应走 additive column/migration，并经 ADR 0070 隔离副本演练，不作为第一阶段默认。

### 4.3 W0-W3 投影切换机制

```text
W0: 旧 projection primary（现状）
W1: registry additive；旧 API/字段 primary，canonical 由同一 writer 双写（feature flag provider_registry_v2=shadow）
W2: canonical primary，legacy projection 由统一 projector 生成 + parity 对比（provider_legacy_projection_compare=on）
W3: 删除代码级 legacy consumer
```

双投影对比：`providerRuntime.ts` 持久化时同时产出 canonical DTO 与 legacy DTO，写入 parity 对比日志（additive，无 schema 风险）；W2 观察窗内对 refs/status/session_count 字段级 diff，drift 触发 telemetry + 自动回滚 flag。**单一 legacy writer**：`core/legacyProjection.ts` 是唯一 `thread_id/turn_id` 产出点，adapter 不重复拼接（现状 `sessionApi.ts:qualifiedProviderSession` 与 `persistSession` 各拼一次，需收口）。

### 4.4 legacy `thread_id/turn_id` projection 单一来源

```ts
// core/legacyProjection.ts
export function legacySessionFields(ref: ProviderExecutionRef): { thread_id: string; turn_id: string } {
  return { thread_id: ref.sessionRef ?? "", turn_id: ref.messageRef ?? "" };
}
```

所有 HTTP 响应、`agent_sessions` upsert、`issue_events` payload 的 `thread_id/turn_id` 统一调用此函数。`codex_thread_id/codex_turn_id` 仅由 Codex compatibility projection 写入，非 Codex Provider 不伪造。

---

## 5. 安全设计

### 5.1 credential 脱敏与 `secret://` 落地检查点

adapter 内 4 个检查点（由 `core/policyResolution.ts` + `security/redactionRegistry.ts` 强制）：

1. **配置读取**：adapter 读取 CLI 凭据时只返回 `authSource`（如 `"codex-cli-login"`），不返回 token/path 内容。
2. **事件脱敏**：`core/eventNormalization.ts` 统一脱敏 + 敏感字段过滤；raw payload 裁剪有界。
3. **错误脱敏**：`ProviderError.message` 经脱敏（`sessionApi.ts:safeSessionError` 先例），裁剪长度。
4. **status 投影**：`registry.list()` 的 `runtimeStatus` 禁止返回 `api_key/token/$HOME/config_dir` 完整路径（`systemStatus.ts:providerEntry` 现状需审计 env_keys）。

新写入 credential 遵循 0073 `secret://` 引用；复用官方 CLI 登录只返回脱敏 readiness。

### 5.2 policy effect-set 模型（review 2.2，重写）

v1 的线性 strictness 比较（`never < danger-only < always` 等）不可靠，证据：前端 `never` 标签为"不询问授权"（`sessionOptions.js:13-17`）；Codex `always→untrusted`、`danger-only→on-request`（`threadLifecycle.ts:191-201`）；Claude 一律 `dontAsk`，实际权限由 tools allowlist 决定（`claude/provider.ts:456-464`）。`never` 不是 deny，`provider-default` 是未知行为。改为 effect-set 模型：

```ts
// core/policyResolution.ts
type PolicyDecision = "deny" | "host_prompt" | "provider_prompt" | "auto_allow";

type ResolvedExecutionPolicy = {
  toolEffects: Array<{
    tool: string;
    decision: PolicyDecision;
    scope: string;                 // 作用域：workspace / path / glob / network host
    ttl?: string;                  // auto_allow 时效
    riskClass: "read" | "write" | "network" | "command";
  }>;
  filesystem: { allowedEffects: string[] };   // 允许行为集合（路径级）
  network: { allowedEffects: string[] };      // 允许行为集合（host/协议级）
  proof: {
    providerVersion: string;
    mappingSource: "official-doc" | "tested" | "unsupported";
  };
};

export function resolvePolicy(
  provider: ProviderId,
  requested: ExecutionPolicy,
  native: NativePolicySupport
): { resolved: ResolvedExecutionPolicy } | { unsupported: "policy_unsupported"; reason: string };
```

判定规则：

1. **filesystem/network 用允许行为集合的子集关系**：resolved effects 必须是 requested effects 的子集；不做数字大小比较。
2. **approvals 不用全序**：decision 按可观察 effect 建模（deny / host_prompt / provider_prompt / auto_allow）+ scope + TTL + risk class；`never` 具体语义由各 Provider 的 effect matrix 声明，不能被 comparator 静默解释为 deny。
3. **`provider-default` 只有在官方合同 + 实测证明具体效果后才参与映射**；否则 `policy_unsupported`。
4. **Provider 原生 permission callback 只能请求授权**，最终仍受 ADR 0063 的 deterministic Action Gate 和 Project policy ceiling 约束（manifest capability 不授予更高权限）。
5. adapter 无法证明 exact/stricter 时返回 `policy_unsupported`，不得忽略参数继续运行（fail closed）。
6. `reasoning/serviceTier` 为偏好，允许 manifest fallback，但 Attempt metadata 记录 `requested/resolved/source`。

### 5.3 进程治理与统一 lease（review 2.3）

- 每 CLI invocation 有 owner/pid/pgid/startedAt/timeout 的 lease（Codex `processLifecycle.ts` + `jsonRpc.ts` `CodexProcessLease` 作模板）。
- `registry.collectProcessLeases()` 是 `processGroupMemory`（RSS/footprint）、`stopAll()`、restart reconciliation 的唯一进程清单；`stopAll()` 幂等，单 Provider 失败有独立 status 不阻塞其余。
- Pi/Qoder/Claude CLI 子进程全部进入 process-group RSS/phys_footprint 预算（替换 `observability/processGroupMemory.ts:128-168` 只对 `inspect()` PID 求和的行为）。
- interrupt 与 timeout 区分 terminal reason（`providerRuntime.ts:providerTerminalOutcome` 已区分 interrupted/cancelled）。

### 5.4 fail-closed 检查清单

未注册 provider / 未声明 capability / 未知终态 / 无法安全映射 policy / stale control ref / approval 跨 invocation → 全部 fail closed（`ProviderError` 分类见计划 §11.4）。

---

## 6. 实施 DAG 细化（review 2.7，恢复计划原始 DAG）

设计必须复用计划 §18 的 DAG，不得自行放宽顺序：

```text
G0 + P0 → P1
P1 → P2（Manifest Registry Conformance）
P1 → P3（Session v2 合同）
P2 → P4（Runtime Config Status）
P2 → P5（Run Recovery Control 泛化）
P3 → P5
P3 → P6（HTTP 与前端动态发现）
P4 → P6
P4 → P7（Codex 迁移）
P5 → P7
P4 → P8（Claude 迁移）
P5 → P8
P4 → P10（Pi Adapter）
P5 → P10
P6 → P10
G10 → P10
P6 → P9（兼容切换与 parity）
P7 → P9
P8 → P9
P10 → P9
P10 → P11（Qoder Adapter）   ← P11 必须在 Pi 暴露的 abstraction gap 收口后
G11 → P11
P9 → P12（模板 文档 清理门禁）
P11 → P12
```

并行边界：

- **可并行**：P7/P8/P10 在 P1–P6 合同冻结后可并行（各自 adapter 内部无共享写冲突）；P5 与 P4 可并行；P6 与 P5 后半可并行。
- **禁止并行**：修改 frozen contracts、registry、config schema、Session DTO；共享 contract、registry、runtime config、Session API 和根入口不得并行修改（计划 §18）。
- **串行门禁**：G10 → P10，P10 → P11，G11 → P11（Qoder 不早于 Pi abstraction gap 收口）；P9 在 P7+P8+P10 后；P12 在 P9 W2 观察窗后。G0/G10/G11 均为不可跳过的 freshness gate，不能用 G0 或历史文档替代实施版本证据。

---

## 7. 测试与 conformance 设计

### 7.1 四层测试

| 层 | 目录 | fixture | 门禁 |
| --- | --- | --- | --- |
| contract/unit | `providers/core/*.test.ts`、`providers/<x>/*.test.ts` | 纯映射、refs、capability、error、redaction、policy effect matrix | CI 必须 |
| offline integration | `providers/<x>/*.integration.test.ts`、`runner/providerRuntime.test.ts` | fake process/SDK、DB reopen | CI 必须 |
| local no-cost smoke | `providers/<x>/smoke.ts` | command/version/auth/session discovery，不发模型请求 | 手动/nightly |
| live acceptance | `providers/<x>/acceptance.md` + 证据 | 真实最小请求/resume/interrupt/restart/usage | 显式授权，supportLevel 提升 |

### 7.2 conformance suite 自动断言范围

`providers/testing/conformanceFixtures.ts` 提供三类 fake provider，`core/conformance.ts` 对每个 registered provider 自动断言：

- initial execution 返回稳定 invocationRef；accepted 与 completion 分离可等待唯一终态；
- accepted 后、terminal 前进程退出；terminal event 与 completion rejection 竞态只产生一个 authoritative terminal outcome；
- accepted 后服务重启，有 invocationRef 但无 sessionRef 时 recovery 不重复发起 Provider call；
- execution-only Provider 不写 Session、resume 明确拒绝；无 messageRef Provider 可 resume；
- unknown event → `unknown/preserve` 非 terminal；timeout/abort 有 terminal reason；
- capability 声明 true 但方法缺失 → 注册失败；声明 false 但方法存在 → 不自动曝光；
- policy 每种 effect 的 positive/negative matrix：`never` 不得被误当作 deny、network unknown、workspace 外写入、跨 invocation approval replay；
- approval duplicate/stale/cross-invocation/cross-provider resolution 幂等或 fail closed，保留 0063 审计链；
- Pi/Qoder/Claude CLI 子进程进入 process-group RSS/phys_footprint，`stopAll()` 与 restart reconciliation 使用同一 lease；
- 单 Provider list 超时时其他 Provider 与 DB index 仍返回；下一页不重复/漏项；
- raw_ref settings/status 更新不覆盖较新 cursorRef；旧 native event 不回退 revision；
- factory 已注册但 CLI 未安装 → catalog 可见、`ready=false`、不可提交；disabled 与 not-ready 状态可区分；
- redaction 对 raw payload 生效。

conformance 不替代 live acceptance（计划 §3.2 非目标）。

---

## 8. 技术风险与未决点

### 8.1 计划/设计未覆盖的缺口

1. **`ProviderRunResult` → 两阶段合同的迁移期**：`providerRuntime.ts:persistRuntimeResult` 同步依赖 `result.session`；`onRunComplete`（`providerRuntime.ts:60`）需重构为 terminal completion 驱动。建议 W1 保留双写，W2 切换（§2.3-6）。
2. **processGroupMemory 改造范围**：`runtime/core.ts:53-70` + `observability/processGroupMemory.ts:128-168` 需改为 lease 聚合；Codex snapshot 经 adapter bridge 投影（§2.7）。
3. **`agent_sessions.raw_ref` merge writer**：需在 P3 前实现 versioned envelope + 唯一 merge command（§4.2）；若 cursor 有查询需求则走 additive column + 0070。
4. **Session 聚合 cursor**：`sessionApi.ts:49-96` 需按 `ProviderSessionCursorV1` 重写分页与错误隔离（§3.6）。

### 8.2 需进一步调研的点

- **Pi `--mode rpc` 的 framing 细节**：LF-delimited JSONL 的 request ID 复用、event 多路复用、abort signal 语义需 G10 实测。备选：Pi 官方 SDK；均不满足硬门槛则 Pi 标 experimental/execution-only。
- **Qoder SDK 类型与 Session list**：`@qoder-ai/qoder-agent-sdk` 的 `sessionId/resume/resumeSessionAt/forkSession` 签名与 `canUseTool` callback 契约需 G11 实测。备选：无公开 list API 时只展示 Xuanwu observation index。
- **Claude `recover()` 的 SDK/CLI 双路径**：`claude/provider.ts` 的 `sdkProvider`/`cliProvider` 需 manifest 声明双 transport，conformance 分别覆盖。
- **policy effect 声明来源**：各 Provider 的 `NativePolicySupport` effect matrix 首版基于官方文档 + 实测；需确认 Codex/Claude 现有映射（`threadLifecycle.ts:191-201`、`claude/provider.ts:456-464`）翻译为 effect-set 后无行为回退。

### 8.3 与仓库现状的冲突点（需在对应工作包显式处理）

- `interrupt.ts:105` Codex 无 turn 时静默跳过 → 改为 invocationRef 优先 + manifest 声明 fallback（review 2.1/§3.5）。
- `sessionApi.ts:59` 未注册 provider 静默返回 indexed → 抛 `not_registered`（§3.6）。
- `providers/types.ts:1` 反向 import `RunCost` → 依赖方向收口（§1.1，review 2.5）。
- `sessionApi.ts:49-96` 固定 `nextCursor: ""` → composite cursor 合同（§3.6）。

---

## 9. 建议补充的合同（P1/P2 冻结前落地）

1. `ExecutionInvocation` / `ExecutionCompletion`：区分 accepted 与 terminal（§2.3）。
2. `ProviderFactory`：`manifest/parseConfig/autoDetect/create`（§2.6）。
3. `ProviderRegistryEntry`：factory catalog 与 runtime instance 状态分离（§2.6）。
4. `ProcessProviderFacet` / `ProviderProcessLease`：聚合全部 Provider 进程（§2.7）。
5. `ResolvedExecutionPolicy`：effect-set 表达与证明来源（§5.2）。
6. `ProviderSessionCursorV1`：DB watermark、per-provider cursor、filter digest、稳定排序（§3.6）。
7. `AgentSessionRawRefV2`：namespace、revision、merge authority、大小上限（§4.2）。
8. `NormalizedEventCandidate`：adapter 产出、Core 只验证/裁剪/投影（§3.3）。

---

## 10. 启动前 blocking decisions（P1/P2 冻结前必须定案）

1. accepted/terminal 两阶段执行合同与 event pump ownership（§2.3）；
2. policy effect-set 模型，废弃 approvals/network 简单线性 strictness（§5.2）；
3. Registry factory catalog 与 runtime instance 双层生命周期（§2.6）；
4. 所有 Provider 统一的 process lease / 内存观测接口（§2.7）；
5. Provider Core 与 Run Domain 的单向依赖（§1.1）；
6. adapter 归一化、Core 校验的事件责任边界（§3.3）；
7. composite Session cursor 与 partial failure 语义（§3.6）；
8. `raw_ref` 唯一 merge writer，或是否提前增加 additive cursor 列（§4.2）；
9. 恢复计划原始 DAG 中 G0/G10/G11 与 P10→P11 的顺序（§6）。

本设计不修改计划 authority；计划仍为实施与门禁的单一入口（架构索引保留主计划）。

---

## 附：设计 Review 意见 → 本文修订位置映射

| Review 条目 | 严重度 | 本文修订位置 |
| --- | --- | --- |
| 2.1 ExecutionHandle 缺终态合同 | 高 | §2.3 两阶段合同、§3.2 时序 |
| 2.2 policy 线性序不可靠 | 高 | §5.2 effect-set 模型重写 |
| 2.3 进程观测硬连 Codex | 高 | §2.7 ProcessProviderFacet、§5.3 |
| 2.4 Registry 生命周期不自洽 | 中 | §2.6 两级模型重写 |
| 2.5 core/domain 依赖环 | 中 | §1.1 依赖方向、§1.2 接线点 |
| 2.6 事件归一化责任 | 中 | §3.3 职责边界重写 |
| 2.7 DAG 与计划不一致 | 中 | §6 恢复计划 DAG |
| 2.8 Session 聚合分页 | 中 | §3.6 composite cursor |
| 2.9 raw_ref 覆盖与 writer | 中 | §4.2 versioned envelope |
| 2.10 supportLevel 绑定错误 | 轻 | §2.5 capability-aware 提升路径 |
| 2.11 deno lint 表述错误 | 轻 | §1.1 Bun architecture test 门禁 |
