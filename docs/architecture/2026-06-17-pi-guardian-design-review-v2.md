# 2026-06-17 PI Guardian 设计评审 v2：重构版的残留缺口

> [!WARNING]
> **历史归档（2026-07-19）**：本文只保留评审 provenance，不再是当前实现规范。当前 source of truth 见 [canonical 架构文档索引](README.md)、[Approval / Action Gate](xuanwu/0063-approval-action-gate.md)、[统一通知 Outbox](xuanwu/0075-unified-notification-outbox.md) 与 [决策层收敛](xuanwu/0079-pi-decision-layer-consolidation.md)；不得据本文复制旧 PI/Guardian 状态或 writer。

> 状态：第二轮评审，针对重写后的 [`2026-06-17-pi-guardian-notification-supervisor-design.md`](./2026-06-17-pi-guardian-notification-supervisor-design.md)。
> 日期：2026-06-17。
> 关系：本文**不重复** [v1 评审](./2026-06-17-pi-guardian-design-review.md) 的 S1–S5 / M1–M6。那一轮的问题已在重写版中系统性解决（见下方“闭环确认”）。本文只列**重写后才出现、或只有在这个细化粒度下才暴露**的新缺口。
> 方法：逐节核对设计自洽性 + 当前实现 ground-truth（`file:line`）。

---

## 闭环确认：v1 的问题已被接住

先确认上一轮不用再吵了，避免重复劳动：

| v1 问题 | 重写版落点 | 状态 |
| --- | --- | --- |
| S1 授权撞 10s 同步超时 | §0 不变量2、§7 fast-path「无 hold、灰色 deny-now」 | ✅ 已解 |
| S2 LLM 当安全边界 | §0 不变量1、§7.4 deterministic deny-list 先于 prompt | ✅ 已解 |
| S3 split-brain 无仲裁 | §0 不变量5、§9 `PiGuardianDecisionOrchestrator` + lease | ✅ 已解 |
| S4 无 batch / digest 静默吞 | §3.2 `pi_run_groups` + §5.3 三触发器 + deadline | ✅ 已解（但见 N1/N2 残留） |
| S5 fallback 循环依赖 | §0 不变量3、§11 out-of-band watchdog | ✅ 已解（但见 N6 边界） |
| M1 恢复预算窗口 | §3.7 `pi_recovery_attempts` rolling window | ✅ 已解 |
| M2 偏好 TTL/确认/竞态 | §3.4 + §6 version/effective_after/TTL | ✅ 已解（但见 N3） |
| M3 多会话偏好冲突 | §3.4 解析顺序 | ⚠️ 已给顺序，但顺序本身可疑（见 N4） |
| M4 `patch_state` 高危 | §10.4 precondition + snapshot + deterministic 来源 | ✅ 已解 |
| M5 approve for session 蔓延 | §7.6 五条件 + TTL | ✅ 已解 |
| M6 事件 inbox 语义 / decision backpressure | §3.1 idempotency + §9 merge/rate-limit | ✅ 已解（但见 N5/N7） |

方向与机制都对了。下面是**这版新增的、落地前会咬人的点**。

---

## 🔴 新严重：会让“一定发 digest / 不丢通知”这条承诺破功

### N1. digest intent 的 idempotency_key 会把“先 partial 后 completed”两份 digest 折叠成一份 → 完成摘要发不出

§3.5 给 `pi_notification_intents` 建了**唯一索引** `ux_pi_notification_intent_key`，key 规则是：

```
${kind}:${project_id}:${issue_id}:${run_group_id}:${source_event_id}:${target_channel}
```

但 digest 不是由单一 source event 触发的（§5.3 列了 5 种触发器，多数没有 source event）。对同一个 run group：

- deadline 到达先发一份 `kind=digest`（partial），`source_event_id` 大概率为空；
- 后续全部 reportable 时要再发一份 `kind=digest`（completed）。

两份的 key 在 `issue_id=0 / run_group_id 相同 / source_event_id 空` 时**完全一致** → 唯一索引拒绝第二行 → **完成摘要被静默丢弃**。这正是 S4 在 digest 层的复活，且直接违反 §0 不变量7 与 §18「到 batch complete… 一定发 digest」。

**修复**：digest 类 intent 的 key 必须含 flush 维度，例如 `digest:${run_group_id}:${flush_reason}:${flush_seq_or_time_bucket}`；或 digest 干脆不走 `ux` 唯一约束，改用 `(run_group_id, last_digest_at)` 这类带序的键。

### N2. enqueue 失败/待批的 item 永远拿不到 `final_issue_status` → run group 完成判定可能卡死

§3.3 item 同时有 `status`（active|reportable|removed）和 `final_issue_status`；§4.4 的完成判定**只看 `final_issue_status` 是否落在 reportable terminal 集**：

```
all_items_reportable = every item has final_issue_status in reportable terminal states
```

但 `final_issue_status` 来自 **lifecycle event**（§4.3）。一个 `enqueue_status=failed`（比如 enqueue 时 approval 被拒、或 issue 不存在）的 item **从未进入 lifecycle**，永远不会有人给它写 `final_issue_status`。于是 `all_items_reportable` 永远为假，group 永远 `active`，只能靠 deadline 兜底降级 partial——又把 S4 的“最后一个卡死”换了个马甲。

§4.3 写了“enqueue pending/failed 也作为 item reportable 状态”，但**数据模型上没有把 `enqueue_status` 映射进完成判定**：判定读的是 `final_issue_status`，不是 `enqueue_status`。两个字段之间缺一条规则。

**修复**：完成判定要同时吃 `enqueue_status`。明确：`enqueue_status in (failed, skipped)` 的 item 直接视为 reportable（`final_issue_status=skipped/failed`），在 item 落库时就写死，不要等 lifecycle。

### N3. `effective_after_event_id` 依赖一个不存在的全局有序事件 id → §6.3 竞态处理无法判定

§6.3 的竞态方案核心是：“coordinator 对旧事件按旧偏好、对新事件按新版本”，判据是 `effective_after_event_id`。但要比较“某事件在该锚点之前/之后”，需要一个**全局单调有序**的 id。

实现现实（已核对）：

- 现有 schema 没有任何全局 sequence/monotonic 列（`001_base_schema.ts`、`003_pi_runtime.ts` 均无）。
- 新表 `pi_guardian_event_inbox`（§3.1）`id` 是 `text primary key`（uuid 形态，不可比大小），`source_sequence` 是**每个 source 各自**的 `integer default 0`，跨 source（event_bus / issue_events / provider / scheduler）不可比。

结论：`effective_after_event_id` 无法定义“之前/之后”。两个 source 的事件谁先谁后没有全序，§6.3 的偏好切换边界是空中楼阁。

**修复**：要么给 inbox 加一个 DB 级单调列（SQLite 用 `integer primary key autoincrement` rowid 或独立 sequence 表），用它做锚点；要么锚点改用 `created_at` 时间戳并显式接受同毫秒不可分辨（并在 digest 里注明“偏好自 T 生效”）。当前用 event **id** 当锚点是错的。

### N4. 偏好解析顺序把 project 放在 conversation 之上，方向很可能反了

§3.4 解析顺序：

```
run_group > project explicit > origin conversation > global default > system default
```

这意味着**项目级偏好覆盖用户当前对话里的明确设置**。但用户是在某个 conversation 里说“我睡了别吵我”的——这是比“项目默认”更具体、更新鲜的意图，却被 project 压制。M3 问的“project 级事件、会话 A quiet B 没设，听谁的”，这版答案是“听 project”，但对**会话发起的事件**来说，更符合直觉的是 conversation > project。

**建议**：要么把顺序改成 `run_group > conversation > project > global`，要么明确区分“project 显式策略（管理员级，应压制）”与“conversation 临时偏好（用户级，应优先）”两类，并写明为什么 project 能盖过用户当下的话。现在的单一线性顺序会产出反直觉行为。

---

## 🟠 新显著：机制存在但有未闭合的失败模式

### N5. session.resume_followup 在“持锁进程崩溃”下并非幂等，lease + precondition 不足以兜住

§9.4 lease TTL 30s–5min，崩溃后过期由他人接管；§0 不变量4 靠 idempotency key + precondition 防重复。但 `session.resume_followup`（实测存在，`issueSupervisorRecovery.ts:99`、`actionGateRecovery.ts:13`）**本身不是幂等操作**：已经向 provider 发出 resume、但进程在写 result 前崩溃，lease 到期后接管者读到的状态仍是“需要 resume”，会**再发一次** → 双重 steer / 双 followup。

precondition 检查的是 issue/run/session 状态，而 resume 的副作用发生在 provider 侧、状态回写有延迟，存在 TOCTOU 窗口。

**修复**：resume 类动作要用 provider 侧可观察的去重锚（如 `provider_turn_id`，§3.7 已有该列——把它用起来）：执行前查“本 attempt 是否已存在对应 provider turn”，而不仅查 issue 状态。或者把 attempt row 的创建+lease 放进同一事务并在 provider 调用前标记 `executing`，接管者见 `executing` 且未超硬超时则不重发。

### N6. watchdog 的 direct Feishu 与正常 outbox 共用同一 Feishu 传输 → 只兜住“管道挂”，兜不住“Feishu 挂”

§11.2 fallback 第3步“direct Feishu minimal text sender”。它绕过了 `notification_intent / sync_outbox` **管道**（这点对，解了 S5），但仍走**同一个 Feishu client/token/API**。当失效根因是 Feishu 侧（token 过期、飞书 API 不可用、网络分区），watchdog 的 direct send 同样失败。

这不是 bug，但 §18 “watchdog 仍能…尝试带外 Feishu”的表述会让人以为 Feishu 故障也能兜住。

**建议**：明确 watchdog 的覆盖边界 = “PI/coordinator/outbox 管道故障”，**不含** Feishu 平台故障；后者的唯一可靠出口是 Runner UI banner（§11.2 第1–2步，本地、不依赖外部）。把 UI alert 定为**主**带外通道，direct Feishu 为**尽力而为**，文档措辞要降级。

### N7. inbox 的 payload-hash 幂等会把“合法重复的同类信号”误删 → 漏数恢复触发

§3.1：upstream 无 id 时用 normalized payload hash 当 idempotency 素材。问题：两次**真实独立**但 payload 相同的事件（例如毫秒级先后两次 `stream disconnect`，provider 没给 id）会 hash 碰撞 → 第二条被当 duplicate 丢弃 → 恢复层少看到一次失败信号。

对通知，去重是优点；对**恢复/预算计数**，少计一次失败可能让“该升级时没升级”。

**修复**：payload-hash 分支必须掺入一个粗时间桶（如分钟级 `created_at` bucket），让“同分钟同 payload”才算重复；或对无 id 的 provider 失败信号根本不走 hash 去重，改为接受 at-least-once 由下游 cooldown 收敛。

### N8. “transient 失败 vs needs_context 失败”的分类权威没指定——若由 PI 判定，又给注入留了降级后门

§5.2 把 `issue failed transient → aggregate`、`issue failed needs_context → escalate_user` 分流。这条分流决定**该不该打扰用户**，但文档没说谁来判 transient/needs_context。若是 PI/LLM 读 Codex 输出来判，则对抗性文本可把一个真正 needs_context 的失败说成 transient → 被 aggregate/suppress → 用户整夜不知道。这与 §0 不变量1（安全/边界判断不归 LLM）精神冲突，只是搬到了通知严重度上。

**修复**：transient/needs_context 的初判必须由 **deterministic diagnosis_code**（provider EOF / rate_limited / timeout = transient；missing context / build-broken-needs-decision = needs_context）决定；PI 只能在此之上补充人话解释，不能改 severity 分类。

### N9. 灰色 deny-now 的语义正确，但 §7.2 把同步 DB 写放在 fast-path 最前 → SQLite 单写锁可能拖垮 latency 预算

实测 DB 是 `bun:sqlite`（`database.ts:1,32`），**单写者**。§7.2 fast-path 第一步就是 `upsert pi_approval_requests(status=pending)`——一次同步写。而 DigestFlushScheduler、orchestrator、recovery attempts 都在并发写同一个 SQLite。approval 路径若排在写锁后面，§7.3 的“超过 internal latency budget → deny-now”会被触发成**伪拒绝**（明明该 approve 的低风险操作因为 DB 抖动被拒）。功能上仍 fail-safe，但体验上会无谓打断本可自动放行的执行。

**修复**：fast-path 的“决策 + resolveApproval”要能在**不依赖持久化成功**的前提下先返回（deny-list / allow-list 是纯内存规则判定）；`pi_approval_requests` 的写入与 audit 改为决策返回**之后**异步落库。让 DB 争用永远不进入 10s/100ms 的关键判定路径。

---

## 🟡 新次要

- **谁看门狗的看门狗 / 谁监控 DigestFlushScheduler**：§11.1 watchdog 检测 `digest_flush_stalled`，但 watchdog 自身停摆无人知。可接受，但建议 watchdog 暴露一个 liveness 时间戳供 Runner UI 直接判活，至少让“连 watchdog 都停了”在 UI 上可见。
- **urgent ack 与 quiet 的张力（§3.4 + §5.5）**：“我睡了”进 quiet，但 unsafe/needs_user 不被压制且 §5.5 ack 到期会“重复提醒”。深夜真出现一个 urgent → 整晚反复 ping，正好是用户想避免的。建议 quiet 期内 urgent 的 ack 重试用退避 + 上限，而不是固定重复。
- **上线时的在途 issue 没有 run_group（§3, §15.1）**：迁移上线那一刻，正在跑的 issue 都没有 group。§5.2 “else send_now/aggregate by preference” 能兜底（退化为今天的行为，不更差），但建议文档加一句迁移期说明，并在 §15.1 加一条“无 run_group 的遗留 issue 仍按 per-issue 偏好正确路由”的测试。
- **reportable 集合在 §3.3 与 §4.5 表述不完全一致**：§3.3 列出 8 个 reportable terminal（含 `needs_user`、`budget_exhausted`），§4.5 的 digest 分类桶里没显式安置 `needs_user`。建议把两处的状态全集对齐成一张表，避免实现时漏桶。
- **merge window 内 severity 升级（§9.2）**：一个进入 120s info 窗口聚合的信号，若窗口内预算耗尽升为 actionable，decision 层是否立刻破窗？§5.3 触发器4 覆盖了 notification 侧，decision 侧（§9.2）没写破窗规则。建议明确：窗口内 severity 上升到 actionable/urgent 立即结算该 key。

---

## 落地前增量验收（补在文档 §17 之后，不重复 §17 已有项）

- [ ] **digest 唯一键**：同一 run group 的 partial digest 与后续 completed digest 能否各自落一行？（N1）
- [ ] **enqueue 失败 item**：enqueue 失败/被拒的 item 是否在落库时即标 reportable，使 group 不会因它永远 active？（N2）
- [ ] **偏好切换锚点**：`effective_after` 用的是单调可比字段（rowid/sequence/时间戳）而非不可比的 uuid event id？（N3）
- [ ] **偏好优先级**：project 与 conversation 的覆盖方向是否有明确、可辩护的理由？（N4）
- [ ] **resume 去重**：进程在 resume 已发出、result 未写时崩溃，接管者是否会重复 resume？用 `provider_turn_id` 验证。（N5）
- [ ] **watchdog 边界**：文档是否说明 Feishu 平台级故障不在 watchdog 覆盖内，UI banner 是主带外通道？（N6）
- [ ] **失败分类权威**：transient vs needs_context 是否由 deterministic diagnosis_code 决定，而非 PI 可改？（N8）
- [ ] **approval 路径无同步 DB 依赖**：fast 决策能否在持久化之前返回？（N9）

---

## 一句话总结

重写版从“理念正确”跨到了“工程可落地”，v1 的 5 个严重项全部有了机制性答案。**剩下的风险集中在两类**：(1) **唯一键 / 完成判定 / 事件有序性**这几处实现细节会让“绝不静默丢通知”的核心承诺在边角破功（N1/N2/N3，必须改）；(2) **分类与去重的权威边界**有几处又悄悄把判断交回给了 PI 或交给了不可靠的去重（N5/N7/N8）。把这两类钉死，这份设计就可以开工了。
