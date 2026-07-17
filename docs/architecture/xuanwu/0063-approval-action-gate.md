# ADR-XW-0063：Approval 模型、权限矩阵与确定性 Action Gate

- 状态：Accepted（G0 / W0 语义与可执行合同；不新增第二套 runtime 或 storage writer）
- 日期：2026-07-17
- 依赖：ADR-XW-0061（XW P08.07 / issue 713，`done`）；P06.06 Work/Run/Evidence/Handoff control tools（issue 685，`done`）
- 可执行清单：`backend-ts/src/xuanwu/approvalSemantics.ts`
- 覆盖校验：`backend-ts/src/xuanwu/approvalSemantics.test.ts`
- 范围：`pi_approval_requests`、`pi_actions`/`pi_action_events`、provider approvals、`project_pi_policies` 与所有未来 external write、git push、PR、deploy、dangerous command 的统一 gate 语义

## 1. 决策

Approval 是权限决定，不是 Attention、Notification、Automation、Work、Run 或 provider runtime 的替代状态机。LLM/PI/Guardian 只能提出 action/request、说明和候选 scope；**确定性 Action Gate** 在任何 provider/external call 前裁决，human decision 只能在 gate 的 `ask` 分支内授权，不能把 `deny` 改成 `execute`。

本期冻结统一模型和迁移边界，不创建平行 `approvals` 表、不改 provider 协议、不把项目 policy 偷换成人类 grant。当前已验证 carrier 继续写入其唯一 authority；`approvalSemantics.ts` 是本 ADR 的可执行 canonical matrix，而不是第二个 runtime gate。

## 2. source of truth 与当前 W0

| 事实 | 当前 source of truth | 责任 |
| --- | --- | --- |
| provider approval request、delivery、resolver attempt、最终 provider decision | `pi_approval_requests` | request/resolution 及 provider correlation；`provider + session_id + approval_id` 幂等 |
| PI internal action、gate decision、execution state、idempotency | `pi_actions` + `pi_action_events` | `actionGate` / `executeSafePiAction` / `resolvePiActionDecision` 的 audit execution seam |
| 项目授权上限、allowlist、scope、authorization window | `project_pi_policies` 与 project settings | deterministic policy，不是人类 approval grant |
| provider-side acknowledgement | provider approval protocol | Runner 不伪造 provider 已执行事实 |

**G0/W0：双读为 0，双写为 0。** `pi_approval_requests` 和 `pi_actions` 有不同的事实边界，不能互相复制行、不能让 Attention projection 回写它们。Attention 仅投影待处理 approval；Notification/outbox 仅送达；Automation/Heartbeat 仅触发或观察，均不能授权或 dispatch。

## 3. Schema、状态与 audit

当前 provider schema 已拥有 `approval_id`、`project_id`、`issue_id`、`run_id`、`provider/session/thread/turn`、request/risk/summary、delivery、resolver、decision/scope/timestamp 与 raw payload（已脱敏）。internal Action Gate 已拥有 action payload、risk、gate decision/reason、actor、snooze、idempotency 与 `pi_action_events`。这两个 carrier 的写入继续是唯一 writer。

每个 request/gate lifecycle 必须审计：candidate/request、deterministic policy/safety decision、ask/deny、human decision、provider resolver attempt/result、grant consume、dispatch started/result/error、expiry、revoke 与 recovery replay。审计至少绑定 actor、reason、policy/gate ref、project/session/issue/run/action subject、correlation/idempotency ref 和 timestamp；文本保持既有 redaction，不记录 bearer token 或 secret。

终态不可被后续重复/撤销 decision 覆盖：provider request 的 `approved/rejected/cancelled/expired` 已 terminal；action 的 completed/failed/executing 不得重新 dispatch。deny/revoke 的效果是拒绝尚未执行的 binding，不重写已发生外部事实。

## 4. Scope、TTL 与 revoke

| scope | W0 行为 | target 允许范围 | TTL / revoke |
| --- | --- | --- | --- |
| `once` | active。provider resolver 只收到 current-turn approval；internal action 以 exact idempotency key replay | exact action subject 一次 | consume on attempt；action/payload/policy/window 不匹配、expiry 或 revoke 均 fail closed |
| `session` | disabled。Codex `acceptForSession` 被降级为 turn，TTL=0，因为 provider semantics 未证明 narrow | only exact provider/session/action-family allowlist；external/dangerous 仍只能 once | bounded TTL，并受 policy window；session end、revoke、scope/policy revision 立即失效 |
| `project` | `policy_only`。现有 project policy 的授权 window 不是 human grant | named low-risk families 的 deterministic ceiling | bounded TTL；project pause、revoke、scope expansion 或 policy revision 失效；不得授权 push/PR/deploy/external/dangerous |

`deny` 立即 terminal/拒绝；`revoke` 使未 consume 的 grant/resume binding 无效并审计，不能把已完成 action 倒回。项目 policy 缩窄或过期也必须在 dispatch 前重新被 gate 检查。

## 5. 权限矩阵

| action family | 默认 Gate | 允许 approval scope | 不可绕过的边界 |
| --- | --- | --- | --- |
| trusted read-only | `execute` | none | 仍受 project/resource scope、MCP/tool registry 与 audit |
| scoped internal write（Work/Run/Evidence/Handoff control） | `ask` | once；future session/project 仅 low-risk explicit allowlist | exact action/payload/project/issue scope、policy window、idempotency |
| provider command/file approval | `ask` | once；future narrow session | safety policy、provider protocol、current session downgrade |
| git push / PR / deploy / external write | `ask` | once only | exact target/operation、human decision、external delivery audit；本期不接入/执行真实外部系统 |
| destructive command / force push / privilege escalation / secret access | `deny` by safety policy | once only when a later explicit non-forbidden policy exists | deterministic deny-list 永远优先，LLM/human scope 都不能覆盖 forbidden |

未知 action、未知 provider semantics、missing policy cache、invalid/expired/revoked binding、scope mismatch、payload mismatch 和 missing audit correlation 一律 fail closed (`deny` 或 `ask`，绝不 `execute`)。

## 6. Deterministic gate 与 resume token

统一顺序固定为：

1. normalize 并绑定 project/session/issue/run、action family、idempotency key、payload digest、policy revision；
2. safety deny-list → authorization window/TTL → revoke → policy allowlist/scope → recovery budget → risk classification；
3. 无 exact active grant 则先持久化 `ask`/`deny` 与 audit，再通知或调用 provider resolver；
4. human approval 只生成 non-bearer resume binding；经既有 Action Gate dispatch 并写 result；
5. restart/retry 以同一 idempotency binding 返回已有 in-flight/terminal outcome，绝不二次 dispatch。

target `resume token` 只可保存为 opaque hash，绑定 approval request id、action id/type、project/session scope、payload digest、idempotency key、policy revision、expiry 与 revocation generation。它不是客户端或 LLM 提供的 capability；mismatch、expired、consumed、revoked 都 fail closed 并审计。W0 没有 universal resume-token bearer：provider id 与 `pi_actions.idempotency_key` 仍各自是现有 recovery correlation。

## 7. 兼容、迁移、回滚与最终删除门禁

- **当前 W0：** 无新 schema、无 universal grant writer、无 dual read/write。provider request、Action Gate、project policy 各自唯一 authority。
- **W1：** 仅在接受 field/state mapping 后，允许一个 additive grant/resume projection shadow-read current authorities；不得改变 current decision，shadow failure 不得 dispatch 或外写。
- **W2/G4：** 先做 deterministic read comparison；只在 non-LLM cutover approval、TTL/revoke/recovery parity 后切一个 target writer。legacy route 只能翻译到同一 gate command，W1+W2 最多两个连续正式 release。
- **回滚：** G4 前关闭 projection/read 即回 current carriers；G4 后先停 target writer，再按 audited cutover correlation replay delta，确认仅一个 writer 后恢复 retained compatibility path。
- **最终删除门禁：** P11/G7；pending request=0、active grant=0、一个 release consumer-zero、request/decision/audit parity、fresh backup、isolated restore、retained rollback artifact 和 exact non-LLM destructive approval。任一条件不满足即保留旧 carrier，禁止第三路径。

## 8. 最小验证

```bash
cd backend-ts
bun test src/xuanwu/approvalSemantics.test.ts src/pi/actionGate.test.ts src/pi/approvalFastPolicy.test.ts src/providers/codex/approvalBroker.test.ts
```

覆盖：越权/过期 gate deny；LLM policy 不能把 high-risk 变 execute；session grant 降级/TTL=0；idempotency recovery replay 不重复 dispatch；canonical source-of-truth/rollback/delete gate。provider resolver 的 terminal/retry 行为继续由 `approvalRequests`、`piApprovalRequestsApi` 和 `providerApprovalRequests` focused tests 覆盖。
