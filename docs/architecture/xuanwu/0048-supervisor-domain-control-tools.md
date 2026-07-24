# ADR-XW-0048：Supervisor Work / Run / Evidence / Handoff 控制工具

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.06 / Runner #685
- 硬依赖：XW P02.06 / #652、P03.05 / #660、P04.09 / #671、P05.08 / #679（均为 `done`）
- 可执行实现：`backend-ts/src/pi/supervisorControlTools.ts`
- Registry contract：`backend-ts/src/pi/supervisorControlContracts.ts`、`backend-ts/src/pi/builtinToolRegistry.ts`

## 1. 决策

Supervisor runtime 注册以下确定性 domain tools：

| domain | read | write / control | registry permission |
| --- | --- | --- | --- |
| Work | `work_list`、`work_read` | `work_create`、`work_update`、`work_control` | read / write / dangerous |
| Run | `run_list`、`run_read` | `run_control` | read / dangerous |
| Evidence | `evidence_list`、`evidence_read` | 不开放；Evidence terminal record 不可由 Supervisor 改写 | read |
| Handoff | `handoff_list`、`handoff_read` | 不开放；交付 producer/provider/outbox 仍拥有写路径 | read |

工具不是第二套业务 API。每次调用都复用 P02/P03/P04/P05 已验证的本地 HTTP adapter，再由其进入当前
repository、command service、provider precondition、compatibility projection 与 delivery refresh。工具闭包内的
local Router 不监听端口，也没有绕过 Action Gate 的公开入口。

## 2. 权限、风险与审计

- SDK pre-tool hook 只按 registry `read | write | dangerous`、精确 target/scope、授权 envelope 和 Action Gate fail closed；自然语言本身不在 LLM 前被分类，也不能授权；
- handler 再把 domain action 转成 `work.* | run.* | evidence.* | handoff.*` action envelope，经过既有 PI Action Gate 的
  action allowlist、project scope、delegation/authorization envelope 和 risk classification；
- Work/Run mutation 只有 Action Gate 返回 `execute` 后才组装 domain audit。`actor.kind` 固定为 `supervisor`，domain gate
  仍由 authenticated adapter 固定为 `deterministic_policy/allow`；tool schema 不接受 `gate`，LLM 不能声明权限；
- `work_control`、`run_control` 在 registry 粗粒度标为 `dangerous/high`；`work.cancel`、`run.interrupt`
  在 Action Gate 中保持 high-risk，即使存在 delegated envelope 也只生成待审批动作，不直接执行；
- 其他写操作是 confirmation-required mutation，只有 PI 已选择具体工具，且 project-scoped delegated
  envelope、target、revision、idempotency 与 Action Gate 全部匹配时才能执行；
- 每个实际调用同时留下 `tool_call_audit`、`pi_actions/pi_action_events` 和 Work/Run domain audit。async provider/domain
  outcome 必须完成后才把 PI action 标为 `completed`；失败写 `execution_error`。

## 3. 幂等和紧凑输出

所有 mutation schema 强制 `idempotency_key`。runtime 把 caller key 收窄为
`supervisor-control:<action>:<project>:<target>:<caller-key>`：

- 相同 key + 相同 payload 返回同一 `pi_actions` 记录与已保存结果，不重复调用 domain/provider；
- 相同 key + 不同 payload fail closed 为 conflict；
- 同一 scoped key 同时作为 Work/Run domain `event_id`，继续复用底层 fingerprint/revision 冲突检测；
- `expected_revision` 必填；Run API 继续按具体 operation 确定性校验 `expected_attempt_revision` 与 `prompt` 前置条件。

list 默认 10、最大 20；detail 只保留决定性字段、bounded summary、有限 Attempt/relation/artifact/risk/action refs，不返回
artifact bytes、完整 transcript、完整 Issue body 或无限 changed-files。model-visible JSON 上限 6000 chars，基准按
4 chars/token 估算不超过 1500 tokens；相同 bounded projection 写入 content/details/audit，超限时统一收窄为带
preview 的截断 envelope，而不是在 details 或 audit 中保留大对象。

## 4. authority、兼容、回滚和删除门禁

| domain | 当前 source of truth | tool 行为 |
| --- | --- | --- |
| Work | `issues` / `issue_events`，经 Issue-backed Work adapter | 不写 `works` shadow，不开放 G4 前无损 carrier 不足的关系写 |
| Run | `issue_runs` lifecycle、`run_attempts` child facts、run lifecycle audit | control 只经 P03.04 command service；Session 仅 observation/provider control ref |
| Evidence | producer observation + `issue_events:evidence.recorded.v1` structured projection | 复用 P04.09 structured-primary + bounded compatibility read，不新增 status writer |
| Handoff | Git/Evidence/review/provider/outbox 各自事实 + `issue_events:handoff.*.v1` projection | fresh local delivery refresh；不 push、不建 PR、不更新 tracker、不改变 Work |

- **双写：0。** 新工具只调用现有 writer，不新增 table、queue、state machine 或 model-driven mirror。
- **双读：** 完全继承四个依赖 ADR 的 W1/W2 窗口；tool 不延长 Evidence/Handoff fallback，也不选第二 winner。
- **回滚：** 从 `PI_ALLOWED_TOOLS`/builtin registry 移除本组工具并恢复旧 compatibility prompt；业务数据、domain audit、
  provider outcome 与 append-only Evidence/Handoff 均保留，无数据回滚。
- **最终删除门禁：** legacy `issue_*`/session compatibility tools 只有在 P11.03/P11.05/P11.06/P11.09、G7、目标 tools
  与 Workflow/Guardian/PI consumer 完成映射、clean-baseline Golden Journey 与 rollback/restore rehearsal 通过、旧 consumer
  连续规定 observation window 为零后才能删除。本期不执行删除或 authority cutover。

## 5. 最小验证

```bash
cd backend-ts
bun test src/pi/supervisorControlTools.test.ts
bun test src/pi/piRuntimeTools.test.ts src/http/piToolRegistryApi.test.ts src/pi/actionEngine.test.ts
bun test src/http/workApi.test.ts src/http/runApi.test.ts src/http/evidenceApi.test.ts src/http/handoffApi.test.ts
```

Fixtures 覆盖 schema/registry risk、实际 runtime exposure、read/write audit、越权 mutation 拒绝、exact replay、key/payload
conflict、Run command service retry、async audit outcome，以及 6000 chars / 1500 tokens model-visible output 基准。
