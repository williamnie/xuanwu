# P13.01：知情人类审批、同 Session 修订闭环与分级 Handoff

## 1. 背景

当前 `pending_verification` 同时承载三种不同含义：

1. PI/Verifier 正在执行确定性验收；
2. 系统缺少 Evidence 或 Handoff，等待内部修复；
3. 确实需要人类作出产品、架构、视觉、费用或风险决策。

这会产生三个直接问题：

- Work Detail 只显示“需要验收”和通用的“接受 / 要求修改 / 拒绝”，人类不知道自己同意了什么；
- 生命周期通知将 `pending_verification` 统一标为 `watch`，即使真正等待人类也可能不发首次通知，直到 24 小时超时；
- “要求修改”只把 Issue 退回 `triage`，不会把意见送回原执行 Session，无法形成修改、复验、再审批闭环。

另外，Issue-backed Work 当前把 `requires_handoff: true` 写死为所有 Work 的完成条件。Handoff 对发布、部署、迁移和下游交接有价值，但不应成为问答、调研、文档和普通本地修改的统一硬门禁。

本设计把“机器验证”“人类决策”“修订执行”“交付凭证”拆成独立但可关联的合同。

## 2. 目标

### 2.1 人类审批必须知情

系统只有在存在持久化、版本化的 `HumanReviewRequest` 时，才允许展示人类审批按钮。审批页面和通知必须明确回答：

- 你要决定什么；
- PI 建议什么及其依据；
- 你不需要做什么；
- 接受、要求修改、拒绝分别产生什么影响；
- 可以查看哪些 Evidence、Handoff 或产物。

人类提交的决定必须引用 `review_request_id + revision`。旧页面或已被 supersede 的审批单必须以 `409 stale_review_request` 失败，不能把模糊点击记录成新决策的授权。

### 2.2 PI 默认自主验收

确定性、低风险且 Evidence 可自动获取的任务由 PI/Verifier 自主完成。只有以下情况进入人类审批：

- 产品范围、架构长期取舍；
- UI/视觉等主观质量；
- 生产发布、费用、外部写或风险接受；
- 自动恢复预算耗尽；
- 信息冲突，PI 无法安全决策。

### 2.3 “要求修改”继续原 Session

人类输入调整意见后，系统必须：

1. 保存人类原文；
2. 生成结构化 `HumanRevisionRequest`；
3. supersede 当前 Review Request；
4. 复用原 `provider_session_id` 创建新 Turn；
5. 创建新的 canonical Issue Run，不能重写已结束 Run；
6. 将 Work 置回 `in_progress`；
7. 本轮产生新鲜 Evidence，并重新进入自主验收或生成新版人类审批单。

如果原 Provider 不支持 `resume_session`，或 Session 已不可恢复，系统不得静默新建 Session；本次命令失败关闭并保留原 Review Request，后续若要新建 Session 必须由 PI 生成新的明确决策请求。

### 2.4 Handoff 按交付风险分级

Work 使用：

```ts
type HandoffPolicy = "none" | "summary" | "required";
```

- `none`：问答、调研、无文件/外部交付；
- `summary`：文档、小配置、普通本地代码修改；应自动生成摘要，但缺失不阻塞完成；
- `required`：commit/push/PR/deploy/release、迁移、安全变更、下游硬依赖。

旧 `requires_handoff` 仅作为兼容投影：

- `handoff_policy === "required"` 时为 `true`；
- 其余为 `false`。

## 3. 非目标

- 不让前端使用 LLM 临时生成审批文案；
- 不把人类 Accept 变成绕过所有机械 Evidence 的万能后门；
- 不删除或改写历史 Review、Evidence、Run、Handoff；
- 不在 Session 恢复失败时自动切换 Provider 或新建 Session；
- 不让通知 Agent 改写已经持久化的审批问题。

## 4. 领域合同

### 4.1 HumanReviewRequest

`HumanReviewRequest` 通过 `issue.human_review_requested.v1` 写入 append-only `issue_events`：

```ts
type HumanReviewKind = "decision" | "acceptance" | "risk_acceptance";

type HumanReviewRequest = {
  acceptance_summary: string[];
  consequences: string;
  created_at: string;
  evidence_refs: string[];
  excluded_scope: string[];
  id: string;
  issue_id: number;
  kind: HumanReviewKind;
  question: string;
  recommendation: string;
  revision: number;
  status: "open" | "accepted" | "changes_requested" | "rejected" | "superseded";
};
```

最新 request-time projection 规则：

1. 取最高 revision 的 `issue.human_review_requested.v1`；
2. 若存在相同 ID/revision 的 `issue.human_review_superseded.v1`，不再可审批；
3. 若存在匹配的 `issue.verification_reviewed`，状态为 resolved；
4. 不从 Issue title、error、Agent narrative 或前端模板推断新的审批问题。

### 4.2 HumanReviewDecision

审批 API 请求：

```json
{
  "action": "accept | request_changes | reject",
  "comment": "人类原始意见",
  "review_request_id": "review:...",
  "review_revision": 1
}
```

规则：

- `request_changes` 与 `reject` 必须提供非空 comment；
- `accept` 可以附带 comment；
- ID/revision 必须匹配当前 open Review Request；
- 审批审计必须能回查 request 的 question、kind 和 revision；
- `kind=decision|risk_acceptance` 的 Accept 只关闭人类决策条件，Issue 保持 `pending_verification` 并交回 PI；
- `kind=acceptance` 才复用现有人工交付 Evidence 门禁；
- 人类 Evidence 只能证明这一个明确问题的决定，不能代替未满足的 `required` delivery gate。

### 4.3 HumanRevisionRequest

`request_changes` 生成：

```ts
type HumanRevisionRequest = {
  feedback: string;
  new_run_id: string;
  provider: string;
  provider_session_id: string;
  review_request_id: string;
  review_revision: number;
  resumed_from_run_id: string;
  status: "executing";
};
```

人类原文是 authority。PI 的任何结构化解释只能作为可审计补充，不得删除、替换或扩张原文。

## 5. 状态与所有权

第一阶段保持现有 Work status 词汇，避免公共 schema 迁移；在 Work Detail 投影中新增：

```ts
type VerificationProjection = {
  owner: "pi" | "human";
  phase: "human_review" | "pi_verifying" | "pi_repairing" | "complete";
  request: HumanReviewRequest | null;
};
```

投影规则：

- 有 open HumanReviewRequest：`owner=human, phase=human_review`；
- 已提交调整并继续 Session：`owner=pi, phase=pi_repairing`；
- 无 open Request 且等待 verifier：`owner=pi, phase=pi_verifying`；
- Issue 已终态：`owner=pi, phase=complete`。

前端只在 `owner=human` 时显示审批动作。

## 6. 通知语义

首次通知：

- `verification.owner=human` 必须产生 `requires_user=1` 的通知 intent；
- 立即进入 Agent Communication Gateway；
- Agent 只能决定排版，不能 suppress、改写 question 或改变可选动作；
- 幂等键使用全局唯一 `review_request_id`（ID 已包含 Issue scope，revision 同时写入 payload）。

24 小时语义：

- 仅作为已送达、未处理审批的去重提醒；
- 不是第一次通知的等待窗口；
- 已处理、superseded 或 revision 已变化时取消提醒。

通知正文必须原样包含 question，并在存在时包含 recommendation、acceptance_summary、
excluded_scope 和 consequences；同时携带 Issue/Review 标识供渠道生成深链。

## 7. 同 Session 修订执行

### 7.1 原则

同 Session 不等于重写旧 Run：

- `provider_session_id` 保持不变；
- 新建 `provider_turn_id`；
- 新建 canonical Issue Run sequence；
- 旧 Run、旧 Evidence 和旧 Handoff 保持不可变；
- 新 Handoff 可以通过 supersedes 关系引用旧 revision。

### 7.2 Action

新增确定性领域命令（由已有 verification API 调用，不再多套一层人工批准 Action）：

```text
human_review.resume_revision
```

它与面向故障恢复的 `session.resume_followup` 分离。`resume_revision` 接受已经结束的 Run：

1. 校验当前 Review Request、Issue revision、旧 Run 和 Session ref；
2. 记录 `issue.human_revision_requested.v1`；
3. 在数据库事务中创建下一 sequence 的 Issue Run、将 Issue 改为 `in_progress`，并先占用该 request revision；
5. 调用 Provider `sendSessionMessage`；
6. 持久化同 Session 的新 Turn ref；
7. 失败时将新 Run 标为 failed、恢复 Issue/Review 可重试状态并保留人类原文。

Action 使用审批决定本身作为权限 authority，不再要求第二次确认，但仍受 Session scope、幂等键和 Provider capability 校验。

### 7.3 Follow-up prompt

发送到 Session 的 prompt 至少包含：

- 原审批问题；
- 人类原始意见；
- 原审批范围；
- 要求按意见修改且不扩大范围；
- 要求重新读取当前工作区/runtime；
- 要求产生新鲜 Evidence；
- 禁止把旧 Run Evidence 当作本轮证明。

## 8. Handoff 完成门禁

Completion Gate：

- `none`：忽略 Handoff；
- `summary`：尝试生成 Handoff；失败记录 `handoff_gap` 但不阻塞；
- `required`：必须存在关联当前 Run 的 `ready|delivered` Handoff。

Human Accept 仅解决 HumanReviewRequest 对应的 decision criterion。对于 `required` Handoff，人类不能通过空泛 Accept 制造交付事实。

## 9. UI

Work Detail 与旧 Issue Detail 必须使用同一 Review Request：

1. 标题改为“需要你审批”；
2. 首屏展示 `question`；
3. 展示 PI 推荐、依据、无需执行事项和决定影响；
4. 产物/Evidence 使用可展开链接；
5. 通用按钮必须与完整 question 同屏，确认弹窗不得只显示孤立的“接受”；
6. Accept 确认弹窗重复 question；
7. Request Changes 提供必填 textarea，提交文案为“提交调整意见并继续本 Session”；
8. 提交后刷新 Work Detail，展示复用的 Session ref、新 Run sequence 和实时状态。

没有 open Review Request 时：

- 不显示通用 Accept；
- 显示“PI 正在自动验收”或“PI 正在补齐交付证据”。

## 10. 兼容与迁移

- 历史 `pending_verification` 不自动视为人类审批；
- 历史无 Review Request 的 Accept UI 隐藏；
- 历史人工 Evidence 保留，但不得自动绑定未来 Review revision；
- 解析外部旧 acceptance contract 时，`requires_handoff=true` 双读为 `handoff_policy=required`；
- 新写入统一使用 `handoff_policy`；
- 对当前历史 Work 的策略变更写 append-only policy event，不手改 Evidence/Handoff。

## 11. 失败与恢复

- Session 不存在/Provider 不支持 resume：失败关闭本次命令，保留 open Request，绝不静默新建 Session；
- resume transient failure：新 Run 标记 failed，Issue 回到 `pending_verification`，Request 重新打开供恢复/重试；
- feedback 含糊：仍原样发送；若 PI 无法执行，再生成一个聚焦的新 Review Request；
- stale review：HTTP 409，不产生评论、状态变化或 Action；
- 并发重复提交：首个命令会事务性占用 Review ID/revision，后续请求 HTTP 409，不创建第二个 Run；
- 新 Run 失败：保留 feedback 与 Run 审计，恢复可重试状态，不回滚旧 Run。

## 12. 验收矩阵

### 12.1 人类审批

- 无 Review Request 时无审批按钮；
- question、recommendation、excluded_scope、consequences 在 Web 与通知一致；
- Accept/Request Changes/Reject 均绑定 ID/revision；
- stale 页面失败且零副作用。

### 12.2 自主验收与通知

- PI-owned verification 不通知人类；
- Human-owned review 立即产生 `requires_user=1` intent；
- 首次消息不能被 suppress；
- 24 小时只产生一次未处理提醒。

### 12.3 修订闭环

- Request Changes 必填文本；
- 新 Turn 复用相同 provider_session_id；
- 新建 canonical Issue Run；
- 重复请求不创建重复 Run；
- 新 Evidence 绑定新 Run；
- Session 无法恢复时不静默新建 Session。

### 12.4 Handoff

- `none/summary/required` 三种策略分别验证；
- `summary` gap 不阻塞；
- `required` gap fail closed；
- 历史 Handoff 和 Review 保持可审计。

### 12.5 815 场景

页面必须显示：

> 是否接受 Node/TypeScript/PostgreSQL、OIDC、BlobStore、Provider 适配层、禁止 Mock，以及 V0.1 范围这些技术和产品取舍？

并明确：

- 不需要安装数据库；
- 不需要运行程序；
- 不需要验证真实图片生成；
- Accept 后后续 Work 以该 ADR 为实现依据；
- Request Changes 会把意见送回原 Session 并启动新 Run。
