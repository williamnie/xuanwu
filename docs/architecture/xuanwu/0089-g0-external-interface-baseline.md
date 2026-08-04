# ADR-XW-0089 G0：外部 Provider 接口基线（反例覆盖汇总）

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 调研日期：2026-08-04（当前实施周期）
- 状态：完成（目标合同覆盖三类真实反例；P1 起合同已按此冻结）

## 目标

计划 §17.1：G0 在 P1 冻结通用合同前，至少覆盖三类真实外部接口反例——execution-only Agent、Pi 树形 Session/RPC、Qoder SDK streaming/permission callback。每份调研记录需包含版本、官方来源、transport、terminal signal、Session/ref 语义、interrupt/approval、认证来源、policy 映射、已知风险（模板见 `0089-gate-investigation-template.md`）。

## 三类反例的证据落地

| 反例 | 证据 | 落地 |
| --- | --- | --- |
| **execution-only Agent** | `fake-execution-only` fixture（P0 `providers/testing/executionOnlyProvider.ts`）：仅 `issue_execution`，不写 Session、无 resume/interrupt/approval | P0 fixture + P1 合同（invocation-only Attempt 完成）+ P2 conformance（resume 明确拒绝） |
| **Pi RPC / tree Session** | G10 gate（`0089-g10-pi-freshness-gate.md`）：pi 0.83.0，RPC JSON-lines stdio；`new_session(parentSession)` 树形分支；`abort` interrupt | P10 adapter（`providers/pi/`，RPC transport + tree fork + agent_settled 终态） |
| **Qoder SDK streaming / permission callback** | G11 gate（`0089-g11-qoder-freshness-gate.md`）：`@qoder-ai/qoder-agent-sdk` 1.0.17，`query()` async generator 流式；`permission_denied` 消息；task_notification 终态 | P11 adapter（`providers/qoder/`，SDK facade + 流式消费 + interrupt） |

## 合同覆盖结论

- §6.2 Execution 引用合同（invocation/session/message/cursor refs 相互独立、可空）：三类反例均覆盖（execution-only 只有 invocationRef；Pi/Qoder 有 sessionRef；messageRef 可选）。
- §7 两阶段执行合同（accepted + terminal completion）：Pi（agent_settled）、Qoder（task_notification）为真实终态信号；execution-only 由 runner 层收敛。
- capability-limited 原则：无稳定接口的能力不声明（Pi list/read/approvals、Qoder list/read/model list）。

## 未来版本重验

G0 只证明目标合同覆盖真实反例，不授权未来版本。依赖版本或官方协议变化时按计划 §17.2 重跑对应 Gate（G10/G11），不沿用旧截图或本文接口假设。
