# ADR-XW-0089 G11：Qoder 接口新鲜度 Gate

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 调研日期：2026-08-04（当前实施周期）
- 状态：通过（四项硬门槛全部满足，P11 进入 adapter 实现）

## 1. 版本与官方来源

| 项 | 证据 |
| --- | --- |
| Agent SDK | `@qoder-ai/qoder-agent-sdk` **1.0.17**（npm latest，`npm view` 确认） |
| CLI | `@qoder-ai/qodercli` **1.1.14**（bin: `qodercli`，SDK 经 ProcessTransport 启动） |
| 官方来源 | npm registry（`registry.npmjs.org/@qoder-ai/qoder-agent-sdk`）；SDK 包内 `dist/index.d.ts`、`dist/protocol/messages.d.ts`、`dist/types/session.d.ts` |
| SDK 描述 | "TypeScript SDK for building Qoder-powered coding agents" |
| 安装形态 | npm 包；SDK 通过 ProcessTransport（qodercli 子进程）或 WorkerTransport 通信 |
| 中文镜像 | `@qodercn-ai/qoderclicn` 1.1.14（同协议，地区镜像） |

## 2. headless transport

- **双向 JSON line 协议**（SDK 文档：*"talks to the configured Qoder runtime transport using a bidirectional JSON line protocol"*）。
- 主入口 `query({ prompt, options }): Query`（AsyncGenerator<SDKMessage>）：
  - string prompt 单轮；AsyncIterable<SDKUserMessage> 多轮/流式（`parent_tool_use_id` 续接）。
  - 每条消息带 `uuid` + `session_id`（稳定 invocation ref）。
- 多进程/worker 传输：`ProcessTransport`、`WorkerTransport`（`dist/core/process-transport.d.ts`）。

## 3. terminal signal（可信终态）

- `SDKStatusMessage`：`{ type:'system', subtype:'status', status: SDKStatus, session_id }`。
- `SDKTaskNotificationMessage`：`status: 'completed' | 'failed' | 'stopped'` + `usage {total_tokens, tool_uses, duration_ms}`。
- hook outcome：`success | error | cancelled`（`SDKHookStartedMessage`）。
- 错误：`api_retry`（attempt/max_retries）、`mirror_error`。

## 4. Session/ref 语义

- `SDKSessionInfo.sessionId`（UUID）、`summary`、`createdAt`/`lastModified`、`cwd`、`tag`；本地 JSONL 存储。
- 每条消息 `uuid` + `session_id`；`parent_tool_use_id`（fork/resume 定位）；`parent_agent_id`（subagent tree）。
- resume/fork：session_id + parent_tool_use_id 语义；SessionManager 支持本地会话索引（list/read 可用）。

## 5. interrupt / approval / model / usage

| 能力 | Qoder SDK | 判定 |
| --- | --- | --- |
| interrupt | Query control 方法 + `stopped` 终态 | 支持（invocation-level） |
| approval/permission | `SDKPermissionDeniedMessage`（tool_name/tool_use_id/decision_reason）+ `permissionMode` + permissions 类型 | 支持（policy/host-callback） |
| model list | options.model（performance 等）+ model-prompt-patches | 支持（有限集合） |
| usage/cost | task_notification.usage + SDKUsage | 支持 |

## 6. 认证与本地配置

- `accessToken` / `serviceAccount`（env：`DEFAULT_ACCESS_TOKEN_ENV_VAR`、`DEFAULT_SERVICE_ACCOUNT_ENV_VAR`）、`qodercliAuth`。
- SDK 复用 qodercli 的本地登录/配置（credentials/settings）。

## 7. 硬门槛判定（计划 §17.2）

| 硬门槛 | Qoder SDK 1.0.17 | 通过 |
| --- | --- | --- |
| 结构化 headless execution | SDK query() + JSON line 双向协议 + ProcessTransport | ✅ |
| 可信 terminal signal | SDKStatusMessage / task_notification（completed/failed/stopped） | ✅ |
| 安全 policy 映射 | permission_denied 消息 + permissionMode + permissions 类型 | ✅ |
| 稳定 invocation ref | 每条消息 uuid + session_id（UUID） | ✅ |

四项硬门槛全部满足 → **P11 进入 adapter 实现**。

## 8. 已知版本风险与滚动

- SDK 1.0.17 / CLI 1.1.14 为本 Gate 冻结版本；依赖升级或协议变化时重跑（计划 §17.2）。
- 本机 `qodercli` 若未安装（IDE 安装不保证 CLI），adapter 的 autoDetect 需探测 CLI 可用性，未安装 → `not_ready`。
- 无真实账号 acceptance 前 `supportLevel` 保持 `preview`。
