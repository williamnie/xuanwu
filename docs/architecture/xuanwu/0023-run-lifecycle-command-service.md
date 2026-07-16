# ADR-XW-0023：Run retry / resume / interrupt / supersede command service

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.04 / Runner #659
- 依赖：[ADR-XW-0020](0020-run-attempt-lifecycle-contract.md)、[ADR-XW-0021](0021-run-attempt-relations.md)、[ADR-XW-0022](0022-provider-run-event-contract.md)
- 可执行实现：`backend-ts/src/domain/run/service.ts`

## 1. 决策与边界

P03.04 在既有 Issue/Session/Guardian/PI 路径上增加一个内部 Run lifecycle command service，不新增第二套 Run authority、公开 HTTP schema、共享状态词表或 provider adapter：

- `issue_runs` 继续是唯一 Run lifecycle authority；其 legacy `status/ended_at/exit_reason` 仍决定 Run 是否终态。
- `run_attempts` 只保存 Run 内 provider invocation child facts；它不能反向拥有 Work 或独立关闭 Run。
- `issue_events` 的 `run.lifecycle.*.v1` 事件保存 command intent、幂等指纹、precondition revision、gate、actor、provider refs 和 outcome。它们是 append-only audit / semantic projection，不是 shadow Run table。
- `agent_sessions` 继续是 observation / drill-down，不从 session status 或模型文本推断 Run terminal 状态。
- 本期不增加 `/api/runs/*`。现有 Issue retry、Issue-linked interrupt、runner restart recovery 与 PI `session.resume_followup` 通过内部 service 接线；独立手工 Session 不属于 Work Run，不创建伪造 Attempt。

## 2. identity 语义

| command | identity / precondition | 结果 |
| --- | --- | --- |
| `retry` | 目标 `issue_runs` 已终态，`expected_revision` 匹配 | Issue 回到 `todo`；下一次 claim 建立新 Run，`trigger=retry` |
| `supersede` | 目标 Run 非终态，当前 Attempt 已确定性 `interrupted` | 旧 Run 原子收口为 `cancelled`；Issue 回到 `todo`；下一次 claim 建立新 Run，`trigger=supersede` |
| `resume` | 同一非终态 Run、同 provider/session，上一 Attempt 已成功 | 同 Run 新建 `kind=resume` Attempt |
| `recovery` | 同一非终态 Run、同 provider/session，上一 Attempt failed/interrupted | 同 Run 新建 `kind=recovery` Attempt |
| `interrupt` | 最新 Attempt 为 running，provider/session/turn 与 revision 匹配 | provider interrupt 成功后 Attempt 收口为 `interrupted`；Run 是否取消由后续 cancel/supersede intent 决定 |

`retry` 不再被用作“强制关闭仍在运行的 Run”的别名。现有 active Issue retry 先执行 Issue-linked interrupt，成功后按 `supersede` 处理；provider interrupt 不可用、超时或失败时 fail closed，旧 Run 不重新排队。

新 Run request 保存 `requested_sequence` 与 `supersedes_run_id`。`createIssueRun()` 在 claim transaction 内消费唯一 pending request，并追加 `run.lifecycle.run_materialized.v1`，其中保存新 `run_id`、`trigger` 和 superseded Run；重复 claim/materialize 不会生成第二条事实。

## 3. command、幂等与 revision

每个 mutation command 必须携带：

- stable `event_id` / correlation ID；
- Run canonical ID 与 legacy `issue_run_id`；
- `expected_revision`，Attempt mutation 还包含 `expected_attempt_revision`；
- actor、reason、timestamp；
- `deterministic_policy|human_approval` gate。`deny|ask` 不执行 mutation。

Run revision 由同一 Run 的 applied `run.lifecycle.*.v1` audit events 的 `after_revision` 确定性投影。Attempt revision 使用 `run_attempts.revision`，因此 P03.03 的 cost Evidence 后到也会让过期 control command 冲突，而不是覆盖新状态。

同一 `event_id + request fingerprint` 重放返回原 outcome，不重复写状态或调用 provider；同一 event ID 绑定不同指纹时抛出 conflict。SQLite `immediate` transaction 串行化检查、mutation 与 audit append，retry/interrupt 并发只能有一个 command 通过 revision precondition。

## 4. provider 副作用协议

resume、recovery 与 interrupt 使用三阶段协议：

1. `run.lifecycle.intent.v1` 与 Attempt prepare 在 transaction 内先落盘；
2. transaction 提交后才调用 provider；
3. 成功或失败追加 `run.lifecycle.outcome.v1`，并在同一 transaction 更新 provider refs / Attempt terminal。

如果进程在 intent 与 outcome 之间退出，重启后的相同 command 返回 `should_invoke=false, completed=false`，不会猜测 provider 是否已执行，也不会二次调用。Runner/PI 将其作为 pending recovery Evidence 交给后续 observation 或人工处置。

provider 成功后，同一个 Attempt 保存：

- `provider_invocation_ref`；
- `provider_session_id`；
- `provider_turn_id`；
- 精确存在时的 `agent_session_key`。

同 Session 新建 resume/recovery Attempt 时，intent 同时快照上一 Attempt 的 cost 与 revision，形成不可变 `provider_usage_baseline`。P03.03 的 `usage_scope=provider_session_total` Evidence 进入后续 Attempt 时，`runAttemptEvents.ts` 只投影 `current total - audited baseline`；baseline 缺失、计数倒退或字段不完整时对应值保持 `null/unavailable`，不会把 Session 累计 token 重复计入 Run。

provider 在返回 refs 前失败时，Attempt 以 lifecycle intent ref 作为本地 invocation anchor 收口为 failed；该 ref 不伪装成 provider session/turn。

## 5. 当前接线路径

- Issue retry：`issueActions.ts` 通过 `requestNewRun()` 区分 terminal retry 与 interrupted supersede。
- claim：`issueRuns.ts#createIssueRun()` 消费 pending new Run request 并写 materialization audit。
- Issue/Session interrupt：`runner/interrupt.ts` 在 provider interrupt 前后写 intent/outcome，并只关闭当前 Attempt。
- runner restart：`runner/recovery.ts` 创建 recovery Attempt；发现仅有 intent 的 pending Attempt 时 fail closed，不重发 provider call。
- Guardian/PI resume：`piSupervisorActionDispatch.ts` 复用既有 `pi_recovery_attempts` 去重和 freshness gate，再创建 resume Attempt；两层 idempotency 使用同一稳定 PI action identity。

`POST /api/sessions/:id/messages` 的独立手工 Session 兼容路径保持不变。只有具备 Issue/Run freshness、PI recovery Attempt 与 deterministic gate 的 `session.resume_followup` 被解释为 Run resume；这避免把普通聊天 turn 平行复制成 Work Run。

## 6. source of truth、兼容期限与回滚

| window | authority / 读写 |
| --- | --- |
| W1（当前） | `issue_runs` legacy lifecycle primary；`run_attempts` 与 lifecycle audit events 是同一 authority 的 child/projection |
| W2（最多一个正式 release） | unified projection 可 primary；legacy projection comparison/fallback，任一 parity drift 立即回到 W1 |
| W3 | 所有 Run control 只能经过 domain command；Session 只保留 observation/drill-down |

- **双写窗口为 0：** service 不写第二张 Run 表；Attempt 与 audit event 均引用同一 `issue_runs.run_id`。
- **双读期限：** 仅 W2，一个正式 release。`issue_runs`、Attempt/audit projection 不一致时，legacy lifecycle 优先并追加 drift Evidence。
- **代码回滚：** 撤回 P03.04 service hooks，恢复 legacy Issue retry/recovery/interrupt handler；已写的 `run.lifecycle.*.v1` 与 Attempt rows保留为审计，不删除、不反写 provider。
- **数据回滚：** 本期无 schema migration。禁止为回滚删除 lifecycle events 或 rebuild `issue_runs/run_attempts`；必要时停用 unified consumer 后按 `issue_runs` 继续服务。
- **最终删除门禁：** 至少完成 P11.05、G7、一个 W2 parity release、pending intent runbook、备份/恢复演练、Sessions consumer 清零与旧 route contract 留档后，才可删除 legacy control path。`issue_runs` authority 的退役仍需新的 superseding ADR。

## 7. 审计与权限

所有执行态 mutation 和 provider 外部调用都关联 intent/outcome event。LLM 输出只能提出 proposal；不能充当 gate authority、生成 observed provider outcome、绕过 revision precondition，或直接执行 retry/resume/interrupt/supersede。

最小验证：

```bash
cd backend-ts
bun test src/domain/run/service.test.ts \
  src/runner/interrupt.test.ts \
  src/runner/recovery.test.ts \
  src/http/piSupervisorResumeIdempotency.test.ts
```

测试覆盖重复 command 幂等、provider refs、retry/interrupt 竞态、pending intent 重启 fail-closed 与重启后继续同一 Session。
