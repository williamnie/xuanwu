# 飞书会话生命周期设计（Draft）

> 状态：Draft，待 review，不是当前实现规范
> 日期：2026-08-01
> 范围：评估 runner 内飞书会话复用设计的恰当性，提出会话生命周期方案（自动轮换 / 主题隔离 / 摘要承接）
> 约束：不修改内核安全/权限/状态机契约；不引入外部依赖；本方案独立于 Persona 灵魂层设计（`2026-08-01-pi-persona-soul-layer-design.md`），但可作为其配套
> 关联实现：`backend-ts/src/integrations/feishuConversationRouting.ts`、`backend-ts/src/integrations/feishuAgentBridge.ts`、`backend-ts/src/db/repositories/feishuConversationState.ts`、`backend-ts/src/http/piConversationApi.ts`

## 1. 背景与现状（代码实证）

### 1.1 路由机制

每条飞书消息经 `feishuAgentBridge.ts` → `routeFeishuConversation()`（`integrations/feishuConversationRouting.ts`）：

- **scope 划分**：有 `thread_id/root_id` → `feishu-thread-<id>`；否则按 `chat_id` → `feishu-chat-<chatID>`；再退化按 `message_id`。
- **默认无限复用**：查 `feishu_conversation_state` 表，存在 `active_conversation_id` 则一直复用该 `pi_conversation`；仅当消息以 `/new` 开头时才 `bumpFeishuConversationEpoch` 生成新会话（命名 `feishu-chat-<chatID>-YYYYMMDD[-nN]`）。
- **无任何规模/时间上限的自动轮换逻辑**；旧版本（7-21 之前）行为是"每天一个新会话"（`-YYYYMMDD` 后缀）。

### 1.2 实测数据（live 库 `~/Library/Application Support/xuanwu-bun-live/state/runner.db`）

| 观测项 | 数值 |
| --- | --- |
| 复用区间 | `feishu-chat-oc_0013...-20260721`，2026-07-20 22:22 创建，复用至 2026-08-01（12 天） |
| 会话文件 | `.runner/sessions/runner/2026-07-20T22-22-21-200Z_*.jsonl`，674KB |
| 消息数 | 197 条 message（user/assistant/toolResult/thinking），另含 2 次 model/thinking change |
| compaction | 已触发 1 次：2026-08-01 01:23，`tokensBefore=78014`，生成摘要 |
| 状态表 | `feishu_conversation_state`：`active_conversation_id` 仍指向 20260721 会话，`epoch=0`（12 天无 `/new`） |
| 会话内容 | 混杂用户聊天（"retry 771"）+ Supervisor 自动任务批次（#777~#786、#821、#822 的决策/汇报/工具输出） |

### 1.3 行为分水岭

| 时间段 | 行为 | 说明 |
| --- | --- | --- |
| 7-04 ~ 7-21 | 每天一个新会话 | legacy 日期后缀，上下文每日隔离 |
| 7-21 之后 | 无限复用同一会话 | 引入 `feishuConversationRouting` + state 表后，改为"复用优先，/new 才换" |

## 2. 两种设计的权衡

### 2.1 旧设计（每日新会话）

- 优点：上下文隔离干净；会话文件小；单会话内主题聚焦。
- 缺点：**跨天上下文全丢**，用户需重新交代项目/偏好/进度；会话碎片化，审计需跨多个会话。这大概率是 7-21 改为复用的原因。

### 2.2 当前设计（无限复用）

- 优点：跨天连续性；用户无需重复交代；会话记录连续。
- 缺点（均有实测支撑）：
  1. **无界增长靠 compaction 兜底，但有真实成本**：78K tokens 触发一次摘要（一次额外 LLM 调用）；早期细节丢失、摘要占据上下文；会话仍在增长，会二次触发。
  2. **多主题/多项目互相污染**：用户聊天与 Supervisor 自动任务批次挤在同一上下文，模型每轮携带 12 天混杂历史（大量 `UNTRUSTED_DATA` 工具输出、状态报告）工作，会加剧回复机械化与上下文漂移。
  3. **上下文定价与延迟**：每轮请求长度 ≈ 20KB system prompt + 历史（compaction 前已达 78K tokens），随天数线性恶化。
  4. **轮换完全依赖用户 `/new`**：无自动兜底，用户不记得则永远不复用重置。

## 3. 结论

当前"无限复用"设计**不恰当**：它把"对话上下文"当作永续账本，而对话上下文应是**可归档、可摘要、按需恢复**的资源。跨天连续性不应由全量历史承担，应由结构化记忆层（已有 `pi_memory_items` / supervisor commitment）承接。

## 4. 建议方案

### 4.1 规模阈值自动轮换（核心）

在 `routeFeishuConversation` 复用分支前增加规模检查：

- 阈值（可配置，建议默认）：消息数 > 150 条，或估算 tokens > 40K（与 SDK compaction 的 keepRecentTokens 预算对齐）。
- 触发时自动 `bumpFeishuConversationEpoch`：创建新 `pi_conversation`（新 session 文件），旧会话保持只读归档。
- **连续性由摘要承接**：轮换时把旧会话的关键信息（活跃项目/偏好/进行中的 Work 与承诺）整理为结构化摘要，写入新会话的初始上下文（复用 supervisorContext / memory / commitment 链路），并生成人类可读的"上期会话摘要"供用户确认。

### 4.2 主题感知分段（独立会话）

- Supervisor 自动任务（manager cycle / heartbeat / auto-manage）不再写入飞书聊天会话，改用独立 conversation（现有 `Supervisor manager cycle` 记录模式），聊天会话只保留用户交互。
- 用户主动触发的任务（如"重试 #771"）留在聊天会话，通过 `target_issue_id` 等结构化字段携带目标，避免任务细节（tool 输出/状态报告）长期驻留聊天上下文。

### 4.3 `/new` 保留为显式重置

- `/new` 仍是用户手段：立即开新会话，并把 persona/用户画像层（见 Persona 设计方案）与活跃项目/承诺带入新会话，避免"换会话 = 失忆"。
- `/new` 幂等且可审计，与 4.1 的自动轮换共用 `bumpFeishuConversationEpoch`。

### 4.4 默认不引入"按日历天轮换"

- 日历天轮换会造成用户隔天上下文断裂的体验问题（2.1），不恢复；轮换依据为规模/主题，而非时间。

## 5. 落地文件清单（Phase 1）

| 文件 | 动作 |
| --- | --- |
| `backend-ts/src/integrations/feishuConversationRouting.ts` | 修改：复用前规模检查 + 自动 bump + 轮换摘要入口 |
| `backend-ts/src/db/repositories/feishuConversationState.ts` | 修改：bump 支持 reason（`/new` / `auto_overflow`），记录轮换原因 |
| `backend-ts/src/pi/sessionRollup.ts` | 新建：旧会话 → 结构化摘要（复用 memory/commitment 链路） |
| `backend-ts/src/http/piConversationApi.ts` | 修改：支持轮换摘要注入新会话初始上下文 |
| `backend-ts/src/config/env.ts` | 修改：轮换阈值配置（消息数/tokens），默认值 |
| `frontend/src/pages/...`（会话列表/详情） | 修改：展示轮换摘要与 `rollup_reason` |
| 测试：`feishuConversationRouting.test.ts`、`sessionRollup.test.ts` | 修改/新建 |

## 6. 风险与回滚

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 自动轮换导致用户感知"上下文丢失" | 中 | 轮换摘要可见 + 旧会话只读归档可回查；阈值默认宽松（150 条/40K tokens） |
| 摘要丢失关键决策 | 中 | 摘要复用 supervisor memory/commitment 确定性数据，而非纯 LLM 总结 |
| 轮换瞬间并发消息路由竞态 | 低 | bump 为单行原子更新；后续消息自然落到新 active 会话 |
| 与 compaction 相互作用（轮换后 compaction 仍会触发） | 低 | 轮换阈值低于 compaction 触发线，实际减少 compaction 次数 |
| 配置错误导致频繁轮换 | 低 | 阈值有下限校验；可关闭（`auto_rollover=off`） |

回滚：关闭 `auto_rollover` 配置即恢复复用行为；旧会话文件/记录不受影响。

## 7. 验证方式

1. 单元测试：规模阈值触发/不触发、bump reason、摘要生成、`/new` 兼容回归。
2. 模拟会话：构造 160 条消息的会话，断言自动轮换 + 摘要注入。
3. 真实观测：对 live 库 20260721 会话应用阈值逻辑（dry-run），核对应轮换点与摘要质量。
4. 回归：`piConversationApi.test.ts`、`feishuAgentBridge` 相关测试全绿。

## 8. Phase 划分

- **Phase 1**：4.1 自动轮换 + 4.3 `/new` 共用 bump + 轮换摘要 + 配置 + 测试。
- **Phase 2**：4.2 主题感知分段（自动任务独立会话），需与 runner 自动接管链路联调。
- 与 Persona 设计方案（`2026-08-01-pi-persona-soul-layer-design.md`）相互独立，可并行实施；两者最终共用记忆/承诺上下文注入。
