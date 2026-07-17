# ADR-XW-0069：重启恢复与一致性不变量

- 状态：Accepted（XW P10.01）
- 日期：2026-07-18
- 依赖：ADR-XW-0013（P02.03 Work command）、ADR-XW-0023（P03.04 Run lifecycle command）、ADR-XW-0063 Automation scheduler（P08.03）、ADR-XW-0063 Approval action gate
- 可执行合同：`backend-ts/src/xuanwu/restartRecoverySemantics.ts`
- 当前接线：`backend-ts/src/main.ts`、`runner/recovery.ts`、`runner/piAutoManageScheduler.ts`

## 1. 决策与边界

本 ADR 定义进程 crash/restart 时 Work、Run、Automation、Approval 与 Outbox 的**恢复仲裁规则**。它复用当前经过验证的 Issue/Session/Guardian/PI carrier，不建立全局 recovery 表、第二 scheduler、第二 approval/outbox writer 或新的 public API。

`restartRecoverySemantics.ts` 是 W0 的可执行 inventory；它不执行 mutation，runtime 仍只允许各 carrier 自己的 command/repository 写状态。未来若增加新的 lease、fence 或统一 recovery command，必须先 supersede 本 ADR 并明确字段映射、单 writer、W1/W2 期限和 rollback。

## 2. 不变量

1. **durable authority 优先：** 恢复必须重读当前 authority；LLM 输出、UI cache、Guardian/Attention projection、`agent_sessions` 与 provider raw status 都不能仲裁状态。
2. **幂等：** 相同 persisted intent/idempotency/dedupe key 的重复 startup reconciliation 只返回既有 in-flight/terminal outcome，或收敛到同一可重新 claim 的状态；不得产生第二次未受控 provider/external effect。
3. **terminal 状态不回退：** terminal Work/Run/Attempt、Approval/Action、Automation run 与 Outbox delivery 不因启动扫描回到 runnable/pending。需要再次执行时创建新的 Run/Attempt/trigger，而不是改写旧终态。
4. **owner-only lost lease：** 只有拥有 claim/lease 的 carrier 可回收它；禁止“全局清理”跨表重置 status、cursor、approval 或 outbox。
5. **split-brain fail closed：** CAS revision/token、唯一 attempt/slot/idempotency key、persisted intent 与 receipt 是仲裁证据。冲突、未知 receipt、缺 fence 或缺当前 authority 时停止自动 dispatch，创建/保持 Attention 或走受审计 repair。
6. **权限与审计不降级：** 每个状态变更、provider/external call、retry、repair、dead-letter 都必须有 actor/reason/correlation/idempotency、deterministic gate 与 outcome。LLM 只能提议，不能将 `ask/deny` 变为 allow。

## 3. source of truth 与 carrier 规则

| carrier | source of truth / startup owner | lost lease 与 split-brain 仲裁 | terminal / repair action |
| --- | --- | --- | --- |
| Work | `issues` + `issue_events`；`recoverInProgressIssues` 仅处理 `in_progress` Issue | 未创建 provider session 的 claim 由既有 Issue status command 回到 `todo`；revision/status command 胜过 stale observer | terminal Issue 不在扫描范围，不能 reopen；检查 latest Run/Attempt，走既有 retry 或 needs-user，不创建第二个 Work |
| Run | `issue_runs` + `run_attempts` + `run.lifecycle.*` audit；`recoverInProgressIssues` | `expected_revision`、Attempt sequence、persisted intent/outcome 与 provider session/idempotency ref；无 session 只 requeue unstarted，transient 留给 PI/Guardian defer | terminal Run/Attempt 不回退；保留 audit 后按 recovery budget 做 retry、escalation 或 deterministic closeout |
| native Automation | `automation_definitions` + `automation_runs/events`；`runDueAutomations` | immediate SQLite transaction 先回收过期 token lease，再 materialize/claim；slot idempotency key + lease token CAS | `succeeded/skipped/failed` terminal；超过 retry 预算创建 Guardian Attention，cron misfire skip 不补跑 |
| Approval | provider `pi_approval_requests`；internal `pi_actions` + `pi_action_events` | exact subject/payload/policy/idempotency binding + deterministic gate；expired/revoked/mismatch 一律 fail closed | request/action terminal 不 reopen、不二次 dispatch；用既有 resolver/action ask/deny/retry 记录 repair |
| IM Reply Outbox | `sync_outbox(operation_kind=im_reply)` + approved `im_reply_drafts` | **W0 没有 durable sending lease/fence。** `sending` 不能因 restart 被盲目 reclaim；draft/policy preflight 与 Feishu receipt 才能证明结果 | `sent/failed` 不回退；ambiguous `sending` 必须查外部 receipt，再以原 correlation 写 deterministic repair，禁止 blind resend |
| Tracker Outbox | `sync_outbox(operation_kind=tracker_update)` + authorization `pi_actions/events` + adapter receipt | `dedupe_key`、external idempotency key、authorization action、sending cooldown lease 与 adapter receipt；expired `sending` 可按现有 claim path 重取 | `sent/failed` terminal；未知 receipt hold/Attention，不以 restart 推定未送达；原 key 下 retry/failed 都审计 |

**legacy boundary：** P08.03 的 native Automation 只拥有 `automation_*`；`cron_tasks`、`pi_automations`、delegation、heartbeat 与 completion watch 仍是各自 carrier 的唯一 authority。它们不得由本 ADR 迁移、双写或被 native scheduler 接管。

## 4. 启动 reconciliation 顺序

`main.ts` 的 `startAutoRunLoops()` 采用以下有限顺序：

1. 打开 SQLite/migrations 后，`recoverInProgressIssues()` 读取当前 `in_progress` Issue/Run；先持久化 Run lifecycle intent，再调用可恢复 provider，最后写 outcome/runtime ref。provider infrastructure transient 只 defer，不能伪造 failed/succeeded。
2. `sweepActivePiIssueCompletionWatches()` 只恢复观察；它不授权、dispatch 或改写 Work/Run。
3. 启动项目 loops 与唯一 schedule-layer timer。后续 cycle 让已接入该 cycle 的 owner 处理 due Automation、lease expiry、Guardian/Action、notification 与 watchdog；outbox 仍由各自既有 dispatcher 触发，**不能假设 restart 会自动重放所有 pending delivery**。不在 startup 另做跨域 bulk rewrite。
4. 每一步可重复。已 terminal 的 rows 被各自 query/CAS 排除；已有 intent、slot 或 dedupe key 必须返回既有事实。

进程内重复进入同一 startup phase 不增加 authority；跨进程 SQLite immediate transaction/CAS 是 durable arbitration。若外部 provider 或 delivery receipt 无法判定，必须停止自动副作用并升级 Attention/repair，不能依赖“旧进程应已死亡”的假设。

## 5. lost lease、split-brain 与 repair actions

| 情形 | 自动动作 | 禁止动作 | 审计/人工 repair |
| --- | --- | --- | --- |
| Issue claim 无 provider session | requeue unstarted claim | 将旧 compatibility thread 当新 session resume | `issue.recovery_requeued`，后续 project loop 正常 claim |
| Run 有 resumable provider session | persist intent → provider recovery → persist outcome | 无 intent 的重复 resume；terminal reopen | `run.lifecycle.intent/outcome`、`issue.recovery_*`；budget/Guardian 决定下一步 |
| native Automation lease 过期 | queued + bounded backoff，再 claim | 直接标 succeeded；补跑超 60 秒 cron misfire | `automation_run_events`；预算耗尽 Guardian Attention |
| Approval binding 过期/冲突 | ask/deny，保持未 dispatch | 从 notification/LLM 重建 grant；绕过 gate | provider resolver/action audit，明确 human decision 后才继续 |
| Tracker sending lease 过期 | 用同一 dedupe/idempotency key 重新 claim，receipt 不明则 hold | 换 key 重发或重置 sent/failed | outbox/action audit + Attention；查询 provider request ref |
| IM Reply `sending` 遗留 | fail closed，查询 Feishu receipt 后执行 deterministic repair | 自动把 `sending` 改 `pending/retry` 或盲目发送 | 记录 actor/reason/correlation、receipt/absence evidence、gate 与 outcome |

IM Reply Outbox 的 durable lease/fence 缺口不是可由本 ADR 偷加的旁路：在已有 schema/public carrier 上无法同时区分“send 前 crash”和“send 后未写 receipt”。它保持 fail-closed，直到后续专门 migration 提供 lease owner/fence、external receipt lookup、CAS outcome 和 kill/restart parity；该 migration 必须沿用同一 `sync_outbox` authority，不能建立第二 outbox。

## 6. Runbook

### 常规 restart

1. 保存启动前日志、DB path 和启动时间；不删除 state，不手改 terminal row。
2. 启动 runner；确认日志中没有 migration/recovery fatal error，并查看 `issue.recovery_*`、`run.lifecycle.*`、`automation_run_events`、`pi_action_events` 与 `sync_outbox` 的新增事实。
3. 对每个未终结的 object，先按上表找到 authority，再检查 latest intent/outcome、revision/token/dedupe/receipt；一次只修一个 carrier。
4. 只使用现有 retry、cancel、needs-user、approval/action 或 outbox repair command；外部写和 destructive repair 仍先通过 deterministic gate。

### split-brain / ambiguous external delivery

1. 停止同一 DB 的第二个 writer/dispatcher；不要靠 restart 抢占 `sending`。
2. 用 correlation、idempotency/dedupe、provider session/turn、adapter request/receipt 和 audit 确定外部事实。证据冲突时以 live provider/receipt → persisted authority → event audit 的顺序裁决。
3. 有 receipt：写同一 carrier 的 CAS terminal outcome；无 receipt：保持/标记 Attention，走 explicit approval 的 repair，而非重放。
4. 保存 repair 的 actor、reason、gate、correlation、before/after 与 evidence ref；恢复后重复执行一次 read-only reconciliation，确认没有新 external call。

### 验证

```bash
cd backend-ts
bun test src/runner/recovery.test.ts \
  src/runner/automationScheduler.test.ts \
  src/xuanwu/restartRecoverySemantics.test.ts \
  src/xuanwu/approvalSemantics.test.ts
```

定向测试覆盖 persistent DB reopen 的 Run restart、重复 reconciliation 的 unstarted claim 幂等、terminal 状态不回退、Automation lost lease/retry 和 Approval idempotency。IM Reply 的 ambiguous `sending` 只能 fail closed；没有 receipt lookup/fence 前不得声称其自动 kill/restart E2E 已覆盖。

## 7. 兼容、双读/双写、回滚与最终删除门禁

- **W0 source of truth：** 上表 current carrier 均为 sole writer；本 ADR 只冻结语义与 runbook，**双读=0、双写=0**。
- **未来 W1/W2：** 若统一任一 carrier，必须先在同一 deterministic command 收敛 writer；W1 shadow write 至多一个正式 release，W2 primary-read comparison/fallback 至多一个正式 release，合计最多两个连续正式 release。shadow failure 不可改变 legacy result 或触发外部写。
- **回滚：** G4 前关闭新增 projection/selector 即回现 authority；G4 后先停止 target writer，按 audited correlation/idempotency delta 回放，并证明同一 object 只有一个 writer 后才恢复 retained compatibility path。不得重置 terminal state 或抹除 intent/outcome/receipt。
- **最终删除门禁：** 仅 P11/G7；所有 active/in-flight claim、pending approval、undelivered outbox 和 ambiguous receipt 均为 0；一个 release consumer-zero；restart/retry/dedupe/receipt parity、fresh backup、isolated restore、retained rollback artifact 与精确 non-LLM destructive approval 全部通过。否则保留旧 carrier，不建立第三路径。
