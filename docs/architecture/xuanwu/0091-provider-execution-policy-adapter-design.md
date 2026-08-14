# ADR-XW-0091：多 Code Agent 执行权限与审批适配层设计

- 状态：Accepted；核心功能已在本地实现并通过离线回归，真实 Provider 与生产 rollout 验收待授权
- 日期：2026-08-13
- 范围：Codex、Claude、Pi Coding Agent、Qoder 的 Project/Profile/Issue/Session 执行策略解析、Provider 原生映射、运行时审批与兼容迁移
- 依赖：[ADR-XW-0063 Approval Action Gate](0063-approval-action-gate.md)、[ADR-XW-0089 Provider Core 架构](0089-provider-core-multi-code-agent-refactor-design.md)、[ADR-XW-0090 Qoder 产品集成](0090-qoder-code-agent-product-integration-design.md)
- Review：[ADR-XW-0091 Review 问题清单](0091-provider-execution-policy-adapter-design-review.md)
- 事实基线：分支 `codex/qoder-code-agent-integration`，基线 HEAD `bc3d17160a71`。本地实现位于未提交工作区。Qoder SDK 固定为 1.0.20，发布运行时固定携带 Qoder CLI 1.1.18；用户全局安装的 Qoder CLI 1.1.20 不作为该 SDK 的执行配对。
- 本文定义 Provider Execution Policy 的产品语义、核心合同、适配责任和迁移边界。本文不授权部署、真实 Provider 调用或历史数据破坏性迁移。

## 1. 决策摘要

玄武负责启动和协调安装在用户电脑上的 Code Agent。各 Provider 使用官方 SDK/CLI 执行任务。玄武不提供跨 Provider 的统一操作系统 sandbox。

玄武负责以下工作：

1. 接收 Provider-neutral 的用户执行意图；
2. 由每个 Provider 的专用 Adapter 转换成原生权限、工具和审批参数；
3. 对 access 范围内且要求确认的工具调用发起可审计审批；
4. 对 Provider 不支持的策略返回具体错误，并保留 Provider 的其他可用组合；
5. 保存 requested、effective 和 native policy 证据。未经明确映射，不得提高或降低权限，也不得声明 Provider 未提供的 sandbox 能力。

系统默认值为：

```text
access = unrestricted-host
approval = unattended
```

该配置用于无人值守开发。默认模式必须允许读写项目、运行 Bash、测试、构建和常规 Git 命令。默认模式不等待交互审批。

用户可以配置较低权限。玄武必须按配置启动 Agent，并允许 Agent 在已授权范围内工作。

审批不能扩大 access。工具调用超出 access 时，玄武直接返回 deny。工具调用在 access 范围内但需要确认时，玄武请求审批。用户拒绝后，玄武向 Agent 返回确定的 deny 结果。较低权限配置本身不得导致启动失败。

本文中的 `fail closed` 表示 effective policy 不得超过 requested policy。它不要求因单个未授权操作而终止整个 Run。

## 2. 背景与根因

### 2.1 现有错误模型

实施前的 Project 和 Agent Profile 使用以下通用字符串：

```text
sandbox = read-only | workspace-write | danger-full-access
approval_policy = never | danger-only | always
```

`resolveExecutorSelection()` 执行 Profile → Project 继承，并将字符串写入 `ProviderRunInput`。Provider Core 当前不执行 capability negotiation，也不生成 requested/effective policy 证据。

这套字段实际上来自 Codex 语义，但四家实现并不等价：

- Codex 有原生 `readOnly/workspaceWrite/dangerFullAccess` sandbox policy；
- Claude 主要使用 permission mode、tools、allow/deny 和 `canUseTool`；
- Pi 通过启动工具集和 Extension 拦截工具，没有 Codex 风格 sandbox；
- Qoder 有 `permissionMode`、tools、allow/deny 和 `canUseTool`，但其 permission policy 不是 OS sandbox。

实施前，Qoder Profile 继承 Project 的 `danger-full-access` 时，Qoder Adapter 会在启动 SDK query 前主动抛出：

```text
Qoder danger-full-access is disabled because Qoder permission policy is not an OS sandbox
```

该错误由玄武 Qoder Adapter 在 SDK query 启动前产生。Qoder CLI 未接收未知 argv 参数。当前实现已删除该 preflight reject，并把该组合映射为 Qoder 原生双开关 bypass。

Adapter 将通用字段直接解释为 Qoder 原生权限，导致 preflight 失败。预生成的 Session ID 随后导致 `Qoder session ... was not found` 次生错误。

### 2.2 更广泛的兼容问题

实施前，同一设计缺陷也出现在其他 Provider：

- Claude 把多个不同 approval 值压成 `dontAsk/default`，UI 所承诺的“敏感确认/每次确认”不一定真实发生；
- Pi 只接受 `read-only` 或 `danger-full-access`，对 `workspace-write` 直接报错；
- 前端通过 `provider === 'qoder'`、`provider === 'pi-coding-agent'` 硬编码禁用项和提示；
- 新增 Provider 必须修改 Project、Profile、Session 等多个页面，容易再次产生 capability drift；
- `sandbox` 一词让用户误以为所有 Provider 都提供同级别 OS containment。

### 2.3 所需的适配边界

```text
当前：Project/Profile generic strings → ProviderRunInput → Provider-specific interpretation

目标：用户执行意图 → Core policy resolution → Provider policy adapter → 原生 SDK/CLI options
```

## 3. 目标与非目标

### 3.1 目标

1. 默认支持高权限、无人值守的持续开发。
2. 用户降低权限后仍可运行；access 范围外的操作返回 deny，范围内需要确认的操作进入审批。
3. 四个内置 Provider 有独立、可测试、可审计的映射。
4. UI 从 Provider Catalog 动态生成权限选项，不再按 Provider ID 写特判。
5. Run/Attempt 保存 requested、effective 和 native mapping，能够解释“为何执行/为何等待/为何拒绝”。
6. 旧 `sandbox/approval_policy` 数据可确定性迁移，不破坏现有 Project/Profile 路由优先级。
7. 新 Provider 只需声明 policy capability 并实现 mapper，不修改 Core 业务分支。
8. Provider preflight 失败不创建未经 Provider 确认的 Session、Turn 或 Provider observation。

### 3.2 非目标

- 不实现一个覆盖所有 Provider 的通用 OS sandbox、容器或虚拟机层。
- 不承诺 Qoder/Claude/Pi 的 tool policy 等价于 Codex sandbox。
- 不把 Provider 工具权限当作 git push、PR、deploy、外部消息或 destructive action 的业务授权。
- 不让 prompt、LLM 文本或 Provider 自报状态修改 Project policy ceiling。
- 不在本 ADR 中删除旧数据库列；删除只能经过独立 consumer-zero 和回滚门禁。
- 默认高权限不向 Agent 透传 Runner bearer token、secret material 或无关环境变量。

## 4. 产品语义

### 4.1 两个稳定维度

Core 保存用户执行意图。Provider 参数由 Adapter 生成。

```ts
export const EXECUTION_POLICY_CONTRACT = "xw.execution-policy.v1" as const;

export type ExecutionAccess =
  | "read-only"
  | "provider-native-development"
  | "unrestricted-host";

export type ExecutionApproval =
  | "unattended"
  | "ask-sensitive"
  | "ask-every-side-effect";

export type ExecutionPolicyRequest = {
  contract: typeof EXECUTION_POLICY_CONTRACT;
  access: ExecutionAccess;
  approval: ExecutionApproval;
};
```

`access` 定义可执行操作的硬上限。审批不得临时提高该上限。

| 值 | 用户可观察语义 |
| --- | --- |
| `read-only` | 允许读取、搜索和分析；拒绝文件修改、命令副作用、网络写入和项目外写入 |
| `provider-native-development` | 允许项目目录内写入、常规开发命令和开发所需的网络读取；项目外写入、权限提升、外部系统写入和独立业务动作不在该范围内 |
| `unrestricted-host` | 允许 Provider 以当前系统用户使用其可用的主机工具；独立业务动作仍受 §14 的 Action Gate 限制 |

`approval` 的产品定义：

| 值 | 用户可观察语义 |
| --- | --- |
| `unattended` | 不等待人工确认；在 access 范围内自动执行 |
| `ask-sensitive` | 普通读取和 routine 副作用自动执行；sensitive 副作用请求一次性审批 |
| `ask-every-side-effect` | 每个写入、命令、外部访问等副作用工具调用分别请求一次性审批；纯读取可自动执行 |

`never` 不再作为新合同名称，因为它可能被误解成“从不允许”。旧 `approval_policy=never` 仅兼容翻译为 `unattended`。

### 4.2 access × approval 语义矩阵

下表定义 Core 合同。`allow` 表示不等待人工确认，`ask` 表示一次性审批，`deny` 表示审批也不能放行。

| access | approval | read | 项目内 write | command | 项目外 write | network / 外部系统写入 |
| --- | --- | --- | --- | --- | --- | --- |
| `read-only` | `unattended` | allow | deny | deny | deny | deny |
| `read-only` | `ask-sensitive` | allow | deny | deny | deny | deny |
| `read-only` | `ask-every-side-effect` | allow | deny | deny | deny | deny |
| `provider-native-development` | `unattended` | allow | allow | allow | deny | network read=allow；Provider tool 外部写入=deny |
| `provider-native-development` | `ask-sensitive` | allow | routine=allow，sensitive=ask | routine=allow，sensitive=ask | deny | network=sensitive ask；Provider tool 外部写入=deny |
| `provider-native-development` | `ask-every-side-effect` | allow | ask | ask | deny | network=ask；Provider tool 外部写入=deny |
| `unrestricted-host` | `unattended` | allow | allow | allow | allow | allow；独立业务动作仍走 Action Gate |
| `unrestricted-host` | `ask-sensitive` | allow | routine=allow，sensitive=ask | routine=allow，sensitive=ask | sensitive=ask | sensitive=ask；独立业务动作仍走 Action Gate |
| `unrestricted-host` | `ask-every-side-effect` | allow | ask | ask | ask | ask；独立业务动作仍走 Action Gate |

`read-only` 的三个 approval 值具有相同 effect。Catalog 只向普通 UI 提供 `read-only + unattended`。高级 API 可以提交另外两个组合，但 resolver 必须返回相同的 deny 上限和 `approval_has_no_additional_effect` warning，不得把写操作转换为 ask。

Action Gate 不提高 Provider access。Git push、deploy 或外部消息等 Runner-owned action 在独立合同下执行；Provider tool 在当前 access 中为 deny 时，Action Gate 的批准不能直接放行该 tool call。

### 4.3 敏感操作分类

Core 使用确定性的 risk classifier。分类时使用规范化 tool family、effect、scope 和完整的结构化工具参数；持久化时只保存脱敏摘要。classifier 不使用 prompt 文本或 LLM 自报结论。

| 分类 | 规则 |
| --- | --- |
| `read` | 只读取项目或已授权输入，不产生持久副作用 |
| `routine` | 项目内普通文件新增或修改，以及 test、build、format、lint、status、diff 等常规开发操作 |
| `sensitive` | 删除或批量覆盖、项目外路径、权限或进程控制、安装软件包、credential 访问、网络访问、Git 历史或远端写入，以及无法确定风险的副作用 |

Provider 原生模式可以决定额外的审批请求，但不能降低 Core 已判定的 `sensitive` 操作。若 transport 不能让 Host 对全部目标工具执行该分类，则只能声明 `provider_prompt` proof，并在 Catalog 和 Run 中返回 `provider_decides_additional_prompt_boundary` warning。无法保证 Core sensitive 下限时，该组合为 `unsupported`。

Codex `on-request` 等原生模式可以由 Provider 或模型决定是否追加请求。该行为不修改 access ceiling，但 proof 强度低于 Host callback。UI 不得将其描述为 Host 对所有敏感操作的确定性拦截。

### 4.4 UI 预设

UI 首版展示四个预设，但数据库保存上述两个稳定维度：

| 预设 | access | approval | 默认 |
| --- | --- | --- | --- |
| 无人值守开发 | `unrestricted-host` | `unattended` | 是 |
| 受控开发 | `provider-native-development` | `ask-sensitive` | 否 |
| 每次副作用都确认 | `unrestricted-host` | `ask-every-side-effect` | 否 |
| 只读检查 | `read-only` | `unattended` | 否 |

高级 API 可以提交其他组合，但必须经过 Provider policy matrix 校验。UI 预设仅用于生成 `ExecutionPolicyRequest`。

“每次副作用都确认”保留 `unrestricted-host` access，并通过 approval 控制每次执行。它适用于需要完整开发能力但要求逐次授权的用户。`read-only` 表示硬限制，不使用一次性审批扩大为写权限。

### 4.5 用户降权后的行为

用户选择较低权限时：

1. Provider 在可表达的最接近且不更宽的范围内启动，并记录所有收窄项；
2. 已允许工具照常运行；
3. access 范围外的工具直接返回 deny；
4. access 范围内且 policy 要求确认的工具进入 `approval_requested/waiting_approval`；
5. 用户批准后只放行当前绑定的工具调用，且不能突破 access ceiling；
6. 用户拒绝后返回 tool deny，Agent 可以继续分析或尝试替代方案；
7. 只有任务最终确实无法在当前权限下完成时，Run 才进入 `needs_user` 或失败终态；
8. Provider/transport 完全不能表达所选策略时，只拒绝本次组合，并返回可选策略，不把 Provider 全局标记为 `not_ready`。

## 5. 分层架构

```text
Project / Agent Profile / Issue / Session
                │
                ▼
       ExecutionPolicyRequest
      (provider-neutral intent)
                │
                ▼
    Provider Core Policy Resolver
  inheritance / legacy / capability
                │
                ▼
 ProviderPolicyAdapter.resolvePolicy()
  Codex | Claude | Pi | Qoder
                │
                ▼
       ResolvedExecutionPolicy
   effects + native mapping + proof
                │
                ▼
       Provider SDK / CLI process
                │
      tool asks │ tool result
                ▼
        Approval Broker / Gate
                │
                ▼
  UI / Command Center / notification
```

### 5.1 Core 的责任

- 解析 Project/Profile/Issue/Session 的继承优先级；
- 翻译旧字段；
- 从 Registry 获取 Provider/transport policy capability；
- 调用对应 mapper；
- 验证 effective effects 不宽于用户 request；
- 持久化安全的 requested/effective/native 摘要；
- 统一错误和 Run 状态；
- 把 approval request 交给既有 Approval Action Gate 和通知链。

### 5.2 Adapter 的责任

- 将稳定意图转换为该 Provider 的原生参数；
- 声明具体 transport 支持的 access/approval 组合；
- 实现逐工具 allow/ask/deny；
- 把 Provider permission request 投影成 normalized approval event；
- 将 human decision 转成 Provider 原生 response；
- 按 Provider 可观测能力记录 proof。只有 Provider 回报实际 mode 时才执行启动后比对；其他 Provider 记录已传参数或 Adapter 拦截证据；
- 对版本变化保持映射测试和 live acceptance。

### 5.3 Core 范围外的职责

- 不通过解析 Bash 字符串实现 OS containment；
- 不知道 `permissionMode`、`sandboxPolicy`、`--tools` 等 Provider 参数；
- 不维护 `if provider === 'qoder'` 一类能力分支；
- 不把某 Provider 的模式名称写入 Project 通用字段；
- 不创建未经 Provider 确认的 Session、tool result 或审批确认。

## 6. Core 合同

### 6.1 Policy capability

Provider Manifest 增加：

```ts
export type ProviderIsolationKind =
  | "os-sandbox"
  | "tool-policy"
  | "tool-selection"
  | "none";

export type ProviderPolicyCombination = {
  access: ExecutionAccess;
  approval: ExecutionApproval;
  support: "native" | "adapter" | "unsupported";
  transports?: readonly ProviderTransport[];
  reason?: string;
};

export type ProviderExecutionPolicyCapabilities = {
  contract: "xw.provider-execution-policy-capabilities.v1";
  isolation: ProviderIsolationKind;
  combinations: readonly ProviderPolicyCombination[];
  defaultPolicy: ExecutionPolicyRequest;
  dynamicRestrictions?: boolean;
  proofCapabilities: {
    nativeMode: "provider-observed" | "argument-passed" | "documented-only";
    toolDecision: "adapter-enforced" | "provider-observed" | "argument-passed" | "none";
  };
};
```

静态 manifest 声明 Provider 和 transport 的实现上限。runtime status 可以根据组织策略、目录信任、CLI 版本和配置进一步限制能力。runtime status 不得增加 manifest 未声明的能力。

### 6.2 Policy resolver facet

本节替代 ADR-XW-0089 §5.2 中 `ResolvedExecutionPolicy` 的临时类型定义。它保留 0089 的 effect-set、子集校验和 proof 规则。实现不得同时维护扁平五维 effect 和 0089 effect-set 两套 Core authority。

```ts
export type ProviderPolicyContext = {
  cwd: string;
  invocationRef: string;
  projectId: string;
  providerId: ProviderId;
  providerVersion: string;
  source: "local-user" | "automation" | "external-channel" | "recovery";
  transport: ProviderTransport;
};

export type PolicyDecision =
  | "deny"
  | "host_prompt"
  | "provider_prompt"
  | "auto_allow";

export type PolicyRiskClass = "read" | "write" | "network" | "command";
export type PolicySensitivity = "read" | "routine" | "sensitive";

export type ResolvedPolicyEffectSet = {
  toolEffects: Array<{
    toolFamily: string;
    decision: PolicyDecision;
    scope: string;
    riskClass: PolicyRiskClass;
    sensitivity: PolicySensitivity;
    ttl?: string;
  }>;
  filesystem: { allowedEffects: string[] };
  network: { allowedEffects: string[] };
};

export type PolicyProof = {
  kind: "provider-native" | "adapter-callback" | "tool-selection" | "action-gate";
  strength: "provider-observed" | "adapter-enforced" | "argument-passed" | "documented-only";
  ref: string;
};

export type ResolvedExecutionPolicy = {
  contract: "xw.resolved-execution-policy.v1";
  requested: ExecutionPolicyRequest;
  effects: ResolvedPolicyEffectSet;
  isolation: ProviderIsolationKind;
  nativeSummary: Record<string, boolean | number | string | string[]>;
  proof: PolicyProof[];
  warnings: string[];
};

export interface ProviderPolicyAdapter {
  resolvePolicy(
    request: ExecutionPolicyRequest,
    context: ProviderPolicyContext
  ): ResolvedExecutionPolicy;
}
```

`nativeSummary` 只保存脱敏、有限长度、可展示的配置摘要，不保存完整 env、settings、callback input 或 secret。API 可以从 effect-set 生成 read/write/command/network 摘要，但该摘要不是校验 authority。

### 6.3 Effect 校验

不能对 approval 使用简单数值全序。Core 按 observable effect set 校验：

- resolved filesystem/network allowedEffects 必须是 request access ceiling 的子集；
- `read-only` 的 write、command、network write 和 external-path write 必须为 deny，不能映射为 prompt；
- `ask-every-side-effect` 中所有非 read effect 必须是 `host_prompt`、`provider_prompt` 或 deny，不得是 `auto_allow`；
- `ask-sensitive` 中 Core 判定为 sensitive 的 effect 必须是 prompt 或 deny；
- `provider_prompt` 必须记录 Provider 决策边界和 proof，不能当作 `adapter-enforced`；
- mapper 可以更窄，例如 Provider 无法运行 Bash 时将 command 解析为 deny，同时返回 warning；
- mapper 不能更宽。无法证明时返回 `policy_mapping_unsafe`；
- network unknown、documented-only proof 和 Provider 默认行为不能作为 allow 的充分证据。

用户选择较低权限时，Adapter 可以生成更窄的 effective policy。该结果允许启动。UI 和 Run metadata 必须显示限制的影响。

### 6.4 ProviderRunInput 迁移目标

目标合同：

```ts
export type ProviderRunInput = {
  // existing identity/prompt/model fields
  policy: ResolvedExecutionPolicy;
};
```

`sandbox?: string` 和 `approvalPolicy?: string` 在兼容窗口内仅由 legacy adapter 接收；具体 Provider 不再读取这些旧字段。

## 7. 默认值、继承与覆盖

### 7.1 默认策略

新 Project 默认：

```json
{
  "contract": "xw.execution-policy.v1",
  "access": "unrestricted-host",
  "approval": "unattended"
}
```

该默认值适用于已注册的本机开发项目。Code Agent 可以持续修改、测试和验证，不等待审批。

新旧数据按以下规则处理：

- authority 切换后创建的新 Project 必须显式写入 `unrestricted-host + unattended`；
- 存量 `workspace-write + never` 按 legacy translator 解析为 `provider-native-development + unattended`，不自动提高到 `unrestricted-host`；
- 存量 Project 只有在用户保存新策略后才写入显式 v1 policy；
- UI 必须显示当前实际来源是 `legacy`、`explicit` 或 `product-default`。

### 7.2 继承优先级

保持既有 Agent Profile 路由，不改变 Provider 选择：

```text
Session/Run explicit policy override
  → Issue explicit policy override（未来 additive）
  → explicit/Issue-selected Agent Profile policy
  → Project policy
  → product default autonomous policy
```

Provider 选择继续是：

```text
explicit profile → Issue profile → Project default profile → Project provider fallback
```

Policy 解析必须在最终 Provider 已确定后执行，不能先按 Project Provider 映射、后切换成 Profile Provider。

### 7.3 空值语义

- 新 Project policy 不允许空；创建时写入产品默认；
- 存量 Project 的 `{}` 在兼容窗口优先读取 legacy 字段，不能直接投影为产品默认；
- Profile 的 policy `{}` 表示继承 Project，不复制当时默认；
- Issue/Session 未提供 override 时继承；
- API 不接受未知 enum 值；
- Provider-native 默认不进入持久化通用合同。

## 8. Provider 映射矩阵

### 8.1 总览

| Provider | read-only | native development + approval | unrestricted unattended | isolation 声明 |
| --- | --- | --- | --- | --- |
| Codex | 原生 readOnly | workspaceWrite + approval callback | dangerFullAccess + never | `os-sandbox`（full access 时无 containment） |
| Claude SDK | tools allow/deny | default + canUseTool | bypassPermissions + explicit safety flag | `tool-policy` |
| Claude CLI fallback | allowedTools | permission prompt tool bridge | dangerously skip permissions | `tool-policy` |
| Pi RPC | 只读 `--tools` | Xuanwu Extension tool_call gate + RPC UI bridge | 默认完整工具集 | `tool-selection` |
| Qoder SDK | tools allow/deny + dontAsk | default + canUseTool | bypassPermissions + explicit safety flag | `tool-policy` |

Proof 能力按 transport 声明：

| Provider/transport | native mode proof | tool decision proof |
| --- | --- | --- |
| Codex app-server | `argument-passed`；Provider 有对应 observation 时可提升 | 原生 prompt 为 `provider-observed`；Host callback 仅按实测覆盖声明 |
| Claude SDK | `argument-passed` | `canUseTool` 为 `adapter-enforced` |
| Claude CLI | `argument-passed` | 当前为 `none`；ask 组合返回 unsupported |
| Pi RPC | `argument-passed` | Xuanwu Extension 为 `adapter-enforced` |
| Qoder SDK | init 回报时为 `provider-observed` | `canUseTool` 为 `adapter-enforced` |

Catalog 不得根据 Provider 名称推断 proof。未回报 native mode 的 Provider 不能声明 `provider-observed`。

### 8.2 Codex Adapter

| Xuanwu request | Codex native mapping |
| --- | --- |
| `read-only + unattended` | sandbox `readOnly`，approval `never` |
| `provider-native-development + ask-sensitive` | sandbox `workspaceWrite`，approval `on-request` |
| `provider-native-development + ask-every-side-effect` | sandbox `workspaceWrite`，approval `untrusted`；所有实际 callback 进入统一 broker |
| `unrestricted-host + unattended` | sandbox `dangerFullAccess`，approval `never` |
| `unrestricted-host + ask-sensitive` | sandbox `dangerFullAccess`；Core-sensitive callback 进入统一 broker；无法覆盖时 unsupported |
| `unrestricted-host + ask-every-side-effect` | sandbox `dangerFullAccess`，approval `untrusted`；所有非 read callback 进入统一 broker；无法覆盖时 unsupported |

约束：

- Codex 原生 sandbox 是唯一可以声明 `os-sandbox` 的当前内置 Provider；
- `dangerFullAccess` 必须在 metadata 中明确 isolation=none/full-host；
- Codex callback 没有覆盖的 tool effect 不能被 UI 宣称为“每个动作都会询问”；需要通过 conformance 记录实际 callback matrix；
- native approval 仍只授权 Provider tool call，外部 Handoff/Deploy 等继续走 ADR-XW-0063。
- thread 创建和 turn 创建都使用同一份 resolved native policy；不得恢复 thread 路径直接透传 legacy `sandbox` 的旧行为。
- `on-request` 由 Codex 决定追加 prompt 时机。若 Host 不能拦截全部 Core-sensitive effect，该组合记录 `provider_prompt` 和 warning，不记录为 `adapter-enforced`。

### 8.3 Claude Adapter

Claude SDK 当前类型提供 `tools`、`allowedTools`、`disallowedTools`、`permissionMode`、`canUseTool`、`permissionPromptToolName` 和 `allowDangerouslySkipPermissions`。

当前 SDK 路径已实现下表映射，包括 `canUseTool` host callback 和 full unattended 的双开关 bypass。CLI fallback 只支持它能证明的 unattended read-only 与 unrestricted-host 组合；需要 host approval 或无法证明项目写入 ceiling 的组合返回 unsupported，并附可选组合。

Xuanwu 默认使用 Claude SDK transport。未配置 API key、OAuth token 或 Anthropic platform profile 时，SDK 复用服务用户的本地 Claude Code 登录。认证来源和 transport 分开配置：`local-cli` 表示凭据来源，不表示使用 CLI fallback。CLI fallback 仅在显式配置 `XUANWU_CLAUDE_MODE=cli-fallback` 时启用。

| Xuanwu request | Claude SDK mapping |
| --- | --- |
| `read-only + unattended` | tools=`Read/Grep/Glob`，写/命令 deny，permissionMode=`dontAsk` |
| native development + `ask-sensitive` | 完整开发 tools；安全读取预授权；副作用进入 `canUseTool` |
| native development + `ask-every-side-effect` | 完整开发 tools；Edit/Write/Bash 等全部进入 `canUseTool` |
| `unrestricted-host + unattended` | permissionMode=`bypassPermissions`，`allowDangerouslySkipPermissions=true` |
| `unrestricted-host + ask-sensitive` | 完整 tools，不使用 bypass；Core-sensitive effect 进入 `canUseTool` |
| `unrestricted-host + ask-every-side-effect` | 完整 tools，不使用 bypass；所有非 read effect 进入 `canUseTool` |

Claude CLI fallback：

- read-only 使用 `--allowedTools` 和有限 tool set；
- 当前 CLI transport 不声明 ask 模式；只影响该 transport 的组合，不影响 Claude SDK 或 Claude Provider 全局 readiness；
- unattended full access 使用官方 skip-permissions 参数，并在 argv audit 中只记录布尔摘要，不记录 prompt/secret。

CLI read-only 白名单只包含读取工具，不包含 `Bash(xuanwu issue update:*)` 或 `Bash(curl:*)`。Runner Host 负责 Issue/Run reconciliation；只读模式不借助 `curl` 获得通用网络访问。

Claude manifest 的 approval 能力为 `host-callback`，对应 SDK transport。具体组合仍以 execution policy capability matrix 为准；CLI ask 组合不得因该 coarse capability 被错误启用。

### 8.4 Pi Coding Agent Adapter

Pi RPC 原生支持启动工具选择；本机已核验的 0.83.0 版本还提供：

- Extension 进程内的 `tool_call` event，在工具执行前返回 `{block, reason}`；该 event 不出现在宿主 RPC event stream 中；
- RPC `extension_ui_request`，支持 `confirm/select/input`；
- RPC `extension_ui_response`，可返回 confirmed/cancelled；
- `--extension/-e` 加载受控 Extension。

当前 Pi Adapter 使用 v1 policy mapper，不再通过 legacy `sandbox` 字符串判断启动能力。read-only 使用受限工具集；需要审批的组合加载 Runner-owned Extension；unattended full access 不加载审批 Extension。

因此 Pi 不必永久局限于“只读或全开”。目标映射：

| Xuanwu request | Pi mapping |
| --- | --- |
| `read-only + unattended` | `--tools read,grep,find,ls` |
| native development + `ask-sensitive` | 完整工具 + Xuanwu Pi Policy Extension；bash/edit/write 按 risk 请求审批 |
| native development + `ask-every-side-effect` | 完整工具 + Extension 对 bash/edit/write 分别请求一次性审批 |
| `unrestricted-host + unattended` | 默认完整 Pi 工具，不加载 approval-blocking extension |
| `unrestricted-host + ask-sensitive` | 默认完整工具 + Extension；Core-sensitive effect 请求一次性审批 |
| `unrestricted-host + ask-every-side-effect` | 默认完整工具 + Extension；所有非 read effect 请求一次性审批 |

Pi Policy Extension 约束：

1. 由 Runner 发布物提供固定、版本化、只读的 extension path；不能从 Issue prompt 指定；
2. Extension 在进程内接收 `tool_call`，并通过 `ctx.ui.confirm()` 生成 `extension_ui_request`；
3. RPC transport 把 `extension_ui_request` 投影为包含 `toolCallId/toolName/脱敏 input/cwd/session` 的 Xuanwu approval request，并关联到当前 invocation；
4. human decision 通过 exact request ID 回写 `extension_ui_response`；
5. deny 返回 `{block:true, reason}`，Agent 可以继续；
6. response 必须验证 invocation/session/toolCallId，拒绝 stale 或跨 Run 复用；
7. Pi 0.83.0 在 Extension 加载失败时记录诊断并以 exit code 1 退出。Adapter 必须识别 `Failed to load extension` 诊断，将 ask 组合映射为 `approval_bridge_unavailable`，且不进入普通 transient retry；
8. ask 组合启动失败后不得在同一 invocation 中移除 Extension 后继续。用户可以使用新的 invocation 选择 unattended/read-only；
9. `confirm()` timeout 返回 `false`。Extension 必须将 `false`、cancelled、AbortSignal 和 bridge disconnect 全部转换为 `{block:true}`。conformance 必须验证 timeout fail closed。

### 8.5 Qoder Adapter

Qoder 官方 SDK/CLI 的关键原生能力：

- `permissionMode=default|acceptEdits|bypassPermissions|plan|dontAsk|auto`；
- `tools/allowedTools/disallowedTools`；
- `canUseTool` typed callback；
- `allowDangerouslySkipPermissions` 作为 bypass 的显式第二开关；
- 非默认模式受 trusted directory 和组织策略约束。

v1 capability 仅使用 `default`、`dontAsk` 和 `bypassPermissions`。`acceptEdits`、`plan` 和 `auto` 不进入 v1 policy matrix。后续版本只有在定义独立产品语义、effect-set 和 conformance 后才能启用这些模式。

映射：

| Xuanwu request | Qoder mapping |
| --- | --- |
| `read-only + unattended` | tools=`Read/Grep/Glob`，deny Edit/Write/Bash/NotebookEdit，permissionMode=`dontAsk` |
| native development + `ask-sensitive` | 完整开发 tools；读取预授权；副作用由 `canUseTool` risk gate 决定 |
| native development + `ask-every-side-effect` | 完整开发 tools；所有副作用工具进入 `canUseTool` |
| `unrestricted-host + unattended` | permissionMode=`bypassPermissions`，`allowDangerouslySkipPermissions=true` |
| `unrestricted-host + ask-sensitive` | 完整 tools，permissionMode=`default`；Core-sensitive effect 进入 `canUseTool` |
| `unrestricted-host + ask-every-side-effect` | 完整 tools，permissionMode=`default`；所有非 read effect 进入 `canUseTool` |

Qoder Adapter 已移除以下旧行为，后续实现不得恢复：

- 看到 `danger-full-access` 就在 Xuanwu Adapter 内抛错；
- 因无法提供 OS sandbox 而无条件禁用 Bash；
- 在 Qoder 确认 Session 前发布预生成的 UUID；
- 将 Qoder `dontAsk` 映射为 full access。`dontAsk` 表示不显示审批请求，并拒绝未预授权的操作。

启动后必须读取并记录 init 中的实际 permission mode。若 trusted directory 或组织策略将 bypass 降为 default，玄武返回 `provider_policy_downgraded` 并中断本次 invocation。

参考：[Qoder Permission Control](https://docs.qoder.com/en/cli/sdk/permissions)、[Qoder CLI Permissions](https://docs.qoder.com/en/cli/permissions)。

## 9. Approval Broker 与运行状态机

### 9.1 状态流

```text
running
  │
  ├─ allowed tool ───────────────► running
  │
  ├─ tool requires approval
  │       │
  │       ▼
  │  approval_requested
  │       │
  │       ▼
  │  waiting_approval
  │       │
  │       ├─ approve once ──────► provider allow ──► running
  │       ├─ deny ──────────────► provider deny  ──► running/best effort
  │       ├─ cancel ────────────► interrupted/cancelled
  │       └─ timeout/restart ───► provider deny/stale ──► running or terminal
  │
  └─ provider terminal ─────────► succeeded/failed/needs_user
```

`waiting_approval` 是运行状态。它不属于 Provider error，且不触发普通自动 retry。

### 9.2 Request identity

统一 approval request 至少绑定：

```text
provider_id
project_id
issue_id
run_id
attempt_id
invocation_ref
callback_owner_ref
session_ref (if observed)
provider_tool_call_ref
tool_name
risk_class
redacted_input_summary
requested_effect
policy_revision
created_at / expires_at
```

`callback_owner_ref` 标识持有原生 callback 的 Runner 实例和进程 lease。单实例部署也必须生成该值，以便重启后识别 stale request。

任何缺失 invocation binding、callback owner 不匹配、跨 Provider、跨 Session、跨 policy revision 或已 terminal request 的 decision 都必须拒绝。policy revision 变更时，旧 revision 的所有 pending request 立即标记为 stale 并向仍存活的 callback 返回 deny。

### 9.3 Decision scope

v1 只要求 `once` 是完整、可验收能力：

- `approve once` 只放行 exact tool call；
- `deny` 只拒绝 exact tool call；
- Provider 提供的“always allow” suggestion 不自动升级成 session/project grant；
- session/project scope 只有在 ADR-XW-0063 的 TTL/revoke/policy ceiling 完成后才能开启；
- `ask-every-side-effect` 必须始终使用 once scope。前一次批准不得自动应用于后续调用。

### 9.4 Deny 后继续

用户拒绝工具调用后，Issue 可以继续运行：

- Adapter 向 Provider 返回原生 deny/tool error；
- denial reason 必须说明用户未授权；不得将其报告为文件不存在或命令失败；
- Agent 可以改用只读分析、提出 patch 建议或请求另一条能力；
- 只有 Provider 给出权威失败终态或验收无法满足时，Run 才失败/needs_user。

### 9.5 Timeout 与重启

- callback 活着时，Run 可以保持 `waiting_approval`；
- 用户选择 ask 模式，即接受可能暂停，无人值守默认不会进入该状态；
- 达到配置的 approval lease 上限后，不自动 allow；当前工具调用返回 deny。Agent 可以继续只读分析或选择替代方案；只有 Provider 终止或任务无法继续时，Run 才收敛到 `needs_user`/failed；
- Runner 重启或 callback owner lease 失效时，将 pending request 标记为 stale。旧 request 不能继续批准；
- 新 invocation 不继承旧 invocation 的 `approve once`。Provider 再次产生同一工具调用时，系统重新分类并重新请求审批；
- Approval Broker 只保证一个 request 最多放行一次，不保证底层工具 exactly-once；
- 工具在进程中断前可能已经开始或部分产生副作用。自动 retry 仅适用于 Provider 明确证明未开始执行，或工具本身具有独立幂等键的情况；
- restart 或无法证明工具是否已执行的场景不自动 retry。需要继续时创建新 invocation，并由用户确认外部状态。

### 9.6 Notification

Approval request 可通过：

- Command Center Attention；
- Run/Session UI；
- 已配置的 Feishu/其他通知 outbox；
- 本地桌面通知。

Notification 仅用于传递 approval request。只有通过 bearer-authenticated、session-bound resolver 写入的 human decision 才能放行 Provider callback。

## 10. Provider Manifest、Catalog 与 UI

### 10.1 Catalog projection

`/api/providers` 增加：

```json
{
  "execution_policy": {
    "contract": "xw.provider-execution-policy-capabilities.v1",
    "isolation": "tool-policy",
    "default_policy": {
      "access": "unrestricted-host",
      "approval": "unattended"
    },
    "combinations": []
  }
}
```

Catalog 合并 static manifest 与 runtime restriction，返回每个 transport 当前可提交组合、原因和警告。

### 10.2 UI 规则

Project Settings、Agent Profile、New Session、Session Composer 必须复用同一个 policy model：

- 从 catalog 生成预设和高级组合；
- 不再写 `provider === qoder/pi/...`；
- 默认选择“无人值守开发（高权限）”；
- 明确展示 isolation badge：OS sandbox / tool policy / tool selection / none；
- 用户选低权限时显示“任务可能等待审批或无法完成”，但允许保存和运行；
- 当前 transport 不支持组合时禁用该组合并展示原因，不隐藏整个 Provider；
- 历史 unsupported 值必须在编辑页显示。表单初始化不得修改该值；
- 保存前调用 policy resolve API，展示 effective effects 和 warning。

### 10.3 UI 文案

禁止文案：

- “所有 Provider 都在安全 sandbox 中”；
- “workspace-write 一定只能访问项目目录”；
- “dontAsk 等于完全访问”；
- “Qoder 不支持 full access，因此无法执行开发任务”。

推荐文案：

- “无人值守开发：使用该 Provider 的最高可用本机权限，不等待工具确认”；
- “受控开发：在当前 Provider 可拦截的范围内，敏感工具调用会暂停并通知你”；
- “Provider 原生工具策略不提供操作系统隔离”；
- “只读模式仍会运行分析；需要修改时会报告权限不足”。

## 11. API 与持久化

### 11.1 Additive schema

新增版本化 JSON 列：

```text
projects.execution_policy_json text not null default '{}'
agent_profiles.execution_policy_json text not null default '{}'
```

未来如支持 Issue override，再独立增加 `issues.execution_policy_json`，不复用 workflow prompt 或 provider_config_json。

JSON 示例：

```json
{
  "contract": "xw.execution-policy.v1",
  "access": "unrestricted-host",
  "approval": "unattended"
}
```

Profile `{}` 表示继承。存量 Project `{}` 在兼容窗口读取 legacy 字段。authority 切换后的新 Project 由 repository create path 写入显式 v1 值。

### 11.2 Legacy translation

兼容翻译：

| legacy sandbox | access |
| --- | --- |
| `read-only` | `read-only` |
| `workspace-write` | `provider-native-development` |
| `danger-full-access` | `unrestricted-host` |
| 空 | Project 在兼容窗口读取 legacy 默认；Profile 继承 |
| 未知非空 | read API 保留原值并返回 warning；执行时使用 `read-only` 安全回退 |

| legacy approval_policy | approval |
| --- | --- |
| `never` | `unattended` |
| `danger-only` / `on-request` | `ask-sensitive` |
| `always` / `untrusted` | `ask-every-side-effect` |
| 空 | Profile 继承；Project 使用 `unattended` |
| 未知非空 | read API 保留原值并返回 warning；执行时使用 `ask-every-side-effect` 安全回退 |

Legacy translator 只存在于 Core compatibility layer，Provider Adapter 不读取旧字符串。未知值回退必须记录 `legacy_policy_unknown`、原字段名和脱敏后的原枚举值。write API 拒绝未知值。迁移前必须查询 Project 和 Profile 的 distinct legacy values，并将结果纳入 migration evidence。

### 11.3 双读/双写窗口

- W0：新增 parser/resolver，旧字段仍 authority，shadow 计算新 policy 并做 parity test；新建 Project 继续使用旧 DB 默认；
- W1：新 API/UI 写 `execution_policy_json`，同时写可逆 legacy projection；新建 Project 显式写 `unrestricted-host + unattended` 及 legacy projection `danger-full-access + never`；运行时新列优先、旧列 fallback；
- W2：运行时只消费新 policy；旧字段继续 readback 兼容，不再作为 authority；
- W3：一个正式 release consumer-zero、备份/恢复演练后，另行决定是否删除旧列。

任何阶段都不能让 Profile 的空 override 被双写成当时 Project 值，否则会破坏未来继承。DB column default 保持 `{}`，产品默认由 repository create path 显式写入。authority flag 切换发生在 W1 验收完成后，不通过修改旧列 DB default 隐式完成。

### 11.4 Resolve API

建议新增：

```text
POST /api/providers/:id/execution-policy/resolve
```

请求：

```json
{
  "project_id": "demo",
  "transport": "sdk",
  "policy": {
    "contract": "xw.execution-policy.v1",
    "access": "provider-native-development",
    "approval": "ask-sensitive"
  }
}
```

响应只返回安全摘要：

```json
{
  "supported": true,
  "isolation": "tool-policy",
  "effects": {
    "read": "allow",
    "write": "ask",
    "command": "ask",
    "network": "provider-controlled"
  },
  "warnings": []
}
```

该 API 是 preview/validation，不替代 Run 启动时的 authoritative resolution。启动时必须使用当前 Provider/runtime version 重新解析。

## 12. Run、Attempt 与 Session 接线

### 12.1 Run 启动

顺序固定：

1. 决定最终 Provider/Profile；
2. 解析 effective requested policy；
3. 获取当前 Provider/transport runtime capability；
4. 调用 mapper；
5. 验证 effect 不扩权；
6. 创建/更新 Attempt intent 和 resolved policy metadata；
7. 调用 Provider；
8. 只在真实 Provider message/init/result 观察到 Session ref 后写 provider session observation。

Policy resolution 在 CLI spawn 前失败时：

- Run/Attempt 保存 configuration error；
- `provider_session_id`、`provider_turn_id` 保持空；
- Runs UI 显示配置错误，不显示可点击的 Session；
- 不把 configuration error 当可重试 transient provider failure。

### 12.2 Attempt metadata

至少保存：

```json
{
  "requested_execution_policy": {},
  "resolved_execution_policy": {},
  "provider_policy_capability_revision": "...",
  "provider_version": "...",
  "transport": "sdk",
  "resolution_source": "profile|project|legacy|default",
  "classifier_authority": "host|provider|none",
  "proof_strength": ["adapter-enforced"],
  "warnings": []
}
```

原生 summary 只保存允许字段，例如 `permissionMode`、tool names、sandbox type、approval bridge enabled。禁止保存完整 command input、env、credential 或 callback payload。

### 12.3 Session create/send/resume/fork

Session API 与 Issue Run 使用同一个 resolver：

- create 使用当前 Project/Profile/explicit override；
- send/resume 默认沿用 Session 已保存 requested policy；
- 用户显式改变 policy 时创建新的 policy revision，并在下一 invocation 生效；
- policy revision 变更时，旧 revision 的 pending approval 全部 stale/deny；
- 不能用 message 时的新 policy 反写历史 invocation；
- resume 必须重新检查当前 Provider/runtime 是否仍支持原策略；
- fork 复制父 Session 的 requested policy snapshot，但不复制 pending approval、callback owner 或一次性 grant；子 Session 首次 invocation 使用新 invocation ref 并重新 resolve；
- 若组织策略收紧，返回包含处理建议的 warning 或 error。不得自动提高或降低权限。

## 13. 错误分类与用户动作

| code | 含义 | Run 行为 | 用户动作 |
| --- | --- | --- | --- |
| `policy_invalid` | 请求合同/枚举非法 | 不启动 | 修正配置 |
| `policy_combination_unsupported` | 当前 Provider/transport 无法表达该组合 | 不启动本次 invocation；Provider 仍 ready | 选择 catalog 提供的组合或切 transport |
| `policy_mapping_unsafe` | mapper 无法证明不会扩权 | 不启动 | 升级 Adapter/Provider 或选择更窄策略 |
| `legacy_policy_unknown` | 存量 legacy 字段包含未知值 | 使用安全回退并记录 warning | 在设置页确认并保存新策略 |
| `provider_policy_downgraded` | Provider 启动后实际 native mode 与 resolved 不一致 | 中断 invocation，不创建 Session 成功记录 | 修复目录信任/组织配置 |
| `approval_required` | 工具需要 human decision | `waiting_approval` | approve/deny/cancel |
| `approval_denied` | exact tool 被拒绝 | 返回 tool deny，Run 可继续 | 无或调整策略 |
| `approval_expired` | callback lease 过期 | stale/deny，并进入 `needs_user` | 核对副作用状态后启动新 invocation |
| `approval_owner_stale` | callback owner 已重启或 lease 失效 | stale/deny，并进入 `needs_user` | 核对副作用状态后启动新 invocation |
| `approval_bridge_unavailable` | transport bridge 未就绪 | 只影响 ask 模式 | 切 SDK/其他策略 |
| `permission_insufficient` | Agent 在当前权限下无法完成 | `needs_user` 或 provider terminal failed | 提高权限或缩小任务 |

错误必须包含：provider、transport、requested combination、原因、当前支持组合和建议。不得包含 token、绝对敏感路径或完整命令内容。

## 14. 安全边界

### 14.1 高权限模式的业务限制

`unrestricted-host + unattended` 允许 Code Agent 使用本机开发能力，但不自动授权：

- git push / force push；
- 创建 PR、发布、deploy；
- 外部消息、工单和生产写入；
- 删除项目外数据；
- secret 读取或权限提升；
- 修改 Xuanwu 自身 policy/approval authority。

这些动作继续受任务明确意图、Project policy ceiling、ADR-XW-0063 Action Gate 和外部 provider receipt 约束。

### 14.2 进程环境

所有模式都保持：

- 固定为已注册 Project 的 canonical cwd；
- 不允许 Issue/外部 channel 覆盖 command path；
- 使用 managed env allowlist；
- Runner bearer token、secret store material 和无关凭据不进入 Agent env；
- PATH、HOME 等 Provider 登录必需环境只按 runtime config 传递；
- full access 模式仍启用 process lease、interrupt、timeout 和 redaction。

### 14.3 Source 与 policy ceiling

Source 不得修改用户保存的 policy。系统可以使用 Project policy ceiling 执行 admission：

- 本地用户创建的 Work/Issue 按 Project policy；
- Automation/外部 channel 不能把 Project 从低权限提升到 full access；
- 外部输入只能在 Project 已授予范围内触发；
- prompt injection 检测可以要求额外 human action，但不能自行 grant；
- Source restriction 必须生成独立的 gate 和 audit 记录，不得记录为 Provider sandbox 限制。

## 15. 可观测性与审计

### 15.1 必须记录

- requested/effective policy；
- inheritance source 和 policy revision；
- Provider/transport/runtime version；
- native mode/tool scope 安全摘要；
- risk classifier authority 和 policy proof strength；
- 每次 ask/allow/deny/cancel/expire；
- human actor、decision reason、scope；
- provider acknowledgement；
- callback/extension bridge latency；
- policy-related terminal reason；
- 无 Session preflight failure 的明确标记。

### 15.2 指标

建议指标：

```text
xuanwu_provider_policy_resolution_total{provider,outcome}
xuanwu_provider_policy_warning_total{provider,code}
xuanwu_provider_approval_requested_total{provider,tool_class}
xuanwu_provider_approval_wait_seconds{provider}
xuanwu_provider_approval_decision_total{provider,decision}
xuanwu_provider_tool_denied_total{provider,reason}
xuanwu_provider_policy_downgrade_total{provider}
```

### 15.3 告警

- 同 Provider policy mapping 短期连续失败；
- actual native mode 与 resolved mode 不一致；
- pending approval 超过 SLA；
- approval decision 找不到 active invocation；
- policy preflight failure 却写入了 provider session ref；
- unattended 默认模式频繁出现 permission denied。

## 16. Conformance 与测试矩阵

### 16.1 Core contract tests

对每个 Provider/transport 遍历：

```text
3 access × 3 approval combinations
```

断言：

- manifest 声明与 mapper 实现一致；
- unsupported 组合返回确定性 code 和 alternatives；
- effective effects 不宽于 request；
- access ceiling 不能由 approval 提高；
- 三个 `read-only` 组合都对 write/command/network write 返回 deny；
- `ask-sensitive` 对 Core-sensitive effect 只能返回 prompt 或 deny；
- `ask-every-side-effect` 对所有非 read effect 不能返回 auto_allow；
- host_prompt、provider_prompt 和 auto_allow 具有不同 proof；
- 默认 `unrestricted-host + unattended` 可解析；
- Core 接受 Provider 声明支持的较低权限组合；
- legacy 已知值翻译稳定，未知值使用安全回退并保留 warning；
- Provider 切换后重新映射，不复用上一个 Provider native options。

### 16.2 Provider unit tests

Codex：

- 三种 sandbox policy 和 approval 映射；
- callback allow/deny；
- thread start 和 turn start 使用同一个 resolved native policy；
- on-request 的 Provider 决策边界记录 provider_prompt proof；
- danger full default 不等待审批。

Claude：

- SDK tools/allow/deny/canUseTool；
- bypass 必须带 explicit flag；
- CLI ask 组合返回 unsupported 和可选策略；
- CLI read-only 不包含 `xuanwu issue update` 或通用 `curl` Bash 例外；
- SDK 和 CLI 通过 transport-specific policy matrix 声明各自能力。

Pi：

- read-only tool list；
- Extension `tool_call` block；
- RPC confirm request/response correlation；
- approve/deny/timeout/restart；
- confirm timeout/cancel/bridge disconnect 返回 `{block:true}`；
- Extension 加载错误映射为 `approval_bridge_unavailable`，不进入 transient retry；
- unattended/read-only 的新 invocation 不加载 approval Extension。

Qoder：

- dontAsk 不映射为 full access；
- bypass 带 explicit flag；
- ask-sensitive 与 ask-every-side-effect callback matrix；
- trusted directory/native mode downgrade；
- preflight error 不创建未经 Qoder 确认的 Session；
- full 或 approved 模式允许 Bash 时，Adapter 不得无条件阻止调用。

### 16.3 Run/Session integration tests

- Profile → Project policy inheritance；
- Project Provider 与 Profile Provider 不同；
- new Session/send/resume/fork 使用同一 policy resolver；
- fork 不继承 pending approval 或 once grant；
- waiting approval 不触发普通 retry；
- deny 后 Agent 可继续并产生最终回答；
- approval timeout 对当前工具调用 fail closed 为 deny；Provider 无法继续时才进入 needs_user/failed；
- restart 后 stale callback 不被复用；
- policy revision 变更使旧 pending request stale；
- Approval Broker 最多放行一次，不声明工具副作用 exactly-once；
- unsupported combination 不污染 Provider readiness；
- provider session link 只在真实 session observed 后出现。

### 16.4 Frontend tests

- Catalog 驱动四个预设；
- 扫描 Project/Session UI，不允许新增内置 Provider ID policy switch；Provider-specific 模型和诊断 UI 可以保留；
- 默认显示无人值守高权限；
- 选择低权限可以保存/启动；
- unsupported transport 只禁用对应组合；
- isolation/warning 准确展示；
- API save/readback 不把非 Codex model/default 泄漏到其他 Provider。
- Qoder 模型兼容测试与 execution policy 测试分离，删除权限特判时不得删除模型能力逻辑。

### 16.5 Live acceptance

每个 Provider 使用真实安装版本和隔离测试仓库验证：

1. unattended 模式完成读、改、测试、构建；
2. ask-sensitive 的 routine 操作自动执行，Core-sensitive 操作触发真实 callback/bridge 或明确返回 unsupported；
3. ask-every-side-effect 的每个非 read 操作触发审批或 deny；
4. approve 后同一 invocation 继续；
5. deny 后 Agent 收到 deny 并继续；
6. read-only 能完成分析，写入尝试直接 deny 且不能通过审批放行；
7. session/ref/terminal/usage 证据完整；
8. interrupt/restart/timeout 收敛，且不复用旧批准；
9. 不暴露 credential；
10. 无付费或真实账号调用时不得声称 live-tested。

## 17. 实施分期与文件落点

### P0：定义合同与基线（本地已完成）

- 新增 `providers/core/policyContracts.ts`；
- 新增 `providers/core/policyResolution.ts`；
- 新增 `providers/core/legacyExecutionPolicy.ts`；
- 扩展 `providers/core/manifest.ts`、catalog 和 conformance；
- 使用本 ADR 的 effect-set 替代 0089 §5.2 的临时类型，不保留第二套扁平 effect authority；
- 建立四 Provider 当前 mapping snapshot；
- 不改变 live 默认，不迁 DB。

### P1：Provider mappers（本地已完成）

- `providers/codex/executionPolicy.ts`，同时覆盖 thread start 和 turn start；
- `providers/claude/executionPolicy.ts` + approval broker；
- `providers/pi/executionPolicy.ts` + Runner-owned Pi Extension/RPC bridge；
- `providers/qoder/executionPolicy.ts` + permission broker 重构；
- 移除 Adapter 读取通用 raw strings；
- 保留 Qoder only-real-session fix。

### P2：Run/Session 接线（本地已完成）

- `pi/agentOrchestration.ts` 只解析 policy inheritance，不做 Provider mapping；
- `runner/providerRuntime.ts` 在 spawn 前 resolve；
- `runner/projectLoop.ts`、recovery、interrupt 使用 resolved policy/ref；
- `http/sessionApi.ts`、session runtime settings 统一接线；
- Attempt metadata 保存 policy evidence。

### P3：Schema/API 兼容迁移（本地 schema/API 已完成，live survey pending）

- additive DB migration；
- survey Project/Profile legacy distinct values；
- repositories 双读/双写；
- Project/Profile HTTP validation；
- resolve API；
- migration rehearsal、backup/restore、legacy parity。

### P4：Catalog-driven UI（本地已完成）

- Project Settings；
- Agent Profile Manager；
- New Session Workspace；
- Session Composer；
- 删除 Qoder/Pi/Claude execution policy 特判；保留与模型、Session 诊断等其他 capability 相关的 Provider UI；
- 增加 isolation/effective effects/warnings。

### P5：真实验收与默认切换（离线完成，live pending）

- focused backend/frontend suites；
- full Bun/frontend test、lint、build、diff check；
- 四 Provider live acceptance；
- 新源码已经使用 v1 policy authority；当前工作区未部署。四个 Provider 的 default high-permission 模式完成真实读写、Bash、test/build 和无审批等待验收后，才允许发布为生产默认；
- rollout 期间保留 legacy read 和快速回滚开关。

### 17.1 Migration 处理结果

临时 `080_builtin_executor_sandbox_defaults` 已移除，替换为 `080_execution_policy_json`。该 migration 只增加 Project/Profile policy JSON 列。新 Project 默认由 repository 显式写入；Profile `{}` 保持继承。旧字段继续双写并可回读。

Qoder 只在 SDK init 观察到真实 Session 后发布 Provider Session ID。preflight 失败不会写入合成 Session。

### 17.2 本地实施与验证记录

截至 2026-08-13，本地工作区完成以下实现：

- Core policy contracts、legacy translation、effect validation、capability matrix 和 resolve API；
- Codex、Claude SDK、Pi RPC、Qoder SDK 专用 mapper 与 approval broker/bridge；
- Project/Profile 双读双写、Profile 继承、Run/Attempt metadata 和 Session create/send/resume 共用 resolver；
- Catalog-driven Project/Profile/Session UI；
- Pi policy Extension、Qoder CLI 1.1.18 和 Claude SDK executable 随二进制相邻打包。

本地验证结果：

| 验证 | 结果 |
| --- | --- |
| Backend 全量测试 | 2118 pass，0 fail |
| Frontend Node tests | 528 pass，0 fail |
| Frontend Bun tests | 6 pass，0 fail |
| Frontend lint/build | 通过 |
| daemon/release scripts | 7 pass，0 fail；相关 shell 脚本通过 `bash -n` |
| Binary packaging | `xuanwu`、Claude SDK executable、Qoder CLI bundle、Pi policy Extension 均生成并通过存在性检查 |

以上是离线和 fake-provider 证据，不是四家真实账号 live acceptance。未执行部署、真实 Provider 任务或付费调用。

## 18. Rollout、回滚与删除门禁

### 18.1 Feature flags

以下 shadow/authority flags 仍是生产 rollout 建议，当前本地实现未增加这两个环境变量：

```text
XUANWU_PROVIDER_POLICY_V1_SHADOW=1
XUANWU_PROVIDER_POLICY_V1_AUTHORITY=0
```

如上线流程要求逐实例灰度，应在部署前实现这些 flags。当前可用的回滚手段是保留的 legacy 双读/双写数据和 release/code rollback；不存在运行时 shadow 开关。

### 18.2 回滚

- P0/P1：停用新 mapper，回 legacy path；不删除新 metadata；
- P2/P3：authority flag 回旧字段，停止新写，保留 additive column；
- P4：前端可回 catalog legacy projection；
- pending approval 在回滚时全部 deny/stale，不自动 allow；
- 已发生的 Provider 或外部动作不执行状态回写，也不记录为已撤销。

### 18.3 旧列最终删除门禁

必须同时满足：

- 至少一个正式 release legacy consumer=0；
- Project/Profile/API/CLI/UI read/write parity；
- 所有 Provider live acceptance；
- fresh DB backup 和 isolated restore rehearsal；
- rollback artifact 保留；
- 无 active migration/approval；
- 明确非 LLM destructive approval。

未满足则保留旧列，不影响新 authority。

## 19. 验收标准

### 19.1 产品验收

- 新 Project 默认无人值守高权限；
- 默认运行不会因普通读写/Bash/test/build 请求审批；
- 用户可选受控开发、每次副作用确认或只读；
- 低权限仍启动并尽力工作；
- access 范围外的调用返回明确 deny；access 范围内需要确认的调用才通知用户；
- waiting approval 可在 UI/通知中处理；
- Provider 不支持某组合时只影响该组合/transport；
- UI 不再按 Provider ID 硬编码权限逻辑。

### 19.2 技术验收

- 四家 mapper 通过同一 effect matrix；
- Core 不包含 Provider native permission 名称；
- Adapter 不读取 legacy sandbox/approval strings；
- requested/effective/native policy 可审计；
- policy preflight 不创建未经 Provider 确认的 Session；
- Qoder full access 映射为原生 bypass，Adapter 不得因该配置直接报错；
- Claude ask 模式有真实 callback/bridge；
- Pi ask 模式有真实 Extension/RPC bridge；
- Codex 既有 tested path 无回归；
- restart/timeout/stale approval 不重复放行；工具副作用不声明 exactly-once。

### 19.3 安全验收

- 用户未授权的 effect 不会执行；
- unattended full access 是显式默认且 UI 清楚说明；
- Agent env 不含 Runner secret；
- external/destructive action 继续受 Action Gate；
- approval decision exact-bound、一次性、可审计；
- 系统可以检测 Provider 的未声明 downgrade；
- 未知的新合同值、Provider 或版本 fail closed，但不会把其他可用模式一并停用；未知 legacy 值按 §11.2 安全回退并警告。

## 20. 设计要求

1. 新 Project 默认使用高权限无人值守策略。
2. 较低权限策略必须允许 Agent 在授权范围内运行。access 范围外的调用只能 deny，审批不能提高 access。
3. 每个 Code Agent 必须实现独立的 policy mapper 和 approval bridge。
4. 文档、API 和 UI 必须区分 tool policy、tool selection 和 OS sandbox。
5. requested、effect-set、native policy、classifier authority 和 proof strength 必须可查询和审计。
6. unsupported 结果只影响具体的 Provider、transport 和 policy 组合。
7. Runs 和 Session UI 只显示 Provider 已确认的 Session ref。
8. 主机工具权限不自动授权 push、deploy、external write 或 destructive action。
9. UI 必须从 Provider Catalog 读取权限选项和 capability 说明。
10. SDK 或 CLI 升级后，必须重新运行 mapping conformance 和 live acceptance。

## 21. 外部与仓库证据

- [Qoder Agent SDK Permission Control](https://docs.qoder.com/en/cli/sdk/permissions)
- [Qoder CLI Permissions](https://docs.qoder.com/en/cli/permissions)
- [Claude Code CLI Reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- 本机核验版本：`@earendil-works/pi-coding-agent 0.83.0` 的 `docs/extensions.md`、`docs/rpc.md` 和 `dist/main.js`
- 本仓库 Codex mapping：`backend-ts/src/providers/codex/threadLifecycle.ts`
- 本仓库 Claude SDK/CLI mapping：`backend-ts/src/providers/claude/provider.ts`、`backend-ts/src/providers/claude/cliProvider.ts`
- 本仓库 Pi RPC/Provider：`backend-ts/src/providers/pi/rpcTransport.ts`、`backend-ts/src/providers/pi/provider.ts`
- 本仓库 Qoder SDK/permission：`backend-ts/src/providers/qoder/sdkFacade.ts`、`backend-ts/src/providers/qoder/permissionBroker.ts`
- Provider Core effect-set 设计来源：`0089-provider-core-multi-code-agent-refactor-design-review.md`
