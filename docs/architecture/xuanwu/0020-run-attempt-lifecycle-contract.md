# ADR-XW-0020：Run / Attempt 生命周期合同

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.01 / Runner #656
- 依赖：[ADR-XW-0004](0004-core-domain-objects.md)、[ADR-XW-0011](0011-work-ledger-domain-contract.md)、[Xuanwu migration plan](../xuanwu-migration/README.md)
- 可执行合同：`backend-ts/src/domain/run/contracts.ts`
- canonical 级别：本文是 Run / Attempt identity、生命周期、provider refs、terminal rules 和 cost fields 的 source of truth；ADR-XW-0004 仍是跨核心对象 ID 与共享 Run 状态词表的 source of truth

## 1. 决策边界

本期只把现有 `issue_runs`、provider runtime、`agent_sessions` 和恢复事实归一成可执行的领域合同，不提前实现 P03.02–P03.07：

- 不新增或修改 table、migration、repository、HTTP API、provider adapter、共享状态机或 UI。
- `contracts.ts` 直接复用 P00.04 的 `RunID`、`RunStatus`、`RUN_STATUSES` 与 `STATE_TRANSITIONS.run`；Attempt 仅作为 Run 的内部执行子对象，不扩充 core object kind。
- **`issue_runs` 是唯一 Run authority**。`agent_sessions` 与 provider session 只提供 observation / drill-down；它们的 status、缓存或 raw payload 不能创建、关闭或重新拥有 Run。
- `pi_recovery_attempts` 是恢复 gate、预算和副作用审计 authority。只有真实发生一次 provider 调用时，才投影为 Run 下的 Attempt；被 deny、去重或在调用前失败的 recovery proposal 不是 Attempt。
- `issues.attempt_count` 与 `issue_runs.attempt` 当前表达 claim / Run 序号，不再解释为 provider Attempt 数。

## 2. Run / Attempt identity 与 Work relation

### 2.1 Run

Run 表达“针对一个 Work，由一次受审计触发开始、最终产生一个终态结果的执行生命周期”：

| 字段 | 合同 |
| --- | --- |
| `id` | `xw:run:issue_runs:<issue_runs.id>`；迁移前后都由 `issue_runs` authority 生成 |
| `work_id` | 唯一 Work owner；一个 Work 可有多个按 `sequence` 排序的 Run |
| `sequence` | 同一 Work 下从 1 开始的 Run 序号；当前由 `issue_runs.attempt` 投影 |
| `trigger` | `initial \| retry \| supersede` |
| `provider` | 本 Run 选择的 provider；provider 切换必须创建新的 superseding Run |
| `revision` | 非负 optimistic revision；P03.04 mutation command 必须携带 `expected_revision` |
| `cost` | 所有 Attempt cost 的确定性聚合，不是模型生成的估算摘要 |

`RunWorkRelation(kind=executes)` 与 Run 同时建立，保存 actor、reason、correlation、timestamp 和 `audit_event_ref`。关系创建后不可静默改 owner；Work 被拆分、合并或 supersede 时必须创建新的 Run 或通过后续受审计迁移处理。

`trigger=retry|supersede` 必须保存 `supersedes_run_id`。`retry` 只能针对已有终态 Run；`supersede` 先把旧 Run 以 `cancelled + terminal.reason=superseded_by:<new RunID>` 收口，再建立新 Run。P03.04 负责事务、幂等和竞态实现，本期只固定前置条件。

### 2.2 Attempt

Attempt 表达 Run 内一次真实 provider invocation：

```text
AttemptID = <RunID>~attempt:<positive sequence>
```

- 每个 Run 的 Attempt sequence 从 1 连续递增；第一个 `kind=initial`，后续只能是 `resume|recovery`。
- `resume` 是同一 Run 目标尚未终结时，在同一 provider session 上继续一个新 turn。
- `recovery` 是进程重启、transport 断开或 watchdog 决策后，对同一非终态 Run 进行的恢复调用。
- provider invocation、session、turn 都是 Attempt refs，不是 Run ID。provider ref 后到时更新同一 Attempt，不能因临时 CLI ref 与最终 session UUID 不同而创建两个 Attempt。
- Attempt 成功不必立即终结 Run：Runner 仍可等待确定性 closeout、验证或一个受审计的 resume Attempt；但 Run 终态必须满足第 4 节 terminal rules。

### 2.3 控制动作归属

| 动作 | identity 结果 |
| --- | --- |
| 首次 claim/执行 | 新 Run + `initial` Attempt |
| 同一目标继续 session | 同一 Run + `resume` Attempt |
| 非终态 Run 重启恢复 | 同一 Run + `recovery` Attempt |
| 终态失败后 retry | 新 Run，`trigger=retry` |
| 改 provider、目标边界或替代旧执行 | 新 Run，`trigger=supersede` |
| interrupt | 关闭当前 Attempt 为 `interrupted`；只有 cancel/supersede intent 才把 Run 关闭为 `cancelled` |

## 3. 状态机

### 3.1 Run 状态

Run 直接复用 P00.04 `STATE_TRANSITIONS.run`：

| from | allowed to |
| --- | --- |
| `created` | `running`, `cancelled` |
| `running` | `recovering`, `succeeded`, `failed`, `cancelled` |
| `recovering` | `running`, `succeeded`, `failed`, `cancelled` |
| `succeeded` | 无 |
| `failed` | 无 |
| `cancelled` | 无 |

当前 `issue_runs.status` 仍保存 legacy Issue-style 值。读 projection 使用固定映射：

| legacy `issue_runs.status` | Run status |
| --- | --- |
| `in_progress` | `running` |
| `pending_verification`, `done` | `succeeded` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

未知值 fail closed 并形成 drift Evidence；不得让 LLM 猜状态。`recovering` 在 P03.02/P03.04 接线前由恢复事实投影，不能反向覆盖 legacy row。

### 3.2 Attempt 状态

| from | allowed to |
| --- | --- |
| `created` | `running`, `failed`, `cancelled` |
| `running` | `succeeded`, `failed`, `interrupted` |
| `succeeded` | 无 |
| `failed` | 无 |
| `cancelled` | 无 |
| `interrupted` | 无 |

Attempt 没有 `recovering`：恢复总是关闭旧 Attempt，并新建 `kind=recovery` 的 Attempt。provider 没有产生 session/turn 之前失败，也必须以受审计的 `created -> failed` 收口。

## 4. terminal rules

`validateRunLifecycle()` 与两个 transition evaluator 固定以下不变量：

1. Run 与 Attempt 的 terminal status 都必须同时具有 `ended_at` 和 `terminal{reason,source_ref}`；非终态不得携带这些字段。
2. `succeeded|failed|cancelled` Run 不得包含 live Attempt，且 terminal Run 不允许再转移。
3. `succeeded` Run 的最新 Attempt 必须为 `succeeded`；`failed` Run 的最新 Attempt 必须为 `failed`。
4. `cancelled` Run 可以在 provider 启动前没有 Attempt；一旦有 Attempt，所有 Attempt 都必须先收口。
5. `recovering` Run 的最新事实只能是 `failed|interrupted` Attempt，或一个尚未启动的 `kind=recovery` Attempt。
6. Attempt sequence 唯一且连续；只有最新 Attempt 可转移。terminal Attempt 不能 reopen，后续工作创建新 Attempt 或新 Run。
7. Run `cost` 必须等于 Attempt cost 的纯函数聚合；任何缓存、UI 或 LLM summary 不得覆盖原始 provider/pricing refs。

状态与 Attempt terminal 写入必须在 P03.04 的同一 transaction 中完成。中间态若会违反上述不变量，不得单独对外可见。

## 5. Codex / Claude provider refs

`ProviderAttemptRef` 保存四类 opaque ref：

| 字段 | 语义 |
| --- | --- |
| `provider` | `codex`、`claude` 或已注册 executor id |
| `invocation_ref` | 本次 provider call 返回/生成的 run ref |
| `session_ref` | provider 长生命周期 session/thread |
| `turn_ref` | 本次调用对应的 turn/result UUID |
| `observation_ref` | `agent_sessions.session_key`，仅用于下钻 |

### Codex 样例

```json
{
  "provider": "codex",
  "invocation_ref": "codex:thread-656:turn-1",
  "session_ref": "thread-656",
  "turn_ref": "turn-1",
  "observation_ref": "codex:thread-656"
}
```

- `thread/start|thread/resume` 取得 `session_ref`，`turn/start` 取得 `turn_ref`。
- `turn/interrupt` 成功只证明 Attempt 被中断；Run 是否 cancelled 由调用 intent 和 deterministic command 决定。
- 同一 thread 的后续 turn 是新的 `resume|recovery` Attempt，不是新 Run，除非显式 retry/supersede command 建立了新 Run。

### Claude 样例

```json
{
  "provider": "claude",
  "invocation_ref": "cli:claude:656",
  "session_ref": "session-656",
  "turn_ref": "result-uuid-1",
  "observation_ref": "claude:session-656"
}
```

- child process 启动时只有临时 `cli:claude:<issue>` ref；stream `system.init.session_id` 与最终 `result.uuid` 到达后补齐同一 Attempt。
- 当前 Claude provider 不支持 session resume；capability 不满足时 recovery command fail closed，不得伪造一个 Codex 风格 thread。
- 当前 invocation ref 不保证跨 Run 全局唯一，因此 authoritative identity 始终是 AttemptID；P03.03 可增加稳定 provider metadata，但不能反向改 Run ID。

`agent_sessions.status` 与 provider raw status 只用于 live observation。冲突排查顺序保持：live runtime → `issue_runs` → provider event → `agent_sessions` → cached UI，并把冲突记录为 Evidence。

## 6. cost fields

Attempt 和 Run 均使用相同结构：

- usage：`input_tokens`、`cached_input_tokens`、`output_tokens`、`reasoning_output_tokens`、`total_tokens`，每项为非负整数或 `null`；`completeness=unavailable|partial|complete`。
- money：`amount_micros` 使用整数避免浮点漂移；`currency` 使用明确币种；`basis=provider_reported|pricing_derived|unavailable`。
- provenance：`source_refs[]` 指向 provider usage/event；定价推导还必须有 `pricing_refs[]`。

`cached_input_tokens` 是 input 子集，`reasoning_output_tokens` 是 output 子集；`total_tokens=input_tokens+output_tokens`，不能把两个子集重复相加。缺失数据保存 `null + unavailable|partial`，不能把未知成本写成零。不同币种、缺少任一 Attempt amount 或缺失 pricing ref 时，不生成 monetary aggregate。

P03.03 才负责从 Codex/Claude normalized events 写入 usage；P10.10/P10.06 负责长期成本观测和敏感字段治理。本期不从历史 log 猜补金额。

## 7. 审计与权限

Run/Attempt transition command 必须包含 object ID、`expected_revision`、actor、reason、correlation ID、event ID、timestamp 与 gate：

- gate authority 只能是 `deterministic_policy|human_approval`；`deny|ask` 不执行 mutation。
- LLM 只能提出 lifecycle transition proposal；LLM 不能把自身声明成 gate authority，不能声称 provider 已终止，也不能执行 retry/resume/interrupt/supersede 外部副作用。
- provider call、interrupt、session resume 与 destructive cleanup 必须先持久化 intent/idempotency anchor，再执行副作用，最后写 outcome；崩溃恢复不得重复调用。
- `agent_sessions` upsert、provider event 或模型文本均不能直接更新 Run terminal status。

## 8. source of truth、兼容期限、回滚与删除门禁

本合同遵循 ADR-XW-0006 的 Run stream：

| window | authority / 读写 |
| --- | --- |
| W0（本期） | `issue_runs` legacy row 唯一读写；Run/Attempt 仅为内存合同与文档 |
| W1（P03.02/P03.03） | additive relation/Attempt/event 字段可回填；读取仍为 legacy，所有 Run 状态 mutation 仍写同一 `issue_runs` authority |
| W2（最多一个正式 release） | unified projection primary，legacy projection 只做 comparison/fallback；写仍通过同一 domain command 和 `issue_runs` authority |
| W3 | unified projection only；Sessions route 只能翻译/下钻，不能另写 Run 状态 |

- **双写窗口为 0**：Attempt child facts、provider refs 与同事务 audit event 不是第二套 Run authority；禁止把 `agent_sessions` 当 shadow Run table。
- **双读期限：** 仅 W2，一个正式 release window；失败立即恢复 legacy projection，并记录 parity mismatch。
- **回滚：** 禁用 unified Run read/control flag，恢复 legacy lifecycle projection 与 Sessions view；保留 additive relation/Attempt 字段但停止消费。Run 可由 `issue_runs`、provider events 和 recovery audit 重建，不能由 LLM summary 重建。
- **最终删除门禁：** P11.05、G7、Sessions consumer 为零、旧 route/API contract 已留档、备份/恢复演练和观察窗通过后，才能退役 Sessions 用户入口。`issue_runs` 继续保留；除非未来 superseding ADR 另行给出 authority、备份和迁移证据，不得删除。

本期回滚只需删除 `contracts.ts`、定向测试、本文及 provider sessions 文档链接；没有 schema、数据或外部状态需要恢复。

## 9. 验证合同

最小门禁：

```bash
bun test backend-ts/src/domain/run/contracts.test.ts
cd backend-ts && bunx --package typescript tsc --noEmit --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022 \
  --types bun --allowImportingTsExtensions \
  src/domain/run/contracts.ts src/domain/run/contracts.test.ts
```

测试必须证明：

- Run 状态表复用 P00.04，Run/Attempt transition evaluator 为纯函数并 fail closed；
- initial/resume/recovery Attempt 与 retry/supersede Run identity 不混淆；
- Codex thread/turn 与 Claude session/result UUID 映射到同一 provider ref 合同；
- terminal status、timestamps、terminal record、latest Attempt 和不可 reopen 不变量成立；
- cost 对 token 子集、unknown、金额整数、pricing/source refs 与 Attempt 聚合执行确定性校验；
- canonical 文档持续声明唯一 authority、0 双写、1 个 release 双读、回滚和 P11.05 删除门禁。
