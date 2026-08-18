# ADR-XW-0092：IM 上下文预算、增量投影与 PI Session 换代

- 状态：Accepted v7（Phase 0–3 已本地实现并验证、未部署；Phase 4 仍为数据驱动 backlog）
- 日期：2026-08-18
- 适用范围：Feishu、Telegram 及后续接入统一 `ImChannelModule` 的面向人对话通道
- 相关 canonical 合同：ADR-XW-0045、0047、0063、0064、0069、0072、0073、0075、0077、0078、0085
- 独立 review：`0092-im-context-budget-and-session-rollover-design-review.md`
- 当前实现入口：`imConversationRouting.ts`、`imConversationContext.ts`、`piConversationApi.ts`、`piRuntime.ts`、`piRuntimeTools.ts`
- 本文性质：优化设计与实施门禁；不修改现有代码、schema、运行态或部署

## 0. v6 批准与收口记录

v2–v4 逐项修复状态空洞、枚举、时延、校准和重启恢复问题；v5 删除收益不足的机制并收口正文；v6 批准 Phase 0 并补齐实施门禁；v7 记录 Phase 0–3 已完成本地实现与全量验证，尚未部署，Phase 4 继续保持数据驱动 backlog。

保留四段核心闭环：

1. Phase 0：完整请求预算 observe-only；
2. Phase 1：IM cursor 增量投影；
3. Phase 2：bootstrap tools + `capability_search/invoke`；
4. Phase 3：阈值触发的简化 rollover + deterministic minimal capsule + 两阶段 CAS。

从 v1 实现删除：

- 应用层同步 compaction 门控、`compaction_required`、8 秒等待、single-flight、fencing 和 restart reconciliation；
- `projection_reliability` 校准、`static_prompt_fingerprint`、3 样本与误差门槛；
- richer capsule、后台摘要、5 秒 deadline 和覆盖校验；
- 独立的 Context Packet schema carrier。

推迟到 Phase 4 backlog，且只有 Phase 0/线上数据证明必要时才设计：

- tokenizer/estimator 校准；
- richer advisory capsule；
- 更细的自适应阈值。

v5 的原则是：**宁可更早换一个干净 Session，也不在用户消息同步路径上建立第二套 compaction 控制系统。**

## 1. 一句话决策

Xuanwu 每轮只向 PI 提供本轮真正需要的 IM 增量和工具；当完整请求接近预算、provider overflow、compaction 次数过多或达到保守兜底门槛时，直接换到新的 PI Session。

最近对话留在当前 Session，长期规则留在 durable memory，旧内容留在原 Session。新 Session 只接收确定性的最小续聊引用，不复制整份历史，也不等待新的 LLM 摘要。

## 2. 当前问题与事实

当前代码已经有局部边界：

- `imConversationContext.ts`：最多最近 20 条、约 9,000 字符、单条约 600 字符；
- durable memory：默认约 900 token；
- `piRuntimeCompactionSettings()`：128k 模型保留 51,200 token，SDK 自动 compaction 已开启；
- `routeImConversation()`：按 connector + chat/thread 保存 epoch，并支持 `/new`；
- chat system prompt fixture：约 23,970 字符、估算 5,993 token；
- acceptance、recovery、manager-cycle 已有 profile 工具 allowlist。

仍有三个核心问题：

1. system prompt 测试没有计算实际 tool definitions、resources、memory、IM projection 和 Session history；
2. chat/full 当前等于全部 available tools，审计时一次注册了 76 个 SDK tools 和 66 个 custom tools；
3. 稳定 PI Session 已有历史，但 transport projector 每轮仍读取最近 20 条，无法证明这些内容是新增。

SDK compaction 可以缓解历史增长，但它不是应用层 Session 生命周期：多次有损摘要、完整工具面和重复 IM 投影仍然存在。

## 3. 目标、非目标与硬约束

### 3.1 目标

- 每轮可观察完整模型请求预算；
- 同一 IM scope 只投影当前 PI Session 尚未见过的 transport 事件；
- 普通 chat 不再默认暴露全部工具；
- 超预算时无感换 Session，并保持父 Session 可回查；
- Feishu、Telegram 共用一套通用实现；
- crash、并发、重放和 provider overflow 下不重复执行用户消息。

### 3.2 非目标

- 不在 PI 前使用关键词/正则判断用户意图；
- 不接管 PI SDK 的自动 compaction；
- 不让摘要或 cursor 决定 Project、Issue、Work、Run、Approval 或权限；
- 不删除旧 Session、event、outbox、memory 或 audit；
- 不把 Runner Chat 强行伪装成 IM connector；
- 不在 v1 实现 estimator 校准或 richer capsule。

### 3.3 硬约束

1. **PI-first：** 语义理解和能力选择由 PI 完成；
2. **Authority 不变：** 当前状态必须重新读取现有 repository/tool；
3. **Scope 隔离：** connector、conversation、thread/root 和 epoch 精确匹配；
4. **一次执行：** 同一 inbound message 只能对应一个 PI turn；
5. **旧记录可追溯：** 新 Session 保存 parent ref，不复制或删除旧 transcript；
6. **安全：** transport delta、旧 transcript 和 tool result 都是不可信数据，继续脱敏并受 prompt-injection contract 约束。

## 4. 目标流程

```text
IM inbound
  -> connector auth / normalize / dedupe
  -> routeImConversation(connector + scope + epoch)
  -> ImContextCoordinator
       - 读取 active conversation、cursor 和 event→turn binding
       - 计算完整请求预算（observe / decision）
       - 选择 transport delta
       - 达到 trigger 时直接 rollover
       - 装配 bootstrap tool surface
  -> PI Agent
       - answer
       - 或 capability_search / capability_invoke
  -> existing registry / schema / Action Gate
  -> 写 binding、cursor、budget audit
```

Coordinator 只决定“带多少上下文、用哪个 Session”，不决定“用户想做什么”。

Context packet 是一次内存装配结果，同时以 bounded `pi_action_events` audit 记录数值、hash、refs 和 reason；它不是新的持久化 schema authority。

## 5. Scope 与渠道归属

### 5.1 IM scope

- 有 thread/root：`connector + thread/root`；
- 无 thread 但有 conversation/chat：`connector + conversation`；
- 两者都没有：当前 message 是 one-shot scope，不持久化 active conversation；
- provider ID 保持 opaque，不解析前缀推导业务语义。

Epoch 只由三类事实改变：用户 `/new`、自动 rollover、显式迁移/恢复。禁止通过“像新话题”“超过多久没说话”或业务关键词自动切换。

### 5.2 Runner Chat

Runner Chat 复用同一个预算计算器、bootstrap tool policy 和 rollover service，但不进入 IM cursor/outbox projector：

- Runner Chat history 直接来自其 PI conversation/Session；
- 不创建虚假的 connector、external event 或 outbox cursor；
- Phase 0 fixture 用它验证共享 runtime 预算，Phase 1 的 IM delta cursor 不适用于它；
- 后续若其他本地 chat 使用同一 conversation API，按 Runner Chat 路径接入。

## 6. 完整请求预算

### 6.1 预算组成

每轮在实际装配后估算：

```text
projected_input =
  system_prompt
  + controlled_resources
  + tool_definitions
  + durable_memory
  + supervisor/entity_context
  + transport_delta
  + minimal_capsule
  + active_session_messages_and_tool_results
```

同时为 provider output/reasoning、下一次 tool result 和估算误差保留余量。

测量优先级：model tokenizer → SDK context estimate + 实际序列化 tool/resource → 字符数保守估算。上一轮 provider usage 仅用于 Phase 0 对比误差，不作为当前轮精确值。

v1 不实现校准系统。所有 preflight 数字都标记为 estimate；若 context window 不可得，使用受控 provider/model fallback。window 和 fallback 都不可得时 fail closed 并产生 Attention。

### 6.2 分桶只是决策输入

建议继续为输出和工具循环保留约 40% context window。剩余输入预算 `U` 的观察分桶：

| 组成 | 观察上限 |
| --- | ---: |
| system/resources/entity/memory/capsule | `25% U` |
| tool definitions | `20% U` |
| active Session + transport delta | `45% U` |
| headroom | `10% U` |

这不是应用层对 SDK Session history 的硬裁剪。Active Session/tool results 仍由 SDK 管理；应用层能执行的动作只有：减少 transport/tool overhead，或不再向旧 Session 发送并 rollover。实现不得声称已经把 SDK history 强制裁到 45%。

### 6.3 简化状态

| 状态 | 默认条件 | 动作 |
| --- | --- | --- |
| `green` | projected `< 50%` | 正常执行 |
| `yellow` | `50% <= projected < 60%` | 本轮可执行；记录下一轮可能换代 |
| `rollover_required` | projected `>= 60%`；overflow；compaction count 达门槛；保守兜底触发 | 直接换新 Session，再处理当前消息 |
| `hard_stop` | window 不可得；rollover 失败 | 旧 Session 发送数为 0，进入 Attention/恢复 |

应用层不等待、触发或重试 SDK compaction。SDK `compaction_start/end/failed` 仅作为观测事件；已完成 compaction 次数可以成为 rollover trigger，provider overflow 立即触发 rollover。

初始阈值由 Phase 0 验证后才能启用，但 v1 不为阈值建立 estimator 校准状态机。

## 7. IM 增量投影与 event→turn binding

### 7.1 为什么需要 binding

仅有 numeric cursor 无法判断某条 transport event 是否已经进入 PI Session；SDK JSONL 也不是应用层可稳定反查的关联表。因此在选择 delta 时，应用层必须写明确的 event→conversation→turn binding。

### 7.2 写入时机

1. 在调用 PI SDK 前先创建稳定 `turn_id`；
2. 选择 delta 后，在同一 DB transaction 写 `im_context_event_bindings`，状态为 `reserved`，记录 connector、event/outbox ID、conversation、turn、direction 和 projection hash；
3. 同一 inbound 重试必须复用原 `turn_id` 和 reserved packet，不重新挑选另一组 delta；
4. 收到 SDK `turn_start`/等价“请求已进入当前 Session”事实后，将 binding 标为 `presented`，再推进该方向的 committed cursor；
5. SDK 在 turn_start 前失败：释放 reservation 或复用同一 reserved packet，不推进 cursor；
6. crash/restart 后，由 Session/Turn index 判断 reserved binding 是否已经 presented；无法证明时不推进 cursor，并以同一 turn/idempotency key 恢复，不能创建第二次业务执行。

绑定是“这条 transport event 已向哪个 PI turn 展示”的 authority；它不证明模型理解了内容，也不改变 event、outbox 或 Session 的原始 authority。

### 7.3 inbound/outbound 独立推进

- inbound cursor：event 已 `presented` 后推进；
- outbound cursor：outbox row 已 `presented`，或 correlation/turn ref 证明当前 Session 已见后推进；
- 晚到的 PI reply：通过 turn correlation 标记为已见，不把自己的上一条回复重新注入；
- 其他晚到 outbound：没有当前 Session/Turn ref 时仍是 delta 候选；
- 每个方向只推进已确认的连续 durable prefix；遇到 gap 停在 gap 前；
- cursor CAS 带 conversation、previous cursor 和 turn，失败方重新读取。

### 7.4 有界规则

Transport delta 只有一个主要硬预算：默认总计最多 2,000 token，绝对值取配置上限与当前剩余预算中的更小值。

Projector 从最新事件向前装入，保留 chronological order；单条过大时截断，预算耗尽时停止，并记录 omitted count、refs 和 `truncated=true`。Cursor 缺失或 legacy 首次接管允许一次 bounded bootstrap，但仍受同一总预算。

排除 current message、reaction、delivery receipt、heartbeat 和无用户语义的系统噪音。Current message 已作为本轮 user prompt 单独传入，只能出现一次。

## 8. Bootstrap tools 与按需能力

### 8.1 默认工具面

普通 chat 只暴露：

- 有界 Project/Work/Issue/Session 只读工具；
- `memory_search`；
- `context_status`；
- `capability_search`；
- `capability_invoke`；
- parent Session 回查工具：`session_read_summary`（必须能接收 capsule 中的 parent session ref）；
- 少量高频、低风险、schema 稳定的工具。

工具 family/bootstrap metadata 由唯一 registry 提供，IM bridge 不维护关键词或第二份工具表。

上述具体工具名是设计示意，不是第二份实现清单；最终 bootstrap surface 只以唯一 registry metadata 和 profile policy 为准，文档名称漂移不得改变运行行为。

### 8.2 Search / invoke

`capability_search` 返回少量名称、用途、风险、permission、schema hash 和有界参数摘要，不执行副作用。

`capability_invoke` 使用 exact tool ID、schema hash 和 arguments；server 从唯一 registry 重新验证完整 schema，并继续经过 scope、revision、precondition、Action Gate、approval、idempotency 和 audit。Search 结果不是授权。

### 8.3 既有 profile 不受影响

- acceptance、recovery、manager-cycle 保留当前 profile allowlist；
- `chatToolMode=review` 保留现有 `REVIEW_CHAT_TOOLS`，不得被普通 chat bootstrap 覆盖或缩成不可审查；
- Phase 2 只替换 `chat/full = all available tools` 的行为；
- provider/tool 不可用时显式失败，不选择名字相近的替代项。

## 9. 简化 Session rollover

### 9.1 Trigger

满足任一条件，在向旧 Session 发送当前消息前直接 rollover：

1. projected input `>= 60%` effective context window；
2. provider 报 context overflow；
3. 当前 epoch 已完成 2 次 SDK compaction；
4. 当前 epoch 已处理 50 个 user turns；
5. Session JSONL 达到首版保守 file-size 门槛；
6. 用户显式 `/new`。

50 turns/file-size 是 v1 在 estimator 未校准前的无条件安全兜底。Phase 0 可以调整数值，但 v1 不引入 reliability 状态机来豁免它。

### 9.2 Deterministic minimal capsule

V1 capsule 不调用 LLM，只包含：

- parent conversation/session ref；
- 当前 resolver 给出的 Project/Work/Issue refs；
- active commitment refs；
- durable memory refs；
- 最近少量 turn refs；
- trigger、created_at、truncation 和 `summary_unavailable=true`。

Capsule 不复制自由文本总结，不保存当前状态结论。新 Session 若需要旧细节，使用 bootstrap 中的 `session_read_summary(parent_ref)`，再用权威工具刷新当前状态。

### 9.3 两阶段 CAS

1. **Prepare：** 创建 child `pi_conversations`/PI Session、minimal capsule 和 `rollover=preparing`；旧 active pointer 不变；
2. **Activate：** 以 connector、scope、old epoch 和 old active conversation 做 CAS，更新 `im_conversation_state`，rollover 标 `activated`；
3. **Continue：** 当前 inbound 只进入 CAS winner 的 child Session；
4. **Retain：** parent 保持可读，由 active pointer 推导为非当前，不删除 transcript。

CAS 是数据库中的唯一并发 authority，不依赖进程内 winner lock；多个 Core/进程并发时也只有一个 winner，失败方标记自己的 preparing row 失败并重新读取 active child。Prepare crash 时 parent 仍有效；Activate 后 crash 时重放同一 inbound/turn idempotency key 到 child；child 无法打开时进入 hard stop/Attention，不把 parent 恢复为 winner。

### 9.4 时延预算

Rollover 只做本地 DB、Session 创建、minimal capsule 和 CAS，不等待 SDK compaction 或额外 LLM。

- context observe/projector 本地路径 P95 `< 100ms`；
- rollover prepare + CAS P95 `< 1s`；
- 收到 inbound 后，第一条新 Session provider request 应在 P95 `< 2s` 内开始；
- IM quick reaction/ack 保持现有快速路径，ack 只表示已收到，不表示完成；
- 超过 2 秒仍未 activate：保持 ack 并进入恢复/Attention，禁止回旧 Session“先试一次”。

## 10. Additive persistence

`im_conversation_state` 继续是 connector + scope 当前 active conversation/epoch 的唯一 pointer。新增最少三类 carrier：

1. `im_context_event_bindings`：event/outbox → conversation/turn 的 reserved/presented 绑定；
2. `im_context_cursors`：inbound/outbound committed continuous prefix；
3. `im_context_rollovers`：parent/child、trigger、minimal capsule、`preparing|activated|failed` 和 audit ref。

Budget observation、SDK compaction event 和 rollover decision 写有界 `pi_action_events`；不保存完整 transcript、tool schema、capsule 之外的自由文本或 secret。需要查询优化时先做只读 projection，不建立第二生命周期。

非当前 epoch 的 binding/cursor 进入既有 retention 生命周期；只有观察窗口结束、所有 reader/consumer 为零、backup/restore 验证和非 LLM 删除授权齐备后才可清理，当前或 pending rollover 关联记录不得删除。

## 11. 存量长会话接管与灰度

新策略不能让一个历史长 Session 的第一条消息突然承担迁移成本。

### 11.1 Observe-first

- Phase 0 对所有会话只计算预算，不改变 projector、tool surface 或 Session；
- 行为开关按 connector + scope/epoch 控制，不使用全局一次性切换；
- 先在 fixture、测试账号和新 epoch 开启，再按 5% → 25% → 100% scope 灰度；
- 每级必须观察重复率、rollover 时延、失败率、provider overflow、用户连续性，以及“尚未进入 durable memory 的明确偏好/约束”在 rollover 后的可恢复率。

### 11.2 既有 epoch 首次接管

- 第一次命中新策略只建立 cursor/binding baseline 和 shadow budget；除 provider 已 overflow 外，不阻塞当前消息；
- 若 shadow projected 已达 rollover 门槛，标记 `rollover_on_next_turn`；本轮成功后或下一条消息前完成本地 minimal rollover；
- provider 在首次接管消息上 overflow：创建 child，并用同一 inbound/turn idempotency key 向 child 重试一次；
- `/new` 立即创建新 epoch，不需要 legacy bootstrap；
- 已经多次 compaction 的旧 epoch 可以优先灰度，但不能跳过 binding/cursor baseline。

## 12. 可观测性与安全

### 12.1 只记录必要事实

每轮记录：window/fallback、projected total、分桶、tool count、transport delta/omitted count、SDK compaction count、rollover trigger/latency/result、cursor/binding refs。

Provider usage 存在时记录 observed 与 estimate 偏差，供 Phase 4 判断是否值得做校准；v1 不据此改变状态机。

### 12.2 安全

- delta、capsule 和 tool search result 进入模型前脱敏；
- audit/diagnostics 不包含 raw callback、credential、完整 transcript、绝对 secret path 或 capsule 外自由文本；
- binding/cursor 使用 opaque refs；
- `capability_search` 不返回 secret；
- 动态发现不扩大 permission；
- capsule 中的旧内容和 refs 不拥有当前状态 authority。

## 13. 实施阶段

### Phase 0：完整预算 observe-only

- 序列化实际 system/resources/tools，估算完整请求；
- 对比 provider observed usage，但不做校准状态机；
- 接入 SDK compaction events 作为观察；
- 统计最近 20 条 projector 的重复率；
- 覆盖 Feishu、Telegram 和 Runner Chat runtime budget；Runner Chat 不进入 IM cursor。

退出门禁：没有行为变化；能解释固定开销、Session、工具和 transport 各占多少，并给出阈值建议。

### Phase 1：Binding + cursor delta

- 首先做 spike 验证 PI SDK 是否暴露可靠的 `turn_start`/request-accepted 等价信号；证明前不得启用 committed cursor，保留 `reserved` 且失败不推进；
- 新增 event binding、双 cursor 和 continuous-prefix CAS；
- shadow 对比旧 recent projection 与新 delta refs；
- 新 epoch/测试 scope 先开，存量 epoch observe-first；
- 成功 presented 后推进，失败不推进。

退出门禁：同一消息零重复执行、同 Session 已见消息不再注入、晚到 outbound 不误跳/重复、restart 后 cursor 连续。

### Phase 2：Bootstrap tools

- registry 增加 bootstrap/family metadata；
- 普通 chat/full 使用 bootstrap + search/invoke；
- parent `session_read_summary` 必须可用；
- review/acceptance/recovery/manager profile 保持原 allowlist；
- feature flag 可恢复 full chat tool surface。

退出门禁：工具 schema 明显受控，固定 eval/Golden Journey、权限和 review chat 不回退。

### Phase 3：简化 rollover

- minimal capsule、prepare/activate CAS、trigger 和时延指标；
- 不调用额外 LLM，不等待或触发 SDK compaction；
- 先新 epoch，再灰度存量 epoch；
- parent Session 回查和同 inbound idempotent retry 可用。

退出门禁：长对话、并发、crash、overflow、存量接管和真实 IM rollover 通过。

### Phase 4 backlog

仅在 Phase 0/上线数据证明必要时评估：

- estimator/tokenizer 校准是否能安全减少不必要 rollover；
- minimal capsule 是否造成真实连续性缺口，是否需要 richer capsule；
- 无 durable memory 的 `user_explicit` 决定是否在真实灰度中丢失，以及是否需要新增有 source ref 的有界续接字段；
- 阈值是否按 provider/model 自适应。

Phase 4 必须另写设计与收益证据，不得在 Phase 0–3 顺手恢复 v4 机制。

## 14. 测试矩阵

### 14.1 Budget 与渠道

- 完整 system/resource/tool/memory/session/transport 预算；
- Feishu/Telegram 同形 packet，scope/thread 隔离；
- Runner Chat 复用预算但不创建 IM cursor；
- window/fallback 缺失 fail closed；
- budget 计算和审计不泄漏内容。

### 14.2 Binding 与 delta

- reserved → presented → cursor；turn_start 前失败不推进；
- crash/restart 后 reserved binding 恢复；
- current message 只出现一次；
- inbound/outbound 独立 cursor、gap、retention、legacy bootstrap；
- 晚到 PI reply 去重，其他 outbound 不被越过；
- 200 条长对话无 transport 重复。

### 14.3 Tools

- bootstrap schema 受预算约束；
- search/invoke exact schema、drift 和 Action Gate；
- high-risk 仍要求 approval；
- `session_read_summary(parent_ref)` 可从 minimal capsule 自救；
- `chatToolMode=review`、acceptance、recovery、manager 不被误伤；
- 不出现关键词 intent router。

### 14.4 Rollover

- projected threshold、overflow、2 次 compaction、50 turns、file-size、`/new`；
- minimal capsule 不含自由摘要和当前状态 claim；
- prepare/activate/continue crash points；
- 并发只有一个 child；
- 同一 inbound 在 overflow retry 时执行一次；
- parent 可读且不恢复为 winner；
- rollover 失败旧 Session 发送数为 0；
- 存量长 epoch 首次 observe、本轮不阻塞、下一轮换代；
- P95 时延门禁。

## 15. 验收标准

1. 普通用户不需要手动 `/new` 也能长期连续使用 IM；
2. 每轮可以解释完整请求预算，tool definitions 单独可见；
3. 同一 Session 已见的 transport event 不重复注入；
4. 普通 chat 不再默认暴露全部 tools，长尾能力仍可调用；
5. 达到 trigger 后不再向旧 Session 发送；
6. 自动 rollover 不重复用户消息，parent 可回查；
7. minimal capsule 下，“刚才那件事”可以通过 `session_read_summary` 自救；
8. review chat 和内部 Prompt Profile 不回退；
9. context coordinator P95 `<100ms`、rollover P95 `<1s`、新 Session provider request 启动 P95 `<2s`；
10. 所有 state mutation、target、permission、approval 和 idempotency 与优化前一致。

## 16. 兼容、回滚与删除门禁

### 16.1 兼容与 feature flags

- `im_conversation_state`、`/new`、conversation ID 和 outbox contract 保持；
- 旧 Session 继续可读；
- Phase 1 可恢复最近 20 条 projector；
- Phase 2 可恢复 full chat tool surface；
- Phase 3 可停止自动 trigger，只保留 `/new` 和已经 activated 的 child；
- 回滚不删除 binding、cursor、rollover、Session 或 audit。

### 16.2 删除门禁

删除旧 projector、full chat tools 或 legacy carrier 前必须满足：

1. 连续一个正式 release consumer/usage 为 0；
2. Feishu、Telegram、Runner Chat 对应回归和真实 rollover 通过；
3. fresh backup、isolated restore 和 rollback rehearsal 通过；
4. 无 pending rollover/outbox/cursor migration；
5. 非 LLM destructive approval；
6. retained artifact 可恢复旧版本。

## 17. v7 本地交付记录

Phase 0–3 已按本文精简闭环完成本地实现并通过完整验证，尚未部署；Phase 4 未授权实现，仍须由真实观测数据证明必要性：

```text
完整预算可见
  -> IM 只补增量并写 event→turn binding
  -> PI 按需发现工具，parent Session 可回查
  -> 达到 trigger 直接 minimal rollover
  -> authority 仍由现有数据库和工具提供
```

V5 每个机制只防止一类坏事：

| 机制 | 防止的坏事 |
| --- | --- |
| 完整预算 | system prompt 看似不大，但工具和 Session 已耗尽窗口 |
| binding + cursor delta | 同一 IM 历史每轮重复注入或漏掉晚到消息 |
| bootstrap + search/invoke | 142 级工具面每轮占用上下文 |
| minimal rollover + CAS | Session 永久增长、并发产生两个 winner、同一消息重复执行 |
| parent session read | 换代后只剩 refs，无法回答“刚才那件事” |
| observe-first 灰度 | 存量长会话第一条消息突然阻塞或丢上下文 |

Estimator 校准、同步 compaction 控制和 richer capsule 不属于 v1 必需闭环，保持删除/推迟。
