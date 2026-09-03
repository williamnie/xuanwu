# ADR-XW-0024：Run list / detail / control HTTP API

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.05 / Runner #660
- 依赖：[ADR-XW-0021](0021-run-attempt-relations.md)、[ADR-XW-0023](0023-run-lifecycle-command-service.md)
- 可执行实现：`backend-ts/src/http/runApi.ts`、`backend-ts/src/db/repositories/runs.ts`

## 1. API 边界

Run API 在现有 Issue / Session / provider runtime 上提供统一查询和控制入口，不建立第二套 Run 表或状态机：

| method | path | contract |
| --- | --- | --- |
| `GET` | `/api/runs` | 按 `work_id`、`project_id`、`provider`、`status` 查询；`page_size` 最大 100 |
| `GET` | `/api/runs/:id` | 返回 Run、全部 Attempt、确定性 progress 与 logs/evidence/audit drill-down links |
| `GET` | `/api/runs/:id/transcript` | 按 Attempt 有界返回已落库的用户可见 Agent 文案，补充 provider summary 省略的 commentary；不读取完整 Session payload |
| `POST` | `/api/runs/:id/actions/:action` | `interrupt|resume|retry`；所有动作经过 P03.04 command service |

列表在 repository SQL 中完成 filter、count、order、limit/offset，不把全量 Runs 载入内存后分页。Run ID 和 Work ID 必须分别是 `xw:run:issue_runs:*` 与 `xw:work:issues:<positive id>`；未知 legacy lifecycle 值返回 `status=null + mapping_errors[]`，不能猜成成功或失败。

detail 内嵌按 sequence 排序的 Attempts。`progress` 只投影 authoritative Run status、最新 Attempt status/revision/timestamp，不从 LLM 文本或 Session preview 猜完成百分比。logs/evidence links 指向现有 Issue events/event summaries；provider Session link 仅用于 observation / drill-down。

## 2. 控制请求与权限

live server 的 `/api/*` bearer/cookie auth 是外层访问门禁。每个 control body 还必须携带：

- `audit.actor{id,kind}`、`event_id`、`correlation_id`、`occurred_at`、`reason`；
- `expected_revision`；Attempt 动作还需 `expected_attempt_revision`；
- `resume` 额外需要非空 `prompt`。

HTTP adapter 不接受调用方传入 gate。通过认证和 schema 校验后，它固定生成 `deterministic_policy/allow/xuanwu-run-http-authenticated-control-v1` gate；`actor.kind` 只允许 core domain actor，`llm` 等自声明 authority 在写 audit 前被拒绝。LLM 输出只能成为上游 proposal，不能直接成为本 API 的权限证明或 provider outcome。

`resume` 与 `interrupt` 继续使用 intent → provider side effect → outcome 三阶段协议。provider capability/session/turn precondition 不满足时 fail closed；provider 错误写入 outcome 前先经过敏感信息脱敏。相同 event ID 与相同 command 重放不重复调用 provider；相同 event ID 绑定不同 command 返回 409。

## 3. retry / resume / interrupt 语义

- terminal Run 的 `retry` 请求新 Run，`trigger=retry`；下一次 claim 才 materialize 新 `issue_runs` row。
- active Run 已有 `interrupted` 最新 Attempt 时，HTTP `retry` 明确提交 `supersede` operation；没有先中断的 active Run 返回 precondition conflict。
- `resume` 只在同一非终态 Run、同 provider/session、上一 Attempt 已 succeeded 时建立 `kind=resume` Attempt。
- `interrupt` 只针对最新 running Attempt，并校验 Run/Attempt revision 与 provider/session/turn refs；成功只关闭 Attempt，不擅自关闭 Run。

SQLite immediate transaction 串行化 revision check、mutation 与 audit append。并发请求中只有 fresh revision 可以应用；stale request 返回 409，并保留 rejected retry audit。intent 已落盘但 outcome 未知时重放返回 202 pending，不二次执行外部调用。

## 4. source of truth、兼容与回滚

| window | authority / 读写 |
| --- | --- |
| W1（当前） | `issue_runs` 是 Run lifecycle read/write authority；`run_attempts` 是 child facts；`issue_events/run.lifecycle.*.v1` 是 audit/revision projection |
| W2（最多一个正式 release） | unified Run projection primary，legacy Issue/Sessions projection comparison/fallback；任一 parity drift 立即回到 W1 |
| W3 | control 只经 Run domain command；Sessions 只保留 observation/drill-down |

- **双写窗口为 0：** API 不写 shadow Run 表；Attempt 与 lifecycle event 都锚定同一 `issue_runs.run_id`。
- **双读期限：** 仅 W2、最多一个正式 release；当前 API 明确输出 compatibility policy。
- **代码回滚：** 从 read route registry 注销 Run routes，恢复 legacy Issue/Session control；不迁移、不删除 authority 数据。
- **数据回滚：** 不删除 `run_attempts` 或 lifecycle audit；按 `issue_runs` 继续服务并保留 child facts 待排障。
- **最终删除门禁：** P11.05、G7、一个 W2 parity release、pending-intent runbook、备份/恢复演练、Sessions consumer 清零和旧 route contract 留档全部通过后，才允许退役 legacy control/UI；`issue_runs` authority 的退役仍需 superseding ADR。

## 5. 最小验证

```bash
cd backend-ts
bun test src/http/runApi.test.ts src/http/readApiContract.test.ts
```

测试覆盖 HTTP route contract、Bearer 权限、非法 actor fail-closed、125 条 Run 的分页/过滤、detail Attempts/progress/links、interrupt/resume 幂等，以及 retry/resume stale revision 并发冲突。
