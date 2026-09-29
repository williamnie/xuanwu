# ADR-XW-0043：Handoff API、页面与交付通知

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P05.08 / Runner #679
- 硬依赖：XW P05.02 / #673、P05.03 / #674、P05.05 / #676、P05.06 / #677（均 `done`）
- append-only repository：`backend-ts/src/db/repositories/handoffs.ts`
- HTTP：`backend-ts/src/http/handoffApi.ts`
- notification：`backend-ts/src/notifications/handoffNotifier.ts`
- UI：`frontend/src/pages/Handoffs.jsx`

## 1. 决策与 authority

普通任务的 PI `accept` 由 `domain/handoff/acceptedDelivery.ts` 准备本地交付记录，`runner/piAcceptanceApplication.ts` 在同一事务内保存 Completion Card、Evidence、Handoff、通知及 Work 终态。准备阶段仅允许有界 Git 读取；进入写事务后重新核对 Work revision 和最新 Run，重复及并发接受同一卡片只生成一份记录。

交付记录关联该 Work 的执行链，以首次 Run 的工作区基线与最后 Run 的终态快照归属文件，覆盖多轮执行产生的提交。开始前已存在且保持不变的脏文件被排除；混合修改、快照缺失、记录截断或失败检查保留为 `draft` 及明确风险，不改变 PI 对任务完成的判断。命令 Evidence 来自实际终态命令观察，Git Evidence 来自持久化的基线和终态观察，不把模型叙述变成证明。未采集 diff 行数时保持未知，不伪造为零。

完整终态工作区快照只存事件账本，Completion Card 和 LLM 上下文携带快照引用；交付 producer 按同 Work、同 Run 和内容哈希读回，不把可能很大的文件指纹列表加入模型上下文。

该自动记录固定为 `local_changes`，不会执行 commit/push/PR/deploy/release，也不会把模型声称的外部交付升级成事实。现有外部交付模式和审批门禁继续保留；已有历史任务不自动回填。无快照的旧 Run 或非 Git 任务可正常被 PI 接受，同时留下说明缺口的草稿。第一版凭证有界关联最多 256 个 Run、200 条已有 Evidence 和完成卡片的命令观察，超限显式标记不完整。

P05.08 不新建 Handoff table，也不复制 Git、Evidence、review、provider 或 tracker 状态。完整
`HandoffRecord` 由 P05.03–P05.07 producer 通过 `recordHandoff()` 追加到 Issue 所属的 `issue_events`：初始版本使用
`handoff.prepared.v1`，后续 revision 使用 P00.04 已批准的 delivery requested/completed/failed/superseded 事件。
同一 Handoff ID 相同 payload 幂等 replay；不同 payload 必须 revision 连续递增，状态变化还必须通过
`evaluateHandoffTransition()` 的确定性 gate/audit。

authority 边界保持：

- Git repository 拥有 branch/tree/commit；GitHub/GitLab 拥有 remote ref、PR/MR 与 URL；
- P04 Evidence event/artifact 拥有验证事实，review decision 与 delivery action audit 继续由其原 carrier 拥有；
- `sync_outbox(operation_kind='tracker_update')` 拥有 tracker delivery 的排队、重试和发送状态；
- `issue_events:handoff.*.v1` 是版本化 Handoff projection 的读取 carrier；它引用上述事实，不反向改写；
- `issues`/Work service 继续拥有 Work status。Handoff API 是只读 surface，不得把 Work 标成 `done`。

## 2. API 与 delivery status refresh

新增 authenticated domain routes：

```text
GET /api/handoffs
GET /api/handoffs/:id
```

List 支持 `project_id`、`work_id`、`status`、`delivery_mode`、bounded limit/cursor，只返回 bounded summary、
branch/commit/PR refs 及计数；detail 返回完整 `HandoffRecord`、storage provenance、通知摘要与 delivery status。
非法 ID、filter、cursor 和不存在的对象返回稳定、可行动的 4xx。

delivery refresh 是每次 GET 的 fresh local read：record 内的 delivery action outcome 与同 Handoff 最新 tracker outbox
状态合并成 `draft | ready | delivering | failed | delivered | superseded`，并返回 `refreshed_at` 和每个 action 的
`source_ref`。Refresh 不调用外部 provider、不执行 push/PR/tracker update，也不改变 Handoff/Work；远端新事实必须先由
既有 provider + audit producer 形成下一 Handoff revision，不能由 UI 猜测。

## 3. 页面、copy/open 与通知深链

`Handoffs` 是独立 lazy page：左侧 list，右侧 detail，展示 branch、commit、PR、Evidence、changed files、delivery
actions、review、风险和确定性 next step。Refresh 重新读取 list/detail；收到 `handoff.notification` SSE 时也做一次
reconcile。

- copy 使用 Clipboard API，并通过现有 toast 给出成功/失败反馈；不使用原生 alert/confirm；
- open 只接受解析后 protocol 为 `http:`/`https:` 的 PR URL，并使用 `noopener noreferrer`；branch/commit/Evidence
  仅复制 ref，不拼 shell 或猜 provider URL；
- 页面深链固定为 `#/handoffs/<encoded-id>`。App 启动和 `hashchange` 都用严格 Handoff ID parser 恢复对应 detail。

`recordHandoffDelivery()` 在同一 SQLite transaction 写 Handoff event 与现有 `notifications` row，成功 commit 后才发布
SSE。仅 `ready|delivered` 通知；相同 Handoff replay 不重复通知。通知正文只含 mode、changed/Evidence/risk 计数和
next step，payload 以 allowlist 携带 Handoff/work ID、branch/commit/PR ref 与深链；不包含 diff、Evidence excerpt、
文件路径、token、cookie 或 provider response body。

## 4. 兼容、迁移、回滚与删除门禁

- **当前窗口：W0。** 本 API 不把 P04.07 的 `legacy_incomplete` signal 冒充完整 Handoff。Fresh P05 producer 与普通
  Issue completion producer 都只经 `recordHandoff()` 写同一个 append-only Handoff stream；没有 Handoff table 双写，
  也没有两个 writer authority。新的 Issue `done` transition 必须读取已持久化的 `ready|delivered` Handoff；若只能
  得到 verification Evidence、却没有确定性的交付 artifact/revision，则 fail closed 到 `pending_verification`。
- **W1/W2：** 只有通过 plan G2 后才允许 W1 legacy primary + target shadow comparison，最多一个正式 release；
  W1+W2 总 dual mode 不超过两个正式 release。必须比较 stable ID、revision、mode/status、Work/Run/Evidence links、
  action outcome、notification link 和 delivery status。Handoff 只作为 Work acceptance 的必需审计输入，不成为新的
  Work status authority；status 写入仍只由 `issues`/Work completion gate 执行。
- **历史迁移：** 不为现有 `done` Issue 无条件合成或回填 Handoff。只有能从已存 Evidence 与 Git/provider facts
  确定性重建的记录，才可由后续显式迁移处理；本变更不修改 live DB。
- **回滚：** 注销 Handoff routes/page，停止 producer 调用 `recordHandoffDelivery()`，恢复原 completion/read surface；
  保留已写 `issue_events`、notifications、Git/provider artifacts、outbox 与 audit，不删除外部交付或伪造 Work 回滚。
- **最终删除门禁：** 仅 P11.03/P11.06 + G7、P04/P05/P06 Golden Journey、clean baseline local handoff、通知深链、
  outbox/notification restore rehearsal、连续一个正式 release legacy producer/consumer 为零并保留上一兼容 build 后，
  才能删除 legacy completion projection/reader。本 issue 不执行 destructive 迁移。

## 5. Focused verification

```bash
cd backend-ts
bun test src/http/handoffApi.test.ts src/http/readApiContract.test.ts

cd ../frontend
node --test src/pages/handoffPageModel.test.js
npm run build
```

`handoffApi.test.ts` 使用真实临时 Git repository 执行 P05.03 local branch/commit service，再持久化 Git Evidence、
Handoff、notification，并通过真实 Router 读取 list/detail；同时验证 branch 指向 commit、幂等 replay、通知深链和
通知不含 changed path。前端 fixture 验证 link round-trip、copy summary、HTTP(S)-only open action 与 lazy route wiring。

## 6. Work 交付与反馈展示（#977）

Work 交付页集中展示改动摘要、未验证事项、风险和当前明确审批问题。关联 Evidence 可按 ID 展开决定性输出、退出码并下载已有 artifact；只在展开时请求明细，核对 Evidence ID 与 Work scope。CI、合并、部署分别展示：本地测试通过、Work done、Handoff ready/delivered 或交付类型引用均不能替代外部事实。当前 Handoff 不提供 CI/merge authority，因此显示“未记录”。

`GET /api/works/:id` 增加只读 `feedback` 投影，读取既有 Review/Revision/PI 事件与 Issue Run，不增加数据库 schema、审批状态或消息状态。反馈保留原问题、Review ID/revision、原文、来源事件、原 Run、续跑 Run/Session/Turn。已预约但未确认启动、Run 已结束且 PI 尚未决定均显示“已收到”；已启动显示“执行中”；仅 Issue done 显示“完成（不代表已上线）”；新 open Review 显示“需补充”。失败、取消单独展示。读取最多 500 条相关审计事件，缺少可匹配请求时不推断反馈。

页面仍调用原 human-review API。确认框固定提交打开时的请求快照；409 后刷新权威状态，不自动重试旧回答。待处理反馈在可见页面每 10 秒刷新，确认框打开时停止轮询；SSE transport 不变。

IM 沿用 `pi_notification_intents` 与现有 outbox，反馈通知去重键绑定回答事件；同一回答重放不再次通知，也不被原任务启动通知吞掉。通知保留请求版本和 Work 深链，旧版本审批通知拒绝入队。交付通知保留计数型脱敏边界，明确关联 Evidence 不等于通过，实际内容在交付页核对。消息偏好、聚合和 Agent Communication Gateway 的既有策略继续有效。

#977 只在临时 DB、Provider stub 与本地浏览器 fixture 中自动验证；真实 IM 发送、真实页面及主观视觉验收归 #980，不包含发布或部署。
