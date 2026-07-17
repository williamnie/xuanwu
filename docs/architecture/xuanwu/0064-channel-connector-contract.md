# ADR-XW-0064：Channel 与 Connector 统一契约

- 状态：Accepted（W0 additive contract；不迁移既有适配器）
- 日期：2026-07-18
- 路线 issue：XW P09.01 / Runner #717
- 硬依赖：XW P00.04 / #634、XW P06.06 / #685（均为 `done`）
- 可执行合同：`backend-ts/src/integrations/channelConnectorContracts.ts`
- 覆盖校验：`backend-ts/src/integrations/channelConnectorContracts.test.ts`

## 决策

`ChannelConnector` 是所有外部边界的**适配器合同**，不是新的 core object、外部事件存储、Action Gate 或 outbox。它将四种边界显式分开：

| kind | 职责 | 不承担的职责 |
| --- | --- | --- |
| `channel` | 面向人的对话收发（Feishu、CLI、Webhook） | 不决定 Issue/Work/Run 状态，不直接授权外写 |
| `event_source` | 将供应商事件标准化为 inbound envelope | 不把供应商 payload 当可信 domain event |
| `tool_provider` | 暴露受 registry/gate 约束的外部工具能力 | 不绕过 PI tool registry 或 `tool_call_audit` |
| `external_target` | 接收已授权的外部交付（Git、Tracker） | 不拥有 Handoff、approval 或 outbox 状态机 |

manifest 固定包含稳定 id、kind、opaque `secret_ref`、capabilities 与版本；health、cursor、rate limit、inbound/outbound envelope 和 audit 都采用单独的可验证结构。secret 只能由既有配置/secret authority 解析，manifest、health 和 audit 永不携带 secret 值。

## 权限、审计与恢复

- inbound 是不可信输入；`event_type` 必须精确声明为该 adapter 的 inbound capability，未知事件 fail closed，不得在 core 猜测供应商语义。
- outbound 每次必须携带 action id、correlation/event ref、idempotency key 和 `action_gate_ref`；`authorization.authority` 只可为 `deterministic_policy` 或 `human_approval`，且 `decision=allow`。`llm` 不是合法 authority。
- 实际外写仍先经过 P06.06/P08.07 的既有 Action Gate、approval 与 provider/outbox audit；本合同不新增 writer，也不把 LLM 输出变成 capability。
- cursor 只记录 connector/scope/opaque position，和 inbound connector id 绑定；断连、重连次数、错误（已脱敏）由 health 观察，不创建并行连接状态机。rate limit 只承载供应商反馈，retry 仍由现有 provider/outbox policy 决定。

## W0 authority、迁移与回滚

| 事实 | W0 source of truth | P09.01 行为 |
| --- | --- | --- |
| Feishu config/connection/event ingest | `feishuConfig.ts`、`feishuReceiver.ts`、`external_events` | 保留原 writer；P09.02 才做 adapter 映射 |
| CLI connector/tool execution | CLI manifest、`readOnlyToolInvocation.ts`、`tool_call_audit` | 保留既有 registry/gate |
| Git external operations | remote Git provider contracts 与 provider audit | 保留既有 adapter/write context |
| Tracker sync | tracker outbox、Action Gate 与 Tracker adapter | 保留既有 outbox writer |

**W0 双读=0、双写=0。** 本 ADR 仅增加 executable contract，既有 carrier 没有字段映射、没有 shadow writer、没有 cutover。P09.02--P09.05 若迁移某个 adapter，必须逐个声明：field/event mapping、唯一 source of truth、最多两个正式 release 的 W1/W2 双读期限、无副作用 comparison、rollback、consumer-zero 的删除门禁。P09.01 的回滚就是停止采用该 contract；既有 carrier 不受影响。

最终删除须在 P11/G7：每个 adapter 已完成 deterministic replay/recovery、cursor/idempotency/audit parity、连续一个 release legacy consumer=0、fresh backup + isolated restore、retained rollback artifact，且有明确的非 LLM cutover approval。任何一项缺失都不得删除 legacy path 或建立第三 writer。

## 最小验证

```bash
cd backend-ts
bun test src/integrations/channelConnectorContracts.test.ts
```

覆盖 fake connector conformance、未知事件的 adapter allowlist 边界、断连/恢复 health、outbound gate fail-closed 与 secret redaction。
