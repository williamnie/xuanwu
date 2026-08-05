# ADR-XW-0089 G10：Pi Coding Agent 接口新鲜度 Gate

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 调研日期：2026-08-04（当前实施周期）
- 状态：通过（四项硬门槛全部满足，P10 进入 adapter 实现）

## 1. 版本与官方来源

| 项 | 证据 |
| --- | --- |
| 包 | `@earendil-works/pi-coding-agent`（npm 全局安装） |
| 版本 | `0.83.0`（`pi --version` 输出确认） |
| 安装路径 | `/Users/xiaobei/.nvm/versions/node/v24.11.1/lib/node_modules/@earendil-works/pi-coding-agent` |
| bin | `pi` → `dist/cli.js` |
| 官方类型定义 | `dist/index.d.ts`、`dist/modes/rpc/rpc-types.d.ts`、`dist/modes/rpc/rpc-mode.d.ts`、`dist/cli/args.d.ts`、`dist/core/extensions/types.d.ts` |
| 主入口 | `dist/index.js`（exports `.`），`./rpc-entry` 为 RPC 入口 |
| 依赖版本变化 | 依赖或协议变化时需重跑本 Gate（计划 §17.2） |

## 2. 安装与 runtime 形态

- npm global package；`pi --version` → `0.83.0`；当前平台 macOS arm64（bun 运行）。
- 许可证：见 package.json（描述 "Coding agent CLI with read, bash, edit, write tools and session management"）。
- CLI Mode：`text | json | rpc`（`dist/cli/args.d.ts` `Mode` 类型）。

## 3. headless transport（结构化执行）

**RPC mode（默认候选）**：`pi --mode rpc`，JSON lines over stdin/stdout（`rpc-types.d.ts` 协议注释）：

```text
Commands: JSON objects with `type` field, optional `id` for correlation
Responses: { type: "response", command, success, data|error }
Events: AgentSessionEvent streamed as they occur
```

命令集（`rpc-types.d.ts` `RpcCommand`）：

- `prompt`（message, images, streamingBehavior: "steer"|"followUp"）
- `steer`、`follow_up`、`abort`
- `new_session`（parentSession? → fork/tree）
- `get_state`、`set_model`（provider+modelId）、`cycle_model`、`get_available_models`
- `set_thinking_level`（level）、`cycle_thinking_level`、`get_available_thinking_levels`

并发模型：单进程单 stdin/stdout；command `id` 关联 response；事件流独立。

**terminal signal**：`AgentEndEvent` / `AgentSettledEvent` / `TurnEndEvent` / `TurnStartEvent`（`dist/core/extensions/types.d.ts:540-545`）。AgentEndEvent 携带终态（cause/result）。

## 4. Session/ref 语义

- `SessionManager`（`core/session-manager.ts`）：`SessionInfo`、`sessionId`、`SessionTreeNode`（**tree session**：fork 经 `parentSession`）。
- `new_session` 命令带 `parentSession?` → 分支/续接；`resume/continue` 由 sessionId 定位。
- invocation ref：RPC command `id`（本地关联）；terminal 收敛由 AgentEndEvent 携带的终态驱动。

## 5. interrupt / approval / model / usage

| 能力 | Pi 接口 | 判定 |
| --- | --- | --- |
| interrupt | RPC `abort` command | 支持（invocation-level） |
| steer | RPC `steer` / `follow_up` | 支持（独立命令） |
| approval | RPC 没有 host approval response command；`ProjectTrustStore` 只决定项目本地资源是否加载 | 不声明；仅 `never` 可执行，`danger-only` / `always` fail closed |
| model list | RPC `get_available_models` | 支持 |
| usage/cost | `SessionStats`、model-runtime usage | 支持（attempt 级） |

## 6. 认证与本地配置来源

- `SettingsManager`（`~/.pi` 配置）、`auth-storage.ts` `readStoredCredential`（本地凭据存储）、`ProjectTrustStore`。
- 复用本地配置与凭据：不额外管理密钥（runner 侧零密钥）。

## 7. 硬门槛判定（计划 §17.2）

| 硬门槛 | Pi 0.83.0 | 通过 |
| --- | --- | --- |
| 结构化 headless execution | RPC JSON-lines stdio | ✅ |
| 可信 terminal signal | AgentEndEvent/AgentSettledEvent/TurnEndEvent | ✅ |
| 安全 policy 映射 | approval 仅 `never`；`read-only` 映射为 `--tools read,grep,find,ls`；`danger-full-access` 必须显式选择；无法由 Pi 原生证明的 `workspace-write` fail closed | ✅（capability-limited） |
| 稳定 invocation ref | RPC command id + sessionId + AgentEndEvent 终态 | ✅ |

四项硬门槛全部满足 → **P10 进入 adapter 实现**。

## 8. 已知版本风险与滚动

- 本 Gate 只证明 0.83.0 覆盖合同反例；依赖或协议变化时重跑（计划 §17.2）。
- RPC 协议字段（command id/response/event）以 `dist/modes/rpc/rpc-types.d.ts` 为准；后续版本变更需重验。
- 无真实账号 acceptance 前 supportLevel 保持 `preview`（P8 同规则）。
