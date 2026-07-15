# ADR-XW-0003：六条 Golden Journey 端到端验收合同

- 状态：Accepted
- 日期：2026-07-15
- 依赖：[ADR-XW-0001](0001-product-positioning.md)
- 术语依赖：[ADR-XW-0002](0002-brand-terminology.md)
- 决策范围：一句话交付、失败恢复、跨项目批量、远程控制、常驻巡检、发布交付
- canonical 级别：本文件是玄武六条 Golden Journey 验收语义、证据和夹具边界的 source of truth

## 1. 合同用途与完成口径

本合同把 ADR-XW-0001 的六个核心工作固定为可自动化的端到端验收目标。它定义完整产品形态，不把“API 存在”“模型回复完成”或单张截图视为 journey 通过。

Golden Journey 只有同时满足以下条件才算通过：

1. 从规定的 clean baseline 执行到终态，关键状态转移可由同一组 correlation IDs 串联。
2. Verification Policy 检查与任务相称的 Evidence；`done` 不能由 LLM 文本直接决定。
3. 所有状态变更、外部写和 destructive 操作都经过确定性 Permission/Approval gate，并留下审计事实。
4. 成功路径和至少一个决定性失败分支都由自动化断言覆盖；截图只能作为补充 artifact，不能作为 pass oracle。
5. 最终产生可审查的 Handoff，或进入带有原因、下一步和责任人的 Attention；不允许静默停滞或虚假完成。

### 1.1 当前状态语义

在领域迁移开始前，journey 使用现有状态机：

```text
triage -> todo -> in_progress -> pending_verification -> done
                     |                 |
                     |                 +-> triage (reject / request_changes)
                     +-> failed | cancelled | Attention / recovery
```

- `triage` 是已捕获但未获准执行的 Work；`todo` 是已入队；`in_progress` 必须关联实际 Run/Attempt。
- `pending_verification` 表示执行产物已存在但完成门禁尚未通过；它不是弱化的 `done`。
- `done` 必须有 passed Evidence 和显式最终状态回写；`failed`、`cancelled` 必须保留原因与最后已知事实。
- Attention 当前由 Attention Inbox、Guardian alert/decision、action proposal、approval request 或 issue error/comment 承载，不创建平行 issue 状态。

### 1.2 当前 source of truth

| 事实 | 当前 authoritative path | Journey 中的目标称呼 |
| --- | --- | --- |
| 工程工作和终态 | SQLite `issues`、Bun Issue API、issue event/comment | Work |
| 一次执行及 provider 进展 | `issue_runs`、`agent_sessions`、provider runtime event | Run / Attempt |
| 恢复事实与预算 | `pi_supervisor_events`、`pi_recovery_attempts`、Guardian decision | Recovery / Attention |
| 权限与外部动作 | `pi_action_proposals`、approval、action gate 与 action audit | Proposal / Permission / Approval |
| 验证 | verification evidence、verifier report、review event、命令日志 | Evidence / Verification Policy |
| 代码交付事实 | 受测 Git working tree、revision、branch/remote 状态 | Handoff artifact |

LLM 只能生成 goal 解释、计划、proposal、rationale 或 Handoff 摘要；project/cwd、状态、权限、Evidence 判定和外部写结果必须来自上述确定性路径。

### 1.3 自动化验收层级

- **合同门禁**：`backend-ts/src/xuanwu/goldenJourneyContracts.test.ts` 检查六条合同、必需字段、自动化命令和真实 test path 没有漂移。
- **当前能力切片**：每条 journey 下的 backend/frontend 命令是现在可执行的最小回归，证明可复用能力仍存在。
- **完整 journey conformance**：下游实现必须用一个隔离 fixture 串起该 journey 的全部状态和失败分支。能力切片全部通过，不等于完整 journey 已经端到端实现。

产品或 UI 只有在完整 journey conformance 通过后，才能宣称对应 Golden Journey 已交付。

## 2. 通用 Evidence 与 fixture 规则

### 2.1 最小 Evidence envelope

每条 journey 的验收记录至少包含：

- `project_id`、Work/issue ID、Run/Attempt ID、actor、入口 source、开始/结束时间。
- 关键状态事件的 `before`、`after`、reason、idempotency/correlation key。
- Verification Policy 名称或版本、实际执行命令、退出状态、摘要和 artifact refs。
- 所有 proposal/approval/action 的 decision、scope、target、结果；失败时包含已脱敏 error 和下一步。
- 涉及 Git 时包含 baseline revision、changed files、最终 revision、目标 branch/remote；未执行外部写时明确写 `not_executed`。

Evidence 必须可由 API/DB/Git/fixture 重新读取验证。模型总结、toast、日志关键字或截图不能替代 authoritative fact。

### 2.2 通用 fixture 边界

1. 每个 test 使用独立临时 state dir、SQLite DB 和 1–2 个临时 Git repository；固定 clock、IDs、provider responses 和 retry schedule。
2. provider、IM/channel、approval resolver、Git hosting/remote 默认使用 fake adapter 或本地 bare remote；禁止访问真实账号、真实 webhook、真实仓库或真实发布环境。
3. fixture 只允许操作自己创建的 cwd、issue、session、event 和 remote；结束时断言无越界文件、未消费 event 和后台任务。
4. 成功与失败 fixture 从同一 baseline 分叉，一次只改变一个决定性变量；重放同一 event/action 必须证明幂等。
5. 前端 smoke 使用 fixture API/DOM 状态和用户可见的 Evidence/Attention/Handoff 断言；不得把截图 diff 设为唯一验收依据。

## GJ-01：一句话交付

### 前置状态

- 一个已注册且可读写的项目，`project_id` 与 canonical `cwd` 由确定性配置给出。
- clean Git baseline；无同一 idempotency key 的活动 Work；provider 和 Verification Policy 已配置。
- 用户只提交一句工程目标，没有提供实现步骤；Supervisor 可以澄清，但不能猜 project/cwd 或权限。

### 关键状态转移

1. Goal 被 intake 为一个 `triage` Work，并保存原始请求、project/cwd 解析依据和 acceptance draft。
2. 信息充分且权限允许时，Work 原子地进入 `todo`，Runner claim 后进入 `in_progress` 并创建 Run/Attempt。
3. provider 产出变更；执行器记录 changed files 和命令 Evidence，不接受 provider 的完成文本作为终态。
4. 产物进入 `pending_verification`；Verification Policy 通过后显式回写 `done`，否则回到 `triage`/`in_progress` 或进入 Attention。
5. 生成包含目标、diff/revision、验证证据和复核入口的 Handoff。

### 证据要求

- Goal → Work → Run → Evidence → verification review → Handoff 的完整 ID 链。
- intake 前后原文、project/cwd 解析、acceptance criteria、provider session/attempt、命令退出状态和 Git diff。
- `done` event 必须晚于 passed Evidence，并记录确定性 verifier/reviewer actor。

### 失败分支

| 条件 | 必须结果 |
| --- | --- |
| project/cwd 含糊或 acceptance 不可判定 | 保持 `triage`，进入 Attention，只问一个能解锁执行的问题；不得启动 Run |
| provider 失败但可恢复 | 转入 GJ-02 的恢复合同，保留当前 Attempt 和 Evidence |
| 验证失败 | 不得 `done`；保存失败命令和 artifact，request changes 或进入 Attention |
| 请求越过权限/范围 | gate deny/ask，审计 requested scope；不得让 LLM 直接执行 |

### 最终交付物

- 成功：一个已验证 Work、可审查的本地代码变更/revision、Evidence bundle 和 Handoff。
- 未完成：一个带 blocker、所需输入、已完成事实和安全恢复点的 Attention；不得产生半真 `done`。

### 测试夹具边界

- 临时单项目 Git repo，fixture 提供一个可由确定性 patch 修复的失败测试；fake provider 只能写该 repo。
- 成功 fixture 返回 patch 与 test command；失败 fixture 只移除 project mapping，其他变量保持相同。
- 断言不触发 push/deploy；发布动作留给 GJ-06。

### 自动化验收步骤

1. 提交一句 Goal，断言只创建一个 project-bound Work 和一个活动 Run。
2. 注入变更和 passed/failed test Evidence，分别断言 `done` Handoff 与非 `done` Attention 分支。
3. 重放 intake key，断言不会创建第二个 Work/Run；用 API/DB/Git 读取整条证据链。

当前可执行基线：

```bash
bun test backend-ts/src/http/piIssueProposalFlow.test.ts backend-ts/src/http/piVerifierWorkflowApi.test.ts backend-ts/src/http/issueVerificationApi.test.ts
node --test frontend/src/pages/issueVerificationGate.test.js frontend/src/pages/IssueDetail.structure.test.js
```

## GJ-02：失败恢复

### 前置状态

- 一个 `in_progress` Work，存在 Run/Attempt、provider session 和最近 meaningful progress checkpoint。
- project policy 明确 supervisor mode、allowlisted recovery actions、cooldown、rolling recovery budget 和 human-only failure 分类。
- fake clock 与 provider turn 可观测，允许精确模拟 crash、stream disconnect、429 和无进展。

### 关键状态转移

1. runtime/Guardian 持久化 failure signal 和脱敏 provider error，再做 deterministic diagnosis。
2. 可恢复故障生成受 scope 和 budget 约束的 recovery decision；执行前先写 attempt/idempotency 锚。
3. resume/retry 后观察 provider turn 或 Git/Evidence 是否出现 meaningful progress，再记录 recovery result。
4. 恢复成功后继续原 Work/Run；budget 耗尽、human-only 或仍无进展时进入 Attention/`failed`，不得重置历史伪装成新 Work。

### 证据要求

- 原 Attempt、failure signal、diagnosis、policy snapshot、budget window、decision rationale、recovery action/result 和前后 progress snapshot。
- 证明 crash/replay 时同一 recovery key 最多产生一次 provider side effect。
- 401/auth、permission、quota、测试失败等 human-only 分类不得出现自动 resume 事实。

### 失败分支

| 条件 | 必须结果 |
| --- | --- |
| 429 且 retry-after 未到 | `wait`/snooze 到确定时间，不消耗实际执行次数，不忙轮询 |
| 进程在 provider call 后、结果落库前崩溃 | 先观察 remote/local turn；有进展则记为 observed，不重复发送 |
| 连续恢复无 meaningful progress 或预算耗尽 | 进入 Attention/`failed`，附 attempt 历史和用户下一步 |
| auth/permission/test failure | 禁止自动恢复；直接升级并保留失败 Evidence |

### 最终交付物

- 恢复成功：原 Work 的连续 Run history、恢复审计和后续验证/Handoff。
- 无法恢复：可复现 failure bundle、剩余/耗尽预算、安全 checkpoint 和明确 Attention。

### 测试夹具边界

- 使用已有 canonical recovery fixtures；固定 provider turn、retry-after 和 clock，不做真实 provider 网络调用。
- 同一 baseline 分别注入 stream disconnect、429、401、test failure、crash replay 和 no-progress loop。
- UI fixture 只读展示 diagnosis、wait window、decision rationale 和 recovery history，不提供绕过 gate 的快捷动作。

### 自动化验收步骤

1. 注入可恢复断连，断言 signal → decision → attempt → result 审计链和原 Work 连续性。
2. 在 provider side effect 后模拟 crash 并重放，断言不会重复 resume；推进 clock 后才允许受控 retry。
3. 注入 human-only/预算耗尽分支，断言没有自动副作用且出现 Attention。

当前可执行基线：

```bash
bun test backend-ts/src/pi/issue-supervisor-recovery.test.ts backend-ts/src/http/piSupervisorResumeIdempotency.test.ts
node --test frontend/src/pages/issue-supervisor-panel.test.js
```

## GJ-03：跨项目批量

### 前置状态

- 至少两个注册项目，各自有唯一 `project_id`、canonical `cwd`、provider/policy 和独立 Git baseline。
- 一批 Work 明确关联 project、priority、依赖关系和 acceptance；不允许仅靠自然语言猜测归属。
- global concurrency 与 per-project serialization/hold policy 已固定。

### 关键状态转移

1. batch request 解析为显式 Work selection；每个 Work 保留自己的 project/cwd/scope，不创建共享可变 cwd。
2. scheduler 按 priority/依赖选择 eligible Work；同项目按 policy 串行，不同项目只在 global concurrency 内并行。
3. 每个 Work 独立产生 Run、Evidence、verification 结果和 Handoff；一个项目失败不能改写另一个项目的状态。
4. batch summary 只投影各 Work authoritative status，并列出 skipped/blocked/failed；summary 本身不成为第二套状态机。

### 证据要求

- batch request/correlation ID、明确 selection、每个 Work 的 project/cwd/priority/dependency 和 enqueue/claim 顺序。
- 并发时间线证明 cwd 隔离、per-project serialization 和 global limit；每个 Work 各自有 Evidence 与终态。
- skipped、hold、dependency failure 和 partial success 必须带确定原因，不能只给总成功数。

### 失败分支

| 条件 | 必须结果 |
| --- | --- |
| project/cwd 缺失或同名歧义 | 仅歧义 Work 进入 Attention，不猜测、不阻塞可独立确认的 Work |
| 一个项目 provider/验证失败 | 只影响该 Work/依赖后继；其他项目继续遵守 concurrency policy |
| 依赖未完成或 project hold | 保持不可 claim，并记录 dependency/hold Evidence |
| batch request 重放 | selection 与 enqueue 幂等，不创建重复 Work/Run |

### 最终交付物

- 每个 Work 的独立 Handoff/Attention，加一个可下钻的 batch summary。
- summary 必须区分 `done`、`pending_verification`、`failed`、`blocked/skipped`，不得把 partial success 报为全部完成。

### 测试夹具边界

- 两个临时 Git repos、至少三个 Work：同项目两个有序任务，另一项目一个可并行任务；fake provider 记录实际 cwd。
- 成功 fixture 固定 global concurrency；失败 fixture 只让一个项目失败或 hold。
- 禁止共享 working tree、真实外部仓库和不受控 wall clock。

### 自动化验收步骤

1. 提交显式跨项目 batch，断言 selection、priority、dependency 和 cwd 映射准确。
2. 驱动 scheduler，断言同项目不重叠、跨项目不超 global limit，且 provider 收到正确 cwd。
3. 注入单项目失败与 replay，断言隔离、幂等和 per-Work Handoff/batch summary。

当前可执行基线：

```bash
bun test backend-ts/src/pi/runnerBatchTriageScope.test.ts backend-ts/src/runner/projectLoop.test.ts backend-ts/src/db/repositories/pi/runGroupLifecycle.test.ts
node --test frontend/src/pages/sessions/projectOrder.test.js frontend/src/pages/projectHold.test.js
```

## GJ-04：远程控制

### 前置状态

- 一个启用的 fake channel connector，已知 tenant/channel/user identity、签名 secret fixture 和 project mapping。
- 本地 Runner DB/API 是 Work/Run 的唯一 source of truth；channel 只传请求、审批和回执。
- Permission/Approval policy、action allowlist/scope 和 idempotency key 规则已配置。

### 关键状态转移

1. connector 先完成认证、签名/identity 校验和 event 去重，再把 remote request 关联到本地 project/Work。
2. 只读查询从本地 authoritative state 生成回执；写请求先生成 proposal/envelope 并经过 deterministic gate。
3. `ask` 创建 approval/Attention；approve/reject 必须绑定精确 action、target、scope 和当前 provider approval ID。
4. 允许的 action 执行一次并落审计；回执引用本地 Work/Run/action 事实，不让 channel 自己维护状态。

### 证据要求

- 脱敏 raw event ref、identity/mapping decision、dedupe key、proposal、risk classification、gate decision、approval actor 和 action result。
- 证明相同 message/event replay 不重复创建 Work、回复或外部副作用。
- 本地状态与 remote reply 的 correlation ID 可互相追踪；敏感 token/signature 不进入日志或 Handoff。

### 失败分支

| 条件 | 必须结果 |
| --- | --- |
| 签名/identity 无效或无权限 | 拒绝且审计，不创建 Work/action，不泄露项目状态 |
| project mapping 缺失/歧义 | 进入一次澄清，不猜项目、不执行写操作 |
| approval 过期、scope 扩大或 provider unavailable | deny/retryable failure；不把旧 approval 套用到新 action |
| 相同 event 重放 | 返回/复用原结果，副作用计数保持 1 |

### 最终交付物

- 远程用户收到与本地事实一致的 ack/status/approval/result；本地保留完整 audit trail。
- 被拒绝或待确认时产生可操作的 Attention，而不是“已收到”后静默丢失。

### 测试夹具边界

- 只用 fake signed events、fake identity mapping、fake reply outbox 和 fake approval resolver；不连接真实 IM tenant。
- 真实 token 永不进入 fixture；失败分支只改变 signature、mapping、scope 或 resolver availability。
- 所有 remote 写只落临时 DB/本地 fake target。

### 自动化验收步骤

1. 发送合法 `/issue`/approval event，断言身份、project mapping、proposal/gate/audit 和本地 Work 关联。
2. 原样重放 event，断言 Work、provider resolve 和 reply 各最多一次。
3. 注入无效身份、歧义 mapping 与扩大 approval scope，断言零副作用和明确 Attention。

当前可执行基线：

```bash
bun test backend-ts/src/integrations/feishuAgentBridgeIssueCommand.test.ts backend-ts/src/integrations/feishuApprovalRequests.test.ts backend-ts/src/http/piActionsAuditApi.test.ts
node --test frontend/src/pages/AttentionInbox.proposals.test.js
```

## GJ-05：常驻巡检

### 前置状态

- 一个已启用的 Automation/Standing Order/Heartbeat，绑定 project scope、schedule、working hours、action allowlist 和通知策略。
- fixture 同时包含 healthy、stale/transient、human-only 三类 signal；fake clock 可推进多个 tick。
- scheduler/Guardian restart 后可从持久化 state 恢复，不依赖内存中的唯一 timer。

### 关键状态转移

1. 到 tick 时先 claim heartbeat/automation lease，增量收集 signal 并记录 observation timeline。
2. deterministic classifier/filter 去除已完成输出关键字等噪音；需要决策的 signal 进入 Supervisor/Guardian。
3. allowlisted、低风险且预算内的 action 执行并审计；需人、超预算或高风险的事项进入 Attention。
4. healthy/no-op tick 只记录最小 heartbeat fact，不制造通知；失败后下次 tick/restart 可恢复且不重复副作用。

### 证据要求

- schedule/tick ID、lease/reentry lock、observed watermark、signal family、decision/action、budget 和 notification routing。
- 证明正常状态无无意义通知，missed intent/watchdog recovery 后最多生成一份摘要。
- pause/resume/restart 和同 tick replay 的审计链可解释且幂等。

### 失败分支

| 条件 | 必须结果 |
| --- | --- |
| 上一 tick 仍持有 lease | 跳过或安全接管，不并发执行同一 standing order |
| collector/action 单项失败 | 记录局部失败并释放 reentry lock；其他独立 observation 可继续 |
| recovery budget 耗尽/需要业务判断 | 进入 Attention，停止自动 action，不忙轮询 |
| 通知 connector 暂时不可用 | 持久化 outbox/missed digest，恢复后去重补发 |

### 最终交付物

- 可查询的巡检 timeline：观察了什么、采取了什么动作、为什么保持安静、哪些事项需要人。
- 对需要人的事项产出聚合 Attention；对 healthy 周期不产出噪音式“全部正常”消息。

### 测试夹具边界

- fake clock/scheduler、临时 DB、fake notifier/outbox 和 deterministic signals；不等待真实 cron、不发送真实通知。
- 至少推进两个 tick 并模拟一次 restart/replay；限定最大循环/恢复次数，禁止无限 retry。
- healthy 与 failure fixture 只改变一个 signal 或 connector availability。

### 自动化验收步骤

1. 推进 tick，断言 lease、observation、decision/action timeline 和 healthy no-notify。
2. 重放同 tick/模拟 restart，断言无重复 action，lock 可释放，watermark 可继续。
3. 注入 budget exhaustion 与 notifier outage，断言 Attention/outbox 去重补发。

当前可执行基线：

```bash
bun test backend-ts/src/pi/heartbeatOrchestrator.test.ts backend-ts/src/runner/piAutoManageSchedulerWatchdog.test.ts backend-ts/src/pi/heartbeatConcurrency.test.ts
node --test frontend/src/pages/AttentionInbox.proposals.test.js frontend/src/pages/projectHold.test.js
```

## GJ-06：发布交付

### 前置状态

- 一个有已审查变更的 Work，处于 `pending_verification`，包含 clean baseline、changed files 和 passed Evidence 候选。
- 用户明确请求目标 artifact：scoped commit、branch、push、PR、release 或 tracker update；目标 repo/remote/branch 必须确定。
- Git/remote/destructive policy 和 approval scope 已配置；默认无 push、deploy 或真实外部写授权。

### 关键状态转移

1. 发布前重新读取 Git 与 verification facts，确认只包含目标 Work 的改动且 Evidence 仍对应当前 revision/tree。
2. Verification Policy 通过后，为每个外部/破坏性动作建立精确 proposal；LLM 不能用“用户应该同意”绕过 gate。
3. 仅执行获准 artifact；每次 action 记录 before/after revision、target、provider response 和 rollback handle。
4. 生成 Handoff；若仍需人工复核保持 `pending_verification`，确认通过后显式 `done`。
5. reviewer `request_changes` 时回到可执行 Work 状态并保留原 revision/review history，不能覆写失败证据。

### 证据要求

- baseline/current revision、`git status`/changed files、scoped diff、验证命令与退出状态。
- commit/branch/remote/PR/release/tracker 每一步的 proposal、approval、actor、target、result URL/ID（fake 或本地）和 rollback 信息。
- 证明未经授权时 remote refs/deployment/tracker 零变化；Handoff 引用的 revision 与实际一致。

### 失败分支

| 条件 | 必须结果 |
| --- | --- |
| working tree 混入其他 Work 或 Evidence 过期 | 停止发布，进入 Attention；不得自动 stage/丢弃他人改动 |
| 验证失败 | 不 commit/push/deploy，不 `done`；保存失败 Evidence |
| push/PR/release 未授权或被拒绝 | 可保留已授权本地 artifact，但远端零变化；Handoff 标明 `not_executed` |
| 外部写部分失败 | 保留各步骤结果和 rollback handle，状态保持非 `done` 直到一致性确认 |
| reviewer request changes | 回到 `triage`/受控执行路径，关联原 Handoff 和 review reason |

### 最终交付物

- Handoff 至少含目标、scoped changed files、revision/artifact refs、Verification Policy 结果、已执行/未执行外部动作和复核入口。
- 成功终态只代表用户请求的目标 artifact 已按 gate 完成；只生成 commit 时不得暗示已 push/deploy。

### 测试夹具边界

- 临时 Git repo + 本地 bare remote 或 fake hosting/tracker adapter；禁止真实 push、PR、release、deploy 和 tracker update。
- fixture 预置一个目标变更和一个可选的无关 dirty file，用于证明 scoped commit 与停止策略。
- 对 approval deny、remote partial failure 和 request changes 分别从同一 baseline 分叉；测试后校验 refs/working tree。

### 自动化验收步骤

1. 在 passed Evidence 下请求 scoped commit，断言 commit 只含目标文件，Handoff revision 可由 Git 读取。
2. 请求 push/PR/release，分别注入 approve/deny，断言 gate/audit 与 remote refs 或 fake target 的精确变化。
3. 注入 dirty scope、stale Evidence、verification failure 和 partial remote failure，断言非 `done`、零越权清理及可回滚 Handoff。

当前可执行基线：

```bash
bun test backend-ts/src/http/issueVerificationApi.test.ts backend-ts/src/http/piVerifierWorkflowApi.test.ts backend-ts/src/cli/issue.test.ts
node --test frontend/src/pages/issueVerificationGate.test.js frontend/src/pages/IssueDetail.structure.test.js
```

## 3. 新旧模型、迁移与回滚

本 ADR 只定义验收语义和 test fixture，不新增公开 API、schema、共享状态机、provider adapter、双写或双读。现有 Issue/Session/Guardian/PI/Runner 路径保持 authoritative，因此本期代码回滚仅需移除本合同及其结构门禁，不涉及数据回滚。

后续 Work/Run/Evidence/Handoff 新模型若与旧模型并存，必须在对应迁移 ADR 中逐字段说明：

1. old/new 的唯一 source of truth，禁止双主；projection 不得反向决定 authoritative status。
2. 双写/双读的启用、parity audit、切主和停止里程碑；兼容窗默认不超过两个正式 release。
3. 回滚步骤：停止新写入、恢复旧读取，并能从 authoritative event/state 重建 projection。
4. clean baseline 下至少完整重跑本文件一条 journey，并对六条 journey 做受影响回归。
5. 删除门禁：无 active consumer、parity/备份恢复通过、观察窗结束、fixture 和文档已切换，才可删除旧表、route 或兼容代码。

任何迁移验收失败时保持旧路径 authoritative，记录 blocker；不得复制第三套临时状态机、无期限双写或让 LLM 决定冲突结果。

## 4. 合同变更门禁

- 改变六条 journey 的用户起点、成功终态、权限不变量或 Evidence 最小集合，必须新增 superseding ADR，并同步 ADR-XW-0001。
- 仅补充 fixture、增强自动断言或替换已删除的兼容 test path，可以 scoped 修改本文件，但必须让合同门禁和相关 journey baseline 一起通过。
- 删除失败分支、把截图/模型总结升级为 pass oracle、或用宽泛 allowlist 绕过 deterministic gate，均视为合同回归。
