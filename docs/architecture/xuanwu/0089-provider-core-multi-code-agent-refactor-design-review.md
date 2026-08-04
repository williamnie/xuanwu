# 0089 Provider Core 多 Coding Agent 架构设计 — Review 报告

- 被评审文档：`docs/architecture/xuanwu/0089-provider-core-multi-code-agent-refactor-design.md`
- 关联计划：`docs/architecture/xuanwu/0089-provider-core-multi-code-agent-refactor-plan.md`
- Review 日期：2026-08-04
- Review 范围：目标模块边界、Core 合同、Run/Session 生命周期、Registry/config、事件归一化、安全策略、进程治理、DAG 与验收可执行性
- Review 方式：只读核对设计、关联计划、现有 TypeScript 实现以及 ADR 0049/0059/0063/0069/0070/0073；未修改设计原文和运行时代码
- 结论：**方向正确，但需修订后再冻结 P1 合同**。当前有 3 项高风险问题和 6 项中风险问题；若直接按现稿实现，可能形成执行终态竞态、权限映射放宽和非 Codex Provider 进程观测缺口。

---

## 一、总体判断

设计对现有硬编码点、Provider facet、canonical refs、Session DTO、兼容窗口和 conformance 分层的判断基本准确，也正确坚持了以下边界：

- `issue_runs` / Run lifecycle command 继续拥有状态 authority；
- Provider Session 只是恢复与下钻事实，不成为 Run identity；
- Provider ID、能力和 UI availability 从 Registry/catalog 发现；
- 不要求 execution-only Provider 伪造 Session 或 message ref；
- 未知事件保留、权限无法证明时 fail closed；
- Codex/Claude 迁移与 Pi/Qoder 新接入分开验收，fixture 不替代真实 acceptance。

主要问题集中在合同精度。文档已经给出了接口名，但部分接口没有把“接受调用、执行中、终态、失败恢复”拆清楚；部分通用层仍通过 Codex 专属接口工作；还有若干地方与已经批准的计划 DAG 或当前持久化行为不一致。因此建议先修订本文，再将 P1/P2 标记为 frozen。

## 二、Review Findings

### 2.1【高】`ExecutionHandle` 只定义“已接受”，没有定义 Runner 如何可靠等待和接收唯一终态

**证据：**

- 设计 §2.2 要求 `invocationRef` 在 `execute` 接受时返回，§3.2 的签名为 `execute(input): Promise<ExecutionHandle>`，但没有 completion promise、terminal receipt、事件流订阅句柄或后台 pump ownership。
- 设计 §3.2 同时描述 `terminal event → reconcileProviderOutcome`，§8.1-1 只提出 W1 保留 `ProviderRunResult` 双写，没有冻结 W2 的终态等待合同。
- 当前 `runIssueWithProvider()` 在 `await provider.run()` 返回后执行 `eventSink.flush()`、`persistRuntimeResult()`、`onRunComplete()`；`projectLoop.ts` 随后再次调用 `reconcileProviderOutcome()`（`backend-ts/src/runner/providerRuntime.ts:56-101`、`backend-ts/src/runner/projectLoop.ts:92-132`）。
- 当前 Provider 返回时机已经不一致：Codex 在 `turn/start` 后立即返回（`providers/codex/provider.ts:74-101`），Claude SDK/CLI 则等 stream/process 终态后返回（`providers/claude/provider.ts:227-269`、`providers/claude/cliProvider.ts:169-189`）。

**风险：**

- adapter 若在接受后立即 resolve，Runner 的 `finally/flush/onRunComplete` 可能早于 terminal event；若 adapter 等终态才 resolve，又失去统一的早期 invocation ref。
- 后台 event pump 抛错、进程在 accepted 后启动失败、terminal event 与 promise rejection 并发时，可能出现无终态、双终态或 project slot/recovery 判断漂移。
- restart 时无法从合同判断谁拥有 pump、谁负责重连，以及 accepted 但尚无 Session ref 的 invocation 如何被恢复。

**建议修正：**

在 P1 冻结一个明确的两阶段合同，例如：

```ts
type ExecutionInvocation = {
  accepted: ExecutionHandle;
  completion: Promise<ExecutionCompletion>;
};

type ExecutionCompletion = {
  ref: ProviderExecutionRef;
  terminal: "succeeded" | "failed" | "interrupted" | "cancelled";
  terminalSourceRef: string;
};
```

也可以由 Runner 持有统一 event stream，但必须明确：

1. `execute()` 何时 resolve；
2. terminal completion 的唯一交付渠道；
3. event pump 的 owner、abort、backpressure 和异常传播；
4. completion 与 terminal event 的幂等关联键；
5. accepted 后进程启动失败、无 terminal、restart 的收敛规则；
6. `onRunComplete` 是“provider accepted”还是“provider terminal”，并据此重命名或拆分。

W1 的 `ProviderRunResult` bridge 应只是兼容投影，不能继续承担 W2 的终态协议。

### 2.2【高】安全策略不能按当前线性顺序比较，尤其 `approvals: never` 语义不等于“更严格”

**证据：**

- 设计 §5.2 用 `read-only < workspace-write < full-access`、`never < danger-only < always`、`deny < provider-default < allow` 表达 strictness，并要求映射到“更严格”结果。
- 当前产品 UI 把 `never` 表述为“不询问授权”，不是“全部拒绝”（`frontend/src/pages/sessions/sessionOptions.js:13-17`）。
- Codex 将 `never` 直接传给 Provider，将 `danger-only` 转为 `on-request`（`providers/codex/threadLifecycle.ts:191-201`）。
- Claude SDK/CLI 将 `never/on-request/danger-only` 映射为 `dontAsk`，实际允许范围另由 tools allowlist 决定（`providers/claude/provider.ts:456-464`、`providers/claude/cliProvider.ts:340-354`）。

**风险：**

- `never` 可能表示“不弹窗但按 sandbox 自动执行”，也可能表示“全部拒绝”，在不同 Provider 中不是同一个安全等级。
- `provider-default` 是未知行为，不能证明介于 deny 与 allow 之间。
- 单个 ordinal comparator 容易把“不询问”误判为严格，实际静默放宽外部写、命令或网络权限。

**建议修正：**

- 不对 approval mode 使用简单全序；改为按可观察 effect 建模，例如 `tool_effect`, `decision = deny | host_prompt | provider_prompt | auto_allow`、scope、TTL、risk class。
- filesystem/network 用“允许行为集合的子集关系”判断：resolved effects 必须是 requested effects 的子集，而不是依赖容易反向理解的数字大小。
- `provider-default` 只能在官方合同和实测证明具体效果后参与映射；否则是 `policy_unsupported`。
- Provider 原生 permission callback 只能请求授权，最终仍受 ADR 0063 的 deterministic Action Gate 和 Project policy ceiling 约束。
- conformance 增加每种 policy 的 positive/negative effect matrix，至少覆盖 `never` 不得被误当作 deny、network unknown、workspace 外写入和跨 invocation approval replay。

### 2.3【高】进程与内存观测仍硬连接 Codex，会漏掉 Pi/Qoder/Claude CLI 子进程

**证据：**

- 设计 §3.1 和 §5.3 继续通过 `registry.get('codex').runtimeSnapshot()` 为 `processGroupMemory` 提供进程树，只要求其他 Provider 暴露 `active_sessions`。
- 当前 `runtime/core.ts:53-70` 的 `runtimeMemoryRows()` 输入确实只包含 runner、agentic worker 和 Codex ownership snapshot。
- `ProcessGroupMemoryObserver` 的 group RSS/physical footprint 只对 `inspect()` 返回的 PID 集合求和（`observability/processGroupMemory.ts:128-168`），不会因 `active_sessions` 自动发现其他 CLI 子进程。

**风险：**

- 新 Provider 的 SDK/CLI 进程不进入权威 `phys_footprint` 预算，可能出现真实内存超限但观测仍健康。
- Core 仍需知道 `codex` 这个 ID 和 `runtimeSnapshot()` 私有方法，违背“新增 Provider 不修改共享核心分支”的目标。
- `stopAll()` 与内存 ownership 使用不同进程清单，重启恢复时可能留下无法归属的孤儿进程。

**建议修正：**

增加通用、可选的进程治理 facet，而不是 manifest 中只有描述性字符串：

```ts
interface ProcessProviderFacet {
  processLeases(): readonly ProviderProcessLease[];
  reconcileProcessLeases?(): Promise<ProcessReconciliation>;
}
```

Registry 聚合所有 Provider lease 后交给 `processGroupMemory`、shutdown 和 restart reconciliation。每个 lease 至少包含 provider、invocation owner、PID/PGID、startedAt 和可安全展示的 command label。`active_sessions` 只能作为状态指标，不能替代 PID 观测。Codex 现有 ownership snapshot 通过 adapter bridge 投影到同一 facet，不再由 runtime/core 直接读取 Codex 私有类型。

### 2.4【中】Registry 同时把 `register` 定义为 factory 注册和 instance 注册，生命周期不自洽

**证据：**

- §2.4 的接口是 `register(factory: ProviderFactory)`。
- §3.1 的伪代码却先 `factory.create(...)`，再 `registry.register(provider)`。
- `RegisteredProvider` 被定义成四个 facet 的交叉类型，但 facet 方法均为 optional，无法表达“这个 instance 实际拥有哪个 facet”。
- `startConfigured()` 遍历写死的 `codex/claude/pi/qoder`，而目标是新增 adapter 只增加注册点和 factory。

**风险：** factory catalog、runtime instance、enabled/ready 状态和 shutdown ownership 会混在一个 map 中；测试注入、重复启动、配置 reload 和启动失败后的状态难以定义。

**建议修正：** 明确两级模型：

1. `registerFactory(factory)`：启动前建立内置 catalog，校验 manifest 和 ID 唯一；
2. `startConfigured(config)`：由 factory 自己解析 Provider-specific config，并生成 0 或 1 个 runtime instance；
3. Registry entry 显式区分 `registered / disabled / starting / not_ready / ready / stopping / stopped / failed`；
4. `getReady(id)` 只返回 ready instance，`describe(id)` 可返回未安装/未配置 catalog entry；
5. `stopAll()` 幂等，部分失败有独立 status，不阻塞其他 Provider；
6. `ProviderFactory` 合同包含 `parseConfig/autoDetect/create`，避免 `ProviderRuntimeConfigs` 再演化成新的闭合联合类型。

### 2.5【中】`core/` 的依赖规则自相矛盾，仍可能形成 Core ↔ Domain 环

**证据：**

- §1.1 先规定 `core/` 不 import `domain/`，随后又允许 import `domain/run/contracts.ts` 的 `RunCost`、`ProviderAttemptRef`。
- 同一节又规定 `domain/*` 只依赖 Provider Core。当前 `providers/types.ts` 已经反向 import `domain/run/contracts.ts` 的 `RunCost`（`providers/types.ts:1`），这是本次重构应收口的现有耦合，而不是固化为目标边界。

**风险：** 即使是 `import type`，架构依赖仍构成双向所有权；未来一旦加入 runtime value/schema，就会变成真实模块循环，也难以用 import-boundary test 表达。

**建议修正：** 选择单向 authority：

- Provider Core 拥有 provider-native usage observation；Domain Run 层把它投影为 `RunCost`；或
- 把双方真正共享的纯值合同放入无业务依赖的 `contracts/` shared kernel。

不要让 Provider Core 直接拥有 `ProviderAttemptRef`；Attempt ref 是 Run Domain 的持久化投影，Core 只提供 `ProviderExecutionRef`。

### 2.6【中】原生事件归一化责任仍可能把 Provider 分支带回 Core

**证据：**

- §3.3 写成 adapter 调用 `core/eventNormalization.ts normalize(providerId, nativeEvent)`。
- `nativeEvent` 对 Codex JSON-RPC、Claude stream、Pi JSONL、Qoder SDK 是不同且不稳定的类型；通用 Core 无法在不知道 Provider 协议的情况下完成语义归一化。

**风险：** 最终会在 `core/eventNormalization.ts` 内出现 `switch(providerId)` 或原生 event union，每新增 Provider 仍需修改 Core。

**建议修正：**

- adapter 独立完成 `native event → ProviderEvent/NormalizedRunEvent candidate`；
- Core 只做 provider-neutral 的 schema validation、metadata size bound、统一 redaction、terminal invariant 和 unknown-preserve 校验；
- 原生 payload 若保留，仅通过 versioned bounded envelope 进入 Evidence，不进入通用 event discriminated union；
- conformance 用黑盒输入/输出断言，不让 Core import adapter mapper。

### 2.7【中】设计 DAG 与批准计划不一致，遗漏 G10/G11 且错误允许 P11 与 P10 并行

**证据：**

- 设计 §6.2 声明 P7/P8/P10/P11 可四路并行。
- 计划 §18 明确 `G10 → P10 → P11` 且 `G11 → P11`；Qoder 需要在 Pi 暴露的 abstraction gap 收口后再开发。
- 设计 §6.3 只列出 P9/P12，没有把 G0、G10、G11 放入串行门禁。

**风险：** P11 可能基于尚未被 Pi 验证的合同并行实现，随后两边同时要求修改 shared contract；也可能绕过实施版本的新鲜度 Gate。

**建议修正：** 设计 DAG 必须直接复用计划 DAG：G0+P0 → P1，G10 → P10，P10+G11 → P11。可以并行的是 adapter 内部无共享写冲突的实现，不能并行修改 frozen contracts、registry、config schema 或 Session DTO。

### 2.8【中】多 Provider Session 聚合没有定义稳定分页、错误隔离和去重 authority

**证据：**

- §3.6 计划把 DB index 与所有 ready Provider 的 `listSessions()` 合并，但没有定义全局排序、相同 Session 的字段优先级、单 Provider timeout 或 composite cursor。
- 当前 Codex 使用 opaque cursor，Claude 使用 offset cursor；现有 `sessionApi.ts:49-96` 最终固定返回 `nextCursor: ""`，只做一页 best-effort merge。
- 设计的 `SessionPage` 已承诺分页，但没有 cursor envelope 合同。

**风险：** 第二页可能重复/遗漏 Session；慢 Provider 拖垮整个列表；Provider discovery 的 idle 状态可能覆盖 Xuanwu 正在运行的 authority；单 Provider 失败可能让全局页面失败或被静默吞掉。

**建议修正：** 定义版本化 composite cursor，至少包含 DB watermark、各 Provider opaque cursor、稳定排序键和 filter digest；明确：

- `agent_sessions` 对 Xuanwu lifecycle status/Run 关联有优先权；Provider discovery 只补充标题、preview、native metadata；
- 单 Provider 有独立 timeout/cancellation 和结构化 `provider_errors`；
- 未指定 provider 的聚合查询允许 partial success，指定 provider 的查询可直接返回该 Provider 错误；
- dedupe key 固定为 `<providerId>:<sessionRef>`；
- 列表永不读取完整 transcript。

### 2.9【中】把 `cursorRef` 放进 `agent_sessions.raw_ref` 尚未解决覆盖与 writer 问题

**证据：**

- 设计 §4.1/§8.1-3 建议第一阶段把 `{cursorRef, version}` 放进 `raw_ref`。
- 当前 `upsertAgentSession()` 对非空 `raw_ref` 是整段替换，而不是字段合并（`db/repositories/agentSessions.ts:19-35`）。Session API、runtime event/result 和 settings 都会写该字段。

**风险：** 后到的 status/settings upsert 可以删除 cursor，旧 cursor 也可能覆盖新 cursor；fork/resume 恢复将依赖一个没有 revision/merge 规则的 side channel。

**建议修正：** 在 P3 前冻结 `raw_ref` versioned envelope 和唯一 merge function，字段分 namespace（例如 `runtime/settings/native_refs/provenance`），所有 writer 通过同一 repository command 更新，并用 monotonic revision/observedAt 防止旧事件回写。若 cursor 需要查询、约束或频繁更新，应走 additive column/migration，并通过 ADR 0070 演练。

### 2.10【轻】通用 `supportLevel` 提升条件错误绑定了 Session 能力和 Pi/Qoder Gate

**证据：** §2.3 将所有 Provider 的 `preview` 定义为“真实最小请求 + resume + interrupt”，并称 `preview→tested` 需要 G10/G11。

**问题：** execution-only Provider 可以被充分测试但永远不支持 resume/interrupt；Codex/Claude 也不应依赖 Pi/Qoder 的 G10/G11。

**建议修正：** `supportLevel` 使用 capability-aware acceptance profile：所有 Provider必须通过 execution terminal/restart/redaction/policy 证据；只有声明 Session/control capability 的 Provider 才要求对应 resume/interrupt/approval acceptance。G10/G11 只约束 Pi/Qoder 实施版本。

### 2.11【轻】文档声称用 `deno lint` 强制 import boundary，但仓库当前是 Bun 且没有该门禁

**证据：** §1.1 声称依赖规则由 `deno lint`/import 边界校验；当前 `backend-ts/package.json` 使用 Bun，仓库没有 Deno 配置或现成 import-boundary rule。

**建议修正：** 将其改成明确交付物，而不是既成事实。例如增加一个 focused architecture test，扫描 `providers/core` 和 adapter import graph，并在 CI/Bun test 中执行；`BOUNDARY.md` 只做说明，不能代替自动门禁。

## 三、建议补充的合同

在 P1/P2 冻结前，建议至少把以下类型写到设计中：

1. `ExecutionInvocation` / `ExecutionCompletion`：区分 accepted 与 terminal。
2. `ProviderFactory`：`manifest`、`parseConfig`、`autoDetect`、`create`。
3. `ProviderRegistryEntry`：区分 factory catalog 与 runtime instance 状态。
4. `ProcessProviderFacet` / `ProviderProcessLease`：聚合全部 Provider 进程。
5. `ResolvedExecutionPolicy`：按 effect set 表达 filesystem/network/tool/approval 结果和证明来源。
6. `ProviderSessionCursorV1`：DB watermark、per-provider cursor、filter digest、stable order。
7. `AgentSessionRawRefV2`：明确 namespace、revision、merge authority 和大小上限。
8. `NormalizedEventCandidate`：adapter 产出，Core 只验证/裁剪/投影。

## 四、建议补充的 conformance / 回归场景

- accepted 后、terminal 前进程退出；terminal event 与 completion rejection 竞态，只能产生一个 authoritative terminal outcome。
- accepted 后服务重启，存在 invocationRef 但尚无 sessionRef；recovery 不重复发起 Provider call。
- `never` 在不同 Provider 的实际效果不能被 comparator 静默解释为 deny；无法证明时 `policy_unsupported`。
- Pi/Qoder/Claude CLI 子进程均进入 process-group RSS/phys_footprint，并由 `stopAll()` 和 restart reconciliation 使用同一 lease。
- 一个 Provider list 超时，其他 Provider 和 DB index 仍返回；下一页不重复或漏项。
- raw_ref 的 settings/status 更新不会覆盖较新的 cursorRef；旧 native event 不回退 revision。
- factory 已注册但 CLI 未安装时 catalog 可见、`ready=false`、不可提交；disabled 与 not-ready 状态可区分。
- capability 声明为 false 但方法存在时不得自动曝光；声明为 true 但方法缺失时注册失败。
- approval duplicate/stale/cross-invocation/cross-provider resolution 全部幂等或 fail closed，并保留 ADR 0063 审计链。

## 五、启动前必须定案的决策

建议把以下项目提升为 P1/P2 的 blocking decisions：

1. accepted/terminal 两阶段执行合同和 event pump ownership；
2. policy effect-set 模型，废弃 approvals/network 的简单线性 strictness；
3. Registry 的 factory catalog 与 runtime instance 双层生命周期；
4. 所有 Provider 统一的 process lease/内存观测接口；
5. Provider Core 与 Run Domain 的单向依赖；
6. adapter 归一化、Core 校验的事件责任边界；
7. composite Session cursor 与 partial failure 语义；
8. `raw_ref` 的唯一 merge writer，或是否提前增加 additive cursor 列；
9. 恢复计划原始 DAG 中 G0/G10/G11 和 P10→P11 的顺序。

## 六、结论

该设计可以作为 Provider Core v2 的基础，但当前不建议直接把 P1/P2 标记为冻结。先解决 2.1、2.2、2.3 三项高风险问题，再收口 Registry/config、依赖方向、事件责任、Session 分页和 raw_ref writer，整体方案即可进入可执行状态。

上述修改不会改变 0089 计划的核心方向，也不要求提前做 DB 迁移；它们主要是把已认可的 authority、fail-closed、动态扩展和可观测性要求落实成不会产生歧义的工程合同。
