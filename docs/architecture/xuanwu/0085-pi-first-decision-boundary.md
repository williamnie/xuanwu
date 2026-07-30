# ADR-XW-0085：PI-first 决策边界与确定性 Action Gate

- 状态：Accepted
- 日期：2026-07-23
- 取代：ADR-XW-0046、ADR-XW-0052
- 运行入口：`backend-ts/src/http/piConversationApi.ts`、`backend-ts/src/http/piRuntime.ts`
- 工具与门禁：`backend-ts/src/pi/builtinToolRegistry.ts`、`backend-ts/src/pi/actionGate.ts`

## 1. 决策

Xuanwu 是 Agent 系统。自然语言理解、意图判断、工作分解、工具选择和下一步决策由 PI 的 LLM 完成，不再由 LLM 前的关键词、正则或伪智能 planner 抢先裁决：

```text
user message + stable conversation history + bounded entity context
  -> PI Agent/LLM
  -> answer or exact tool call
  -> deterministic registry / schema / Action Gate
  -> authoritative state mutation or explicit denial
```

`answer`、`retry`、`重试吧`、review、memory、notification、project switch 等表达都按原文进入同一 PI conversation。Channel bridge 不再执行语义命令 parser，也不把短回复路由成普通 answer。稳定 conversation 的历史和 authoritative action relation 可供 PI 理解指代；不同 conversation 仍隔离。

## 2. 禁止的实现

当前运行链禁止：

1. 在 PI LLM 前用自然语言关键词/正则决定 `answer | retry | execute | review | ...`；
2. 从错误文案、finding category 或 heartbeat 文本自动制造 recovery/action candidate；
3. 将缺失/不可用的 Agent、model、provider 或 tool 替换为 `hardcoded-*` 伪运行时并继续声称工作；
4. 在 Feishu、HTTP 或其他 channel bridge 中维护另一套 `/issue`、`retry`、`/review`、`/memory`、`/notify`、项目切换等语义旁路；
5. 在 PI 未选择 exact action 时，由 deterministic 代码取“第一个推荐动作”或根据错误类型猜一个动作；
6. 把模型叙述、commit ID、dirty working tree、Run success 任一单项当作 Work 已完成。

已删除的实现包括 `supervisorIntentRouter.ts`、`supervisorWorkPlanner.ts`、`recoveryActionPlanner.ts`、`heartbeatPlanner.ts`、`heartbeatVerificationPlanner.ts`、`failurePatternCandidates.ts`、`projectFindingActions.ts` 及 Feishu 语义命令 parsers。

## 3. 允许且必须保留的确定性边界

PI-first 不等于让 LLM 直接写数据库。下列边界保持确定性：

- authentication、source trust 与 project/Work entity resolution；
- tool registry、closed schema、exact operation/target/scope；
- current revision、state precondition、idempotency、risk 与 approval；
- provider/runtime machine error parsing、Evidence schema 与 completion policy；
- Action Gate authorization 与 append-only audit；
- Work/Run/Evidence/Handoff 各自 authoritative repository。

Entity resolver 只回答“这个 ID/项目/会话绑定指向什么”，不回答“用户想做什么”。Action Gate 只验证 PI 已经提出的具体动作是否合法，不替 PI 生成动作。

大型 PRD 的 Work 拆分同样遵守 PI-first：PI 先读取权威文档并完成语义分解，决定单 Issue 还是 2–40 个细粒度 Issue、MVP 主链、后续 backlog 与依赖关系；`issue_create_batch_proposal` 只校验 closed schema、本地引用唯一性、依赖存在性、无环性、授权与事务落库，不根据关键词、模块名或固定数量替 PI 规划。用户要求先 review 时，PI 只呈现计划；授权创建后 batch action 原子生成 triage Issue，且不自动 enqueue 整个 DAG。

以 `issue_state_repair_proposal` 为例，PI 必须提交当前 diagnosis 对应的 exact `diagnosis_code` 和 exact `operation`；gate 不再从候选集合取第一项。以 retry 为例，PI 先调用状态工具；若 authoritative projection 为 `implementation_complete_handoff_missing` 或 `retry_recommended=false`，gate 拒绝重复执行，只允许 PI说明 Handoff/交付账本缺口。

## 4. Agent / Provider / Tool 下线语义

PI Agent、配置模型、provider 或必要 tool 不可用时，系统必须：

1. 当前请求明确失败，不伪造成功 answer 或 action；
2. 写入可审计的 failure/Guardian signal；
3. 产生用户可见 Attention/告警，说明不可用的层级；
4. 不执行任何语义 fallback action；
5. 恢复后仍由 PI 从原始上下文重新决策。

后台 heartbeat、project loop 和 issue supervisor 只能采集结构化事实并把它们交给 PI。若 PI 不工作，后台路径进入 alert-only，而不是接管 Agent 决策。

## 5. Completion、commit 与 dirty working tree

Git commit、clean/dirty working tree、Run 结果、Evidence 和 Handoff 是不同事实：

- commit 是已持久化的 Git artifact；
- dirty working tree 是尚未进入该 commit 的修改或未跟踪文件；
- Run success 是一次执行结果；
- Work completion 仍要求 authoritative Work、required passed Evidence、Verification Policy 与 reviewable Handoff 一致。

系统不得因为 issue 文档含 commit ID 就要求“代码产物必须继续 dirty”，也不得因为 working tree clean 就认定没有交付物。Git Evidence 应读取 commit/tree/diff；dirty artifact 只能描述未提交的额外改动。PI 负责解释这些事实并选择补 Handoff、补 Evidence 或请求真正的 retry，确定性 completion gate 只校验其一致性。

## 6. 回归门禁

最小门禁必须覆盖：

- 多种自然语言（含 `重试吧`、`retry` 和未来未枚举表达）原样进入 PI；
- 同一稳定 conversation 的短回复可见历史，不同 conversation 隔离；
- channel bridge 不 import 语义命令 parser；
- heartbeat/Guardian/project loop 不制造 action；
- PI/model/provider/tool 不可用时显式 failure + Attention；
- exact tool call 在 target/revision/state/authorization 不匹配时 fail closed；
- 大型 PRD 会先读取正文，再生成含非空证据、改动、验收、验证及无环依赖的细粒度 batch；review 模式零 mutation，创建模式只落 triage、不 enqueue；
- implementation complete 但 Handoff 缺失时不重复 retry；
- 源码中不得重新出现被删除的 pre-LLM router/planner 标识。

回滚不能恢复关键词路由。若 PI provider 暂时不可用，只允许停在 alert-only 状态；不得以业务连续性为由启用硬编码语义替身。
