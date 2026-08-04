# ADR-XW-0088：常驻无人值守的 AI 工程控制面定位

- 状态：Accepted
- 日期：2026-08-04
- 决策范围：产品类别、公开价值主张、Provider 支持状态与近期路线图
- Supersedes：ADR-XW-0001 中“本地优先、验证优先”的产品类别表述
- canonical 级别：与 ADR-XW-0001 未被本文件覆盖的核心用户、六个核心工作、非目标和迁移约束共同构成产品定位 source of truth

## 1. 背景

“本地优先”容易被理解成离线可用、端侧计算或多端同步，但玄武的实际部署模型是：控制面和
SQLite authority 运行在用户掌控的机器上，Coding Agent Provider、远程 Channel 和外部交付仍可能
依赖网络服务。“验证优先”描述了一项重要的可信交付机制，但没有直接表达用户最有感知的价值：
人在离开终端后，工程工作仍能被持续监督、恢复和推进。

公开 README 还必须区分“已经存在实现”“通过自动化测试”和“完成真实 Provider 端到端验收”，
避免把尚未 live-tested 的 Provider 写成与已验收能力同等级的 available。

## 2. 决策

### 2.1 产品类别

玄武是 **常驻、可无人值守运行的 AI Engineering Control Plane**。

公开英文主张：

> **Run coding agents around the clock.**

公开中文主张：

> **让 Coding Agent 24 小时持续工作。**

“常驻”描述 daemon、scheduler、持久化 Work/Run 和恢复机制的运行模型，不构成可用性 SLA。
宿主机、网络和所选 Provider 仍必须满足执行条件。

### 2.2 用户承诺

> 用户给出工程目标与权限边界后，玄武把目标变成可追踪 Work，在无人值守时跨项目持续调度
> Coding Agent，监督和恢复 Run，检查真实结果并形成可审查 Handoff；只有缺少必要信息、凭据、
> 审批、安全授权或人类判断时才进入 Attention。

无人值守不等于无限自治：

1. 只有权限策略允许、目标和项目边界明确的动作才能自动继续。
2. retry、resume 与 recovery 必须有预算、幂等约束和可审计事实。
3. 无法安全判断时进入 Attention，不允许模型猜测授权或把失败伪装成完成。
4. 用户不需要观察每个 Turn，但必须能审查最终改动、Revision、Evidence 和 Handoff。

### 2.3 部署与验证的定位

- **用户掌控的部署**是重要产品属性：控制面和 SQLite authority 运行在用户掌控的机器上；不再用
  `local-first` 概括产品类别，也不暗示离线或同步能力。
- **验证与 Evidence**是可信交付机制：Agent 的完成文案不构成完成事实；但不再把
  `verification-first` 作为首屏第一价值主张。
- **Engineering Control Plane**仍是产品边界：玄武不替代代码仓库、IDE、CI、Provider runtime
  或 Coding Agent，而是统一管理它们之上的 Work、Run、恢复、Attention 与交付闭环。

## 3. Provider 支持状态合同

公开文档必须使用能够反映真实验收层级的状态，不得把 adapter 存在等同于 Provider 可用：

| 状态 | 含义 |
| --- | --- |
| `planned` | 已进入路线图，尚未形成可执行接入 |
| `preview / not live-tested` | 已有实现和自动化覆盖，但真实账号端到端链路尚未通过 live acceptance |
| `tested` | 真实执行、恢复和交付主链已经过测试；具体覆盖范围仍应在 Provider 文档中说明 |

截至本 ADR：

- **Codex：`tested`**，作为默认完整 Provider。
- **Claude / Claude Code：`preview / not live-tested`**。SDK 和显式 CLI fallback 已有实现及自动化
  覆盖，但真实账号端到端链路尚未完成 live acceptance，不得描述为 production-validated。
- **Kimi Code、Pi、zcode、OpenCode：`planned`**，尚未实现。

这里的第三方 Coding Agent Provider `Pi` 不等同于仓库内沿用的 `PI` Supervisor/持久化兼容标识；
接入设计必须使用无歧义 provider ID。

## 4. 近期路线图

路线按以下顺序推进：

1. **Telegram IM**：远程创建和查询 Work、接收 Attention 与交付通知、审批受控动作；复用统一
   Channel/Connector、通知 outbox 与 Action Gate，不复制第二套状态机。
2. **更多 Coding Agent Provider**：依次评估并接入 Kimi Code、Pi、zcode、OpenCode；所有 Provider
   必须服从统一 Work/Run/Attempt、恢复、权限、Evidence 和 Handoff 合同。
3. **更多 Channel 与 Provider 路由**：按 capability、健康状态和策略选择执行 Provider，并扩展更多
   远程工程入口。

Roadmap 表达方向，不承诺版本或日期。能力只有通过所需的真实集成验收后才能从 `planned` 或
`preview` 提升为 `tested`。

## 5. 保留与变更

ADR-XW-0001 的以下内容继续有效：

- 个人工程师和小型工程团队的核心用户范围；
- 一句话交付、失败恢复、跨项目批量、远程控制、常驻巡检和发布交付六个核心工作；
- Work → Run → Evidence → Handoff / Attention 的事实链；
- 不做通用私人助理、不绕过权限和审计、不复制平行 authority 的非目标；
- source of truth、兼容、回滚与迁移门禁。

被本 ADR 替换的内容仅包括：

- 产品类别不再表述为“本地优先、验证优先”；
- README 第一价值主张改为常驻、无人值守的工程执行与监督；
- Provider 支持必须公开标注真实验收状态；
- 近期公开路线明确为 Telegram，随后扩展 Coding Agent Provider。

本 ADR 不修改 runtime、public API、数据库 schema、状态机或 Provider adapter。
