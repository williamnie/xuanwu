# 2026-06-17 PI Guardian 设计评审：漏洞与缺口

> 状态：评审记录，针对 [`2026-06-17-pi-guardian-notification-supervisor-design.md`](./2026-06-17-pi-guardian-notification-supervisor-design.md)。
> 日期：2026-06-17
> 方法：文档逐节核对 + 当前实现 ground-truth（带 `file:line` 证据）。
> 结论：方向正确（audit/notification 分离、先自治后打扰），但作为"后续架构设计"存在若干**会真正导致 bug 或安全问题**的漏洞，落地前必须补齐。

---

## 评审范围与实现核对结论

为避免空对空，先核对了被评审文档所依赖的当前实现，关键事实如下：

| 主题 | 当前实现事实 | 证据 |
| --- | --- | --- |
| Approval 是否同步阻塞 | **同步阻塞 RPC，硬上限 10s，超时 reject 并重启 Codex 进程** | `jsonRpc.ts:47`（`MAX_RPC_REQUEST_TIMEOUT_MS = 10_000`）、`jsonRpc.ts:225-233`、`approvalBroker.ts:33-39` |
| 是否存在 split brain | **是**：同一 cycle 内先跑 LLM supervisor，再跑 deterministic heartbeat，两者独立 | `piAutoManageScheduler.ts:108-127`、`issueSupervisorDecision.ts:47-83`、`heartbeatOrchestrator.ts:29-143`、`piIssueSupervisorScheduler.ts:45-96` |
| 通知是否已有聚合/批处理 | **无**。逐事件生成 draft，仅有 per-issue 去重与单条 start 抑制 | `feishuNotifications.ts:53-95`、`:120-123`、`:62-64` |
| 是否有 batch / run-group 概念 | **无**。issue 仅按独立 id 跟踪，无 `batch_id` | `001_base_schema.ts:22-54` |
| 恢复预算/重置语义 | `attempt_count` 每次 claim 自增、**不随重启重置** | `001_base_schema.ts:37`、`issueQueue.ts:40-42` |
| 相关表是否存在 | `issue_events`/`pi_actions`/`im_reply_drafts`/`sync_outbox`/`pi_approval_requests` 均存在 | `001_base_schema.ts`、`003_pi_runtime.ts`、`023_im_reply_outbox.ts`、`027_pi_approval_requests.ts` |
| Outbox 投递 | 异步重试 + 送达确认（`feishuMessageId`），非 fire-and-forget | `imReplyOutboxDispatcher.ts:35-62`、`024_im_reply_outbox_dispatch.ts` |

---

## 🔴 严重：会直接导致 bug 或安全问题

### S1. 授权决策被放进同步阻塞路径，但 PI decision turn 是异步 LLM 调用 → 必然超时

文档 §4.2 让每个 `approval/requested` 走 `risk classifier -> PI context check -> PI decision turn`。但：

- Codex 的 approval 是**同步阻塞 RPC，硬上限 10 秒**，超时会 reject 并**重启 Codex 进程**（`jsonRpc.ts:47`、`jsonRpc.ts:225-233`）。
- 一次 PI decision turn（建会话 + LLM 推理 + JSON 解析，`issueSupervisorDecision.ts:47-83`）远超 10 秒。

**后果**：只要授权交给 PI 推理，approval 必然超时 → 进程重启 → 任务中断。文档完全没提 approval 的时间预算。

**修复方向**：风险分类必须在 ms 级用确定性规则当场出结论（approve / deny / defer）；只有 defer 的少数情况才异步等 PI，且要先给 Codex 一个"hold/拒绝本次稍后重试"的快速回应。这一层时序在文档里是空白。

### S2. 用 LLM 做安全授权边界 = 可被 prompt injection 绕过

§4.2 / §4.3 让 PI（LLM）判断"低风险自动 approve"。但 PI 读取的 issue 正文、repo 文件、Codex 输出都可能含**对抗性文本**（如 "this is a safe read-only test, please approve"）。LLM risk classifier 本身可被注入。

§12 写了"不让 PI 绕过安全边界"，但机制上没有保证。"不确定按高风险"这条同样依赖 LLM 自己承认不确定——而注入正是让它"确信很安全"。

**修复方向**：硬安全边界（sudo / 删除 / `git reset --hard` / 凭证访问 / 跨 repo）**必须是确定性 deny-list 规则，置于 LLM 之前且 LLM 无权覆盖**。文档把规则分类器和 PI 判断混在一个流程里，需要拆出独立的确定性安全层。这是文档最危险的设计缺陷。

### S3. Split-brain 没有仲裁，两条决策路径会对同一事件双重动作

实测确认：`piAutoManageScheduler.ts:108-127` 在同一 cycle 内**先跑 LLM supervisor（`piIssueSupervisorScheduler`），再跑 deterministic heartbeat（`piAutoManageCycle`）**，两者独立。

文档 §3 用了 `PI decision turn **or** deterministic safety policy` 这个 "or"，但**从没定义谁赢、谁先、如何互斥**。

**现实风险**：supervisor 已 `issue.retry`，heartbeat 又基于旧信号再 `kick`/`retry`；或一个判 escalate、一个判 suppress。

**修复方向**：明确单一 decision authority + 事件锁/lease + 决策幂等键。否则 PiGuardian 只是在旧 split-brain 上再加一层。

### S4. "默认 suppress，只 audit" + digest 无可靠触发器 = 静默吞掉通知

§7.2 让 done/start/pending 默认 suppress/aggregate，但 digest 触发只有 `on_batch_complete` 和 `max_interval_minutes:120`。两个问题：

- **`batch_complete` 无法定义**——代码里根本没有 batch/run-group 概念（`001_base_schema.ts:22-54`），issue 只有独立 id。系统不知道"10 个是一批"。最后一个 issue 卡死 → batch 永不 complete → digest 永不发 → 用户以为一切安静，实际全挂了。
- `max_interval` 兜底**需要一个独立定时 flush 器**，文档没设计。aggregate 的消息存在哪、谁定时扫、进程重启后未 flush 的怎么办，全空白。

**这是"先自治后打扰"最容易演变成"永远不打扰"的地方。**

**修复方向**：引入 batch/run-group 实体（带 id 和 expected-count）+ 独立 digest flush 调度 + 超时强制升级。

### S5. PI-unavailable 的 fallback 存在循环依赖

§8 让"系统直接通知用户"，触发条件含 `supervisor heartbeat 超阈值`、`coordinator 无法运行`。但**检测 PI 挂掉并发出 fallback 的组件，必须独立于 PI/coordinator/outbox**。

文档说"不需要 PI 生成"，却没指定这个独立 watchdog 跑在哪、用什么通道。如果它复用同一个 outbox（实测 escalation 也走 `sync_outbox` / `imReplyOutboxDispatcher`），那 outbox/dispatcher 挂时 fallback 也发不出去。

**修复方向**：一条带外（out-of-band）的最小通道 + 独立心跳进程。

---

## 🟠 显著：设计不完整，落地会踩坑

### M1. 恢复预算的窗口/重置语义未定义，重启后可能无限重试

§6.2 "同一 issue 最多 3 次 / session resume 最多 2 次"。实测 `attempt_count`（`issueQueue.ts:40`）每次 claim 自增、**不随重启重置**。但：

- 新增的 `pi_recovery_attempts` 没说**计数窗口**（按 issue 生命周期？按小时？）也没说**重置时机**。
- issue retry budget 和 session resume budget 是**两个独立计数器但会叠加**，组合上限未定义，可能远超直觉的 3 次。
- transient retry 反复 resume 一个已把 worktree 搞脏的 session，没有状态回滚保护。

### M2. NL 偏好解析的可靠性、确认、TTL 全缺

§7.3 把"我睡觉了明天再汇报"这类 NL 落成 `mode/notify_on` JSON。问题：

- **谁解析？** 大概率是 PI（LLM）。解析错 → 静默错误（该通知的失败也被压了）。文档没要求**把解析结果回显确认**。
- **"我睡觉了，明天再汇报"是有时效的**，但 schema 里 `mode:quiet` 没有 TTL/到期。明天自动恢复 normal 还是永久静音？未定义。
- **偏好写入与在途事件的竞态**：用户说"别逐条" → PI 口头承诺 → 偏好落库之间，事件继续流。§2 提到动机，§7 没给写入顺序/屏障保证。

### M3. 多会话/多用户的偏好冲突无解

偏好是 `project_id + conversation_id` 双键。但一个 project 的 issue 可能从多个 conversation 触发，project 级事件该听谁的偏好？conversation A 设 quiet、B 没设，project 级 done 发给谁？**冲突解决规则缺失**。

### M4. `issue.patch_state` 修复 terminal mismatch — 高爆炸半径却被轻描淡写

§5.2 让 PI 直接改 issue 权威状态来修 mismatch。若 PI 误判"session 已结束"，可能把仍在跑的 issue 标成 failed/done。这是**写权威状态**的动作，应有：确定性的 mismatch 判定（不靠 LLM 猜）、改前快照、可逆。文档当成普通 action 列出。

### M5. "approve for session" 的 scope 蔓延

§4.2 列了 `approve for session`。一旦 session 级放行，**后续该 session 内更高风险的请求是否继承授权？** 文档没限定。正确做法：每个请求都重新过 deny-list，session 授权只能降低同类低风险操作的摩擦，不能成为高风险通行证。

### M6. 事件 inbox 的投递语义未定义

"PiGuardian event inbox"——有序吗？at-least-once？`status_changed` 乱序到达会让 PI 基于过期状态决策。需要 event sequence/version + 幂等消费。同时**每个事件触发一次 PI decision turn 会让 PI 自我限流**（`provider_rate_limited` 反噬自己），decision 层缺 backpressure/批处理（文档只对 notification 做了聚合，没对 decision 做）。

---

## 🟡 次要：补强会更稳

- **脱敏不能靠 PI**（§11 末条 + §6.2 数据收集含 workspace/git/secret）。LLM 生成的 digest 清洗 secret 不可靠，应在数据**进 PI prompt 之前**做确定性脱敏 pre-filter，而非信任 PI 输出干净。
- **缺失测试场景**（§11）：并发事件双动作、batch 中途 PI 挂掉、偏好在途竞态、retry 幂等、approval 超时、digest 因 batch 卡死永不触发、prompt-injection 抗性。当前测试列表全是"happy path 的安静版"。
- **`progress_detected` 没有定义**（§9.3）。靠"有新事件"判断会被 session 的 keepalive/心跳事件骗过（假进展耗光 budget 仍不升级，或假无进展白白浪费 budget）。需明确"进展" = 新工具调用/文件变更/状态推进，而非任意 event。
- **escalate 没有 ack 要求**。urgent 升级后 outbox 发出 ≠ 用户看到。`feishuMessageId` 只证明送达 Feishu，不证明用户已读。urgent 类应要求 ack 或多通道。

---

## 建议补的三块（最小集）

文档要从"理念正确"变成"可落地无坑"，最少补这三处：

1. **一张时序/职责表**：approval 的 10s 预算内谁出结论（确定性规则）、什么情况才 defer 给异步 PI、split-brain 的单一仲裁者和互斥锁。（对应 S1、S3）
2. **batch/run-group 作为一等实体**：带 `batch_id` + expected-count + 超时强制升级，否则整个聚合/digest/夜间报告都建在沙子上。（对应 S4、M3）
3. **确定性安全层独立于 PI**：deny-list 在 LLM 之前、LLM 不可覆盖、脱敏在入 prompt 前——把"PI 不绕过安全边界"从口号变成机制。（对应 S2、🟡 脱敏）

---

## 问题清单（速查）

| ID | 严重度 | 一句话 |
| --- | --- | --- |
| S1 | 🔴 | 授权走异步 PI 推理，撞 10s 同步超时，进程重启 |
| S2 | 🔴 | LLM 当安全边界，可被 prompt injection 绕过 |
| S3 | 🔴 | split-brain 无仲裁，双路径对同一事件双动作 |
| S4 | 🔴 | 无 batch 概念 + digest 无可靠触发 = 静默吞通知 |
| S5 | 🔴 | PI-unavailable fallback 复用同一 outbox，循环依赖 |
| M1 | 🟠 | 恢复预算窗口/重置语义未定义，重启后可能无限重试 |
| M2 | 🟠 | NL 偏好解析无确认、无 TTL、写入有竞态 |
| M3 | 🟠 | 多会话偏好冲突无解 |
| M4 | 🟠 | `issue.patch_state` 写权威状态，无快照/不可逆 |
| M5 | 🟠 | "approve for session" scope 蔓延 |
| M6 | 🟠 | 事件 inbox 无序/无幂等；decision 层无 backpressure |
