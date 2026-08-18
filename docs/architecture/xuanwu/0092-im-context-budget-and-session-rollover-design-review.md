# ADR-XW-0092 Review 问题清单

- 状态：Proposed（等待作者修订，未授权实现）
- 日期：2026-08-18
- 对象：[ADR-XW-0092 IM 上下文预算、按需工具与 PI Session 自动换代](0092-im-context-budget-and-session-rollover.md)
- 范围：设计逻辑审查 + 与当前代码的事实核验（`imConversationContext.ts`、`piRuntime.ts`、`imConversationRouting.ts`）+ 相邻 ADR 一致性
- 说明：本清单由独立 reviewer 评审产出，主代理已沿关键行号抽查复核，发现均属实。

## 总体结论

**建议修订后批准。** 方向正确、证据扎实、crash/CAS/安全边界覆盖良好；但须先修补 60%–75% 状态空洞，明确 `unknown_window` 枚举、50 轮触发语义与 rollover 时延策略，再进入 Phase 0。

## 阻断性问题

### B1. §7.4 状态机存在 60%–75% 空洞（L277-280）

原文状态定义：

| 状态 | 条件（默认） |
| --- | --- |
| `green` | projected context `< 50%` window |
| `yellow` | `50%–60%` |
| `rollover_required` | compaction 后仍 `>= 60%`；或达到 rollover trigger |
| `hard_stop` | projected `>= 75%` 且 rollover 未成功 |

若某轮**首次**测得 65%（从未触发过 compaction），则无任何状态/动作匹配——没有任何条款在此区间安排 compaction，请求将带着被侵蚀的输出 reserve 直接发送。这是核心状态机的边界缺失，须补"≥60% 未压缩时先 compact 或推迟本轮"的转移规则。

## 重要问题

### I1. `unknown_window` 枚举缺失（L258）

正文要求缺失 model context window 时"将状态标为 `unknown_window`"，但：
- L153 packet `budget.state` 枚举为 `green|yellow|rollover_required`；
- §7.4 状态表无 `unknown_window`；
- L445 `context_health.state` 为 `green|yellow|rollover_required|hard_stop`。

且 measurement 仅 3 个枚举值，与 §7.2 四级优先级不一一对应（第 3 级归属不明）。恰是 metadata 缺失这一重点场景无法落地。

### I2. 50 轮触发条件自相矛盾（§9.1 #4，L~340）

原文：#4"当前 epoch 已处理 50 个 user turns，作为未知 usage/model metadata 下的安全兜底"——动机限定"未知 usage"，但触发表头写"满足任一条件"，即无条件触发；且与 #5（专管未知 usage 的保守门槛）功能重叠，会强制健康短对话换代。需作者裁决：是无条件上限还是条件兜底。

### I3. rollover prepare 时延未定义（§9.1 / §10.2）

§9.4 表明正常 capsule 依赖 LLM/SDK summary（生成失败才降级为确定性 minimal capsule）；换代又发生在"下一条尚未开始的 IM message 前"，即 prepare 落在用户消息同步路径上。§15 只约束 budget 计算不阻塞，未说明 capsule 生成是否异步预备、超时上限与降级到 minimal capsule 的时机。

## 次要问题 / 建议

1. 头部 canonical 合同漏列实际依赖的 ADR：0063（Action Gate）、0069（restart 恢复）、0072（注入防御）、0073（脱敏）、0075（outbox）。正文多处引用其机制（如 L323 Action Gate、L406 脱敏、L607 outbox）却无编号。
2. L153 packet `budget.state` 缺 `hard_stop`（对比 L445 的 `context_health.state`）。
3. §10.1 rollover row 的 `superseded` 语义不清：§10.2 第 4 步标 superseded 的是旧 conversation，row 何时进入该态未定义。
4. §6.2 三重上限（6 条 × 400 = 2,400 > 2,000 总预算）下，截断时何者优先未写明。
5. §7.1 公式含 `supervisor/entity_context`，§7.3 分桶表未指明其归属。

## 已核验的正面事实

- §2.1 所述 20 条 / 9,000 字符 / 600 字符、51,200 token（128k × 40%）与 `imConversationContext.ts:20-22`、`piRuntime.ts:256-258` 一致；
- 76 + 66 = 142 与 §18 自洽；§7.3 比例合计 100%；§11 示例 breakdown 合计 42,000 自洽；
- §9.4 最小 capsule、§10.2 CAS 两阶段换代、§10.3 crash 恢复点覆盖良好。

## 核验方法

- reviewer 完整读取 633 行原文，核对相邻 ADR（无 0093；0091 为 provider 执行策略主题，无冲突）与代码事实；
- 主代理抽查 B1（§7.4 状态表原文）、I1（L258 vs L153/L445 枚举）、I2（§9.1 触发表）、I3（§9.4 依赖 LLM summary）、次要 1/2/3 的行号与原文，均与评审一致。
