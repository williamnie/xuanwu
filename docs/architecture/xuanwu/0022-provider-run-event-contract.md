# ADR-XW-0022：Codex / Claude provider Run event contract

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.03 / Runner #658
- 依赖：[ADR-XW-0020](0020-run-attempt-lifecycle-contract.md)、[ADR-XW-0021](0021-run-attempt-relations.md)
- contract：`backend-ts/src/providers/types.ts` 的 `NormalizedRunEvent`

## 1. source of truth 与边界

`NormalizedRunEvent(contract=xw.run-event.v1)` 是 Codex 与 Claude provider 生命周期 Evidence 的 canonical contract。provider wire payload 仍保存在 `ProviderEvent.raw`，旧 `type/status/text/...` 字段继续作为兼容 projection；新消费者不得再直接按 Codex RPC method 或 Claude stream-json record 推断 Run outcome。

本期只统一 provider Evidence，并把带 provenance 的 cost snapshot 投影到当前 `run_attempts.cost_json`。`issue_runs` 仍是唯一 Run lifecycle authority：normalized event、`agent_sessions.status`、LLM 文本和 provider terminal 声明都不能直接关闭 Run、执行 retry/resume/interrupt/supersede，P03.04 仍须经过确定性/人工 gate 与独立审计 command。

## 2. canonical event

每个 normalized event 包含：

- `kind`：`started|progress|approval_requested|approval_resolved|error|completed|unknown`；
- `outcome`：`running|waiting_approval|succeeded|failed|cancelled|interrupted|unknown`；
- `terminal`、`retryable`、provider 与稳定 `source.method/ref`；
- `metadata`：session/turn、model、provider version、duration、usage scope 等 provider facts；
- 可选 `cost`：复用 ADR-XW-0020 的 `RunCost`，不得用未知值补零。

`completed` 只表示成功完成，并统一映射到 `outcome=succeeded, terminal=true`。provider result/turn 的失败、取消或中断统一归入 `error`，分别映射 `failed|cancelled|interrupted`。进程启动失败、timeout 等没有 wire terminal event 的异常，由 `providerRuntime` 生成受脱敏的 `provider/run_error` Evidence。

## 3. provider conformance

| lifecycle | Codex | Claude | normalized |
| --- | --- | --- | --- |
| start | `turn/start` / `turn/started` | child process `start` | `started/running` |
| progress | `item/*`、turn/thread updates | `system.init`、assistant/user/tool records | `progress/running` |
| approval request | approval broker request | 当前 execution-only adapter 不暴露 approval capability | `approval_requested/waiting_approval` |
| approval result | broker resolved / fast-resolved | 当前不适用 | `approval_resolved/running` |
| provider error | `error`、protocol/process error、失败 completion | error/result error、truncation、process failure | `error/<terminal outcome>` |
| success | `turn/completed(status=completed)` | `result(is_error=false)` | `completed/succeeded` |

Claude adapter 不得伪造不具备的 approval/session-resume capability；缺少的生命周期阶段由 capability conformance 表达，不用 Codex 风格事件占位。

## 4. unknown event policy

未知 method/record 必须：

1. 保留已脱敏 raw Evidence 和 bounded legacy summary；
2. 生成 `kind=unknown, outcome=unknown, terminal=false, unknown.policy=preserve`；
3. 不抛异常、不更新 cost、不改变 Session/Attempt/Run terminal status，也不触发外部操作。

只有后续带版本的 adapter 代码与 fixture contract test 可以把 unknown 升级为已知事件；不能按字段名猜测终态。

## 5. provider metadata 与 cost usage

- Codex token usage 使用 `thread/tokenUsage/updated.tokenUsage.total`，标记 `usage_scope=provider_session_total`；当前 initial Run 为新 thread，P03.04 在同 Session 新建后续 Attempt 时必须先定义可审计 baseline/delta，不能把 Session 累计值直接当恢复 Attempt 增量。
- Claude `result.usage` 标记 `usage_scope=attempt`；未提供的 reasoning token 保持 `null`，所以 usage 为 `partial`。`total_cost_usd` 转为整数 USD micros 并标记 `provider_reported`。
- `run_attempts.cost_json.source_refs` 同时保存 provider event ref 与实际 `issue_events:<id>`，使投影可回放、可审计。未知或不完整数字被降级为 `null + partial|unavailable`，不导致 runtime 崩溃。
- provider metadata 随 `run_event` 持久化在 `issue.log`；通用 provider/session/turn refs 仍由既有 `issue_runs` / `agent_sessions` compatibility path 保存。

## 6. 兼容、回滚与删除门禁

- **W1（当前）：** normalized `run_event` 与 Attempt cost additive 写入；legacy `ProviderEvent` 字段和 `issue_runs` read/write 保持 primary。
- **W2（最多一个正式 release）：** normalized consumer primary，legacy 字段仅 comparison/fallback；任何 fixture/parity drift 立即回滚消费者。
- **双写期限：** lifecycle authority 双写为 0；这里只持久化同一 provider Evidence 的 legacy + normalized 两个 representation，Attempt cost 是可由 `issue_events` 重建的 child fact。
- **回滚：** 停止消费/写入 `run_event` 和 cost projection，恢复旧 provider fields；保留既有 `issue.log` 与 additive `run_attempts`，不得为回滚删除 authority 数据。
- **删除门禁：** 仅 P11.05 在 W2 parity、G7、一个正式 release 观察窗、备份/恢复演练和所有 legacy consumer 清零后，才可删除旧 provider lifecycle fields/parsers。

## 7. 验证

最小门禁：

```bash
bun test \
  backend-ts/src/providers/runEvents.test.ts \
  backend-ts/src/providers/codex/events.test.ts \
  backend-ts/src/providers/codex/approvalBroker.test.ts \
  backend-ts/src/providers/claude/stream.test.ts \
  backend-ts/src/runner/providerRuntime.test.ts
```

fixture tests 必须证明两个 provider 的成功完成都映射为 `completed/succeeded`、unknown 不崩溃且不改变 authority、approval 映射一致，并验证 token/money/provenance 投影。
