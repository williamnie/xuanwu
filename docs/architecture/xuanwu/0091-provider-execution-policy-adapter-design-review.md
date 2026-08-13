# ADR-XW-0091 Review 问题清单

- 状态：Resolved；问题已纳入 ADR 修订和本地实现
- 日期：2026-08-13
- 对象：[ADR-XW-0091 多 Code Agent 执行权限与审批适配层设计](0091-provider-execution-policy-adapter-design.md)
- 范围：设计逻辑审查 + 与当前代码的事实核验（Qoder/Claude/Pi/Codex provider、前端、交叉引用 ADR、Pi 官方文档）
- 说明：本清单保留原始 review 发现作为历史记录。下列问题的处理结果以当前 ADR 和实现为准。

## 处理结果

| 项目 | 结果 |
| --- | --- |
| R1 | 已增加 3×3 access × approval matrix；access 是硬上限，审批不能扩权。 |
| R2 | 已增加 Core sensitivity/effect 分类；ask-sensitive 与 ask-every 使用不同确定性 effect。 |
| R3 | 0091 明确复用并替代 0089 临时 effect-set authority。 |
| R4 | approval 绑定 callback owner、invocation、tool call 和 policy revision；只承诺审批最多放行一次。 |
| R5 | Pi Extension 加载失败、confirm false/throw、timeout、cancel 和 disconnect 均 fail closed；发布物携带固定 Extension。 |
| R6 | legacy read 对未知值安全回退并告警；write 拒绝未知值。 |
| R7 | Claude CLI read-only 删除 Bash/curl 例外；Issue/Run 回报由 Runner Host 管理。 |
| R8 | 新 Project 显式写入 full unattended；存量 `{}` 继续从 legacy 翻译。 |
| R9 | approval identity 增加 callback owner 和 revision；内置 Provider 当前不声明 fork，Session create/send/resume 共用 resolver。 |
| R10 | Qoder v1 只使用 default、dontAsk、bypassPermissions。 |
| R11 | proof strength 按 Provider/transport 声明；仅 Qoder observed init 可证明实际 native mode。 |
| F1-F5 | 已按事实修正文档并由对应 mapper、migration、UI 和测试覆盖。 |

## 核验方法

- 文中 17 条事实性断言逐条与代码对照，全部属实；需要修正的细节见「事实修正」节。
- Pi Extension/RPC 能力依据本机安装的 pi-coding-agent 0.83.0 官方文档（README、docs/extensions.md、docs/rpc.md、docs/usage.md）核验。

## 阻塞性问题

### R1｜access × approval 交互语义未定义

- 位置：§1、§4.1、§4.3、§6.3 互相矛盾。
- 问题：§1/§4.3 说「越过已授予范围时发起审批」（审批可临时突破 access），§4.1 说 `read-only`「不允许文件修改」（硬 deny），§6.3 只约束 effective 不宽于 request，但未回答「ask 是否算宽于 read-only」。
- 后果：`read-only + ask-sensitive` 下写操作是 deny 还是 ask？用户 approve 后能否在只读模式执行写？四家 mapper 会各自理解，conformance 无从断言。
- 建议：在 §4 补 3×3 九宫格产品语义矩阵，明确每格的 read/write/command 行为，以及审批是否可越 access 上限。

### R2｜「ask-sensitive」的「敏感」无 Core 级定义

- 位置：§4.1、§6.2、§6.3、§16.1。
- 问题：扁平五维 effect 模型（read/write/command/externalPath/network）表达不了「低风险写自动放行、高风险写询问」；`risk_class` 只在 §9.2 approval request 里出现，§6.2 effect 模型没有。
- 后果：ask-sensitive 与 ask-every-side-effect 在 effect 层面不可区分，§4.2 两个预设形同虚设；§6.3 校验和 §16.1 conformance 无法机械断言。
- 建议：`risk_class` 进入 effect 模型，或承认两档 effect 等价并合并预设。另需显式记录：Codex `on-request` 把敏感度判断委托给模型（LLM 影响 effective policy），与 §3.2 非目标精神冲突，应作为已知限制写入 proof/warnings。

## 中等问题

### R3｜与 0089 effect-set 模型不同构，映射关系未定义

- 位置：§6.2 vs 0089 §5.2（`toolEffects[decision/scope/ttl/riskClass]` + allowedEffects）。
- 问题：两者原则一致（子集、fail closed、proof）但形态不同，0091 仅注明「设计来源是 0089-review」。
- 建议：明确 0091 的扁平五维是替代 0089 effect 模型还是其投影，避免 P0 落 `policyContracts.ts` 时与 Core 既有类型冲突。

### R4｜§9.5 authorized retry 的「exact action」未定义，exactly-once 承诺过强

- 问题：retry 使用新 invocation ref，新 invocation 中 toolCallId 会变，「携带已批准 exact action 的一次性 binding」需要定义 action 指纹（tool name + 归一化 input hash）；模糊匹配有扩权风险，严格匹配可能永远匹配不上。
- 问题：Runner 重启时原生工具可能已部分执行（如 bash 已启动），broker 只能保证审批闸门 at-most-once，保证不了底层工具 exactly-once。
- 建议：补充指纹定义；「同一工具操作不能因 timeout/retry 重复执行」改为「审批不重复放行」，并声明工具级副作用不保证幂等。

### R5｜Pi 两处能力与文档假设不符

依据本机 pi-coding-agent 0.83.0 官方文档核验：

- a) **Extension 加载失败 = 进程 exit(1)**（`dist/main.js:592-595`），非优雅降级。§8.4 约束 7「加载失败只拒绝 ask 模式」要成立，adapter 必须能从 stderr/exit code 识别扩展加载失败并映射为 `approval_bridge_unavailable`，且不得走普通 transient retry。文档未规定检测机制。
- b) **RPC dialog timeout 由 agent 侧以默认值自动解析**（rpc.md:1152）。Extension 必须把 timeout/cancel 显式映射为 `{block:true}`（fail closed）；若 Pi confirm 的默认解析行为未核实，存在超时自动放行的理论风险。conformance 应增加超时 fail-closed 用例。
- c) 表述澄清：`tool_call` 是 Extension **进程内**事件，RPC 事件表（rpc.md:836-860）没有它，宿主收不到；§8.4 第 2、3 条的架构（Extension 内部转 `extension_ui_request`）本身正确，但表述易误读为宿主直接订阅 tool_call。

### R6｜legacy 未知值硬报 validation error 对存量数据有风险

- 位置：§11.2「未知非空值报 validation error」。
- 证据：当前 DB 中 sandbox/approval_policy 为无枚举校验的自由字符串（`backend-ts/src/db/schema/001_base_schema.ts:14-15`，projects 表 default `'workspace-write'`/`'never'`）。
- 风险：若存量项目存在脏值，read boundary 硬报错会让项目打不开。
- 建议：迁移前先 survey 现网 distinct 值；read 路径降级为「默认 + warning」，仅 write 路径硬校验。

### R7｜Claude CLI read-only 目标映射会切断 issue 回报通道

- 证据：现状 CLI fallback 的 read-only 白名单含 `Bash(xuanwu issue update:*)`、`Bash(curl:*)`（`backend-ts/src/providers/claude/cliProvider.ts:357-361`），即 Agent 靠 Bash 向玄武回报进度。
- 问题：§8.3 目标映射 read-only 只给 `Read/Grep/Glob`，会静默切断 issue update 通道。
- 建议：明确回报通道替代方案（SDK host callback？），或在映射中保留受控例外。

## 低优先级问题

### R8｜新旧项目默认分叉未声明

- 存量 `workspace-write + never` 迁移后为 native-dev + unattended，新项目默认 unrestricted-host + unattended。合理但应显式声明为产品决策。
- W0-W2 窗口内新建项目使用哪个 DB 默认值、默认值何时翻转，未规定（§7.1/§11）。

### R9｜审批与会话的边角语义

- §9.2 request identity 缺 runner 实例标识：多 runner 部署时 decision 需路由到持有 callback 的实例。
- policy revision 变更时 in-flight pending request 应标记 stale，未明确规定。
- session fork 的 policy 继承未覆盖（0089 manifest 有 fork 能力，§12.3 只覆盖 create/send/resume）。

### R10｜表述不一致

- §8.1 总览出现 `acceptEdits`，但 §8.3 映射表未使用。
- §8.5 列出 Qoder `plan`/`auto` permissionMode，但全文未说明是否进入 capability 声明。

### R11｜「启动消息验证 native mode」的适用范围

- §5.2 要求「在启动消息中验证实际 native mode 与 resolved policy 一致」，但只对会回报 mode 的 Provider 可行（Qoder init）；Claude/Codex/Pi 无等价回报时 proof 只能到「adapter 已传参」等级。建议按 Provider 声明 proof 强度差异。

## 事实修正

### F1｜Claude 压缩比文档所述更严重

- SDK 侧：`always→default`，其余（never/danger-only/未定义）全部→`dontAsk`（`backend-ts/src/providers/claude/provider.ts:474-476`）。
- CLI 侧：`never/on-request/danger-only→dontAsk`（`backend-ts/src/providers/claude/cliProvider.ts:363-370`）。
- 两侧均无 `bypassPermissions`/`allowDangerouslySkipPermissions` 实现（全仓 grep 未命中），§8.3 的 bypass 映射属目标态。

### F2｜Pi 报错范围更大

- 任何非 `read-only`/`danger-full-access` 值（含空值）都抛错，且空值报错文案误导性显示为 `"workspace-write"`（`backend-ts/src/providers/pi/provider.ts:601-606`；测试 `provider.test.ts:369-383`）。

### F3｜Codex thread 创建层缺口

- thread 创建时 sandbox 原样透传不经归一化（`backend-ts/src/providers/codex/provider.ts:91-92`），仅 turn 层走 `turnSandboxPolicy`（`threadLifecycle.ts:205-216`）。P1「移除 Adapter 读取通用 raw strings」应显式包含 thread 创建路径。

### F4｜080 migration 还改 Pi

- `backend-ts/src/db/schema/080_builtin_executor_sandbox_defaults.ts`（未提交）除把 Qoder 内置 profile 强制设为 `workspace-write` 外，还把 Pi 内置 profile 设为 `read-only`。§17.1 只提了 Qoder 部分。

### F5｜前端硬编码有测试锁死

- `SessionComposer.styles.test.js:65` 断言 qoder 特判存在；P4 删除特判时需同步修改该测试。其余硬编码位置：`ProjectSettingsEditor.jsx:198/211/485-486/537/565`、`NewSessionWorkspace.jsx:124-128/150`、`SessionComposer.jsx:261/265/352`、`SessionInfoPanel.jsx:69`。

## 已核验属实的关键断言（无需修改）

- 通用字符串字段 sandbox/approval_policy 及 Profile→Project 继承（`agentOrchestration.ts:146-160`、`projectLoop.ts:121-122`、`providers/types.ts:143-144`）。
- Qoder 遇 `danger-full-access` 预检抛错（`qoder/permissionBroker.ts:253-254`）。
- 预生成 Session UUID 导致次生错误；`sessionObserved` 修复仅存在于工作区未提交（`qoder/provider.ts`），与 §17.1 描述吻合。
- Claude manifest `approvals: "none"`（`claude/factory.ts:16-19`）。
- Codex 现有映射与 §8.2 一致（`threadLifecycle.ts:191-216`）。
- ProviderRunInput 当前确有 `sandbox?: string`/`approvalPolicy?: string`（`providers/types.ts:143-144`）。
- ADR-0063/0089/0090 均存在且语义一致；0091 编号无冲突。
- Pi `--tools`、`tool_call` block 协议、`extension_ui_request/response`、`-e` 可重复加载均有官方文档支持。

## 统计

共 16 项：2 阻塞（R1-R2）+ 5 中（R3-R7）+ 4 低（R8-R11）+ 5 事实修正（F1-F5）。
