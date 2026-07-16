# ADR-XW-0032：Workflow Verification Policy

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.06 / Runner #668
- 依赖：[ADR-XW-0027](0027-evidence-domain-contract.md)、[Xuanwu migration plan](../xuanwu-migration/README.md)
- 可执行合同：`backend-ts/src/domain/evidence/policy.ts`
- canonical 级别：本文与可执行合同是 Workflow Verification Policy V1 的 schema、组合规则和判定语义 source of truth

## 1. 决策边界

P04.06 定义未来 Workflow Registry 可按 `verification-policy:<id>@<revision>` 引用的纯合同和 evaluator，但不提前实现 Registry、Evidence repository/API/UI 或 `done` mutation：

- evaluator 只消费调用方提供的 policy、Project override、Work/Run/Attempt context、结构化 `EvidenceRecord`、artifact availability snapshot 和审核决定，不读数据库、不调用 provider、不执行命令、不写外部状态；
- P04.01 `EvidenceRecord` 继续是事实合同，command/Git/HTTP/browser/human authority 继续拥有原始事实；policy 只判定这些事实能否满足工作流门禁；
- `backend-ts/src/pi/verificationPolicy.ts` 与 `project_pi_policies.verification_policy_json` 当前只拥有 PI `pending_verification` 超时/evidence-required 的 V0 runtime 设置，不能被猜测或静默升级成 V1 Workflow policy；
- P04.07 才能把 evaluator 结果接入 `done`，P04.09 才负责 structured Evidence/policy persistence、API 与用户可读界面；本期不修改共享状态机、schema、repository、HTTP API、provider adapter 或 UI；
- `passed`、`overridden` 只是一份纯判定结果。没有 P04.07 的审计 mutation service，它们不能改变 Issue/Work/Run 状态。

这保持 Registry-neutral：policy 自己携带完整决定性规则，evaluator 不依赖某个 registry class、数据库 row 或 provider 名称。

## 2. Policy schema

`WorkflowVerificationPolicy(schema_version=1)` 是 closed schema：

| 字段 | 语义 |
| --- | --- |
| `id` | `verification-policy:<stable-id>`；由未来 Registry 引用 |
| `revision` | 正整数；Project override 和人工 override 必须绑定精确 revision |
| `name` | 人类可读名称，不参与授权 |
| `kind_rules` | 仅为 P04.01 前向兼容的未知 kind 注册可信 origin/source；已知 kind 不可重新定义 |
| `required_groups` | 至少一个完成门禁 group |
| `optional_requirements` | 评估并展示，但不影响总判定；Project 可将其提升为 required |
| `risk_overrides` | 按精确 risk 增加 required groups，并声明是否允许有 Evidence 约束的人工 override |

所有 group id 和 requirement id 在 base、optional、全部 risk override 中全局唯一。policy 引用未知 Evidence kind 时，必须同时提供显式 `kind_rules`；旧 reader 因此仍是“可读、不可误授权”。`agent_claim` 与 `legacy_import` 永不在 kind rule 的允许 origin 中。

## 3. Requirement 与 required groups

每个 requirement 固定声明：

- `evidence_kinds`：一个或多个可接受 kind；
- `scope=work|run|attempt`：Work 永远必须匹配；Run/Attempt scope 还必须匹配当前 evaluation context；
- `selector_facts`：在同 kind 中选择对应 suite/scenario/target 的稳定标量事实；
- `fact_assertions`：对最新 matching Evidence 执行 `equals|not_equals|truthy|falsy` 通过条件；
- `max_age_seconds`：可选 freshness 上限；未来时间和过期 Evidence fail closed；
- `artifact_policy=ignore|present|available`：`available` 要求调用方提供的确定性 availability snapshot 对所有 artifact refs 均为 true；
- 可选 `skip`：存在时 requirement 才可跳过，并固定 allowlisted reason codes 与 `requires_human_evidence=true`。

每个 required group 只支持两个组合操作：

- `all`：全部 requirement 为 `passed|skipped` 才通过；任一 `failed` 使 group 失败，否则保持 pending；
- `any`：任一 requirement 为 `passed|skipped` 即通过；全部为 terminal `failed` 才失败，否则保持 pending。

所有 required groups 必须通过，policy 才为 `passed`。optional requirement 产生同样的细分结果，但不改变 gate。

## 4. Evidence 选择与失败语义

Evaluator 先按 Work、scope、kind 与 `selector_facts` 筛选，再以 `observed_at`、`updated_at`、Evidence id 的稳定降序选择最新记录。输入中被合法 `supersedes_id` 指向的旧 Evidence 不再参与判定。

Requirement 结果固定为：

| 状态 | 条件 |
| --- | --- |
| `passed` | 最新 matching Evidence schema/semantic 合法、status passed、provenance 可信，且 freshness/artifact/fact 全部满足 |
| `skipped` | skip policy 允许，且 skip decision 与可信 human Evidence 完整绑定 |
| `missing` | 没有 matching Evidence，或当前 Run/Attempt scope 未提供 |
| `pending` | 最新 matching Evidence 仍 pending |
| `failed` | 最新记录 failed/blocked/invalid，或 provenance、freshness、artifact、fact condition 不满足 |

同 kind 的旧 pass 不能覆盖更新的 failure。错误 Work 的 Evidence、Agent prose、Run succeeded、issue comment、V0 `passed` 字符串均不能替代 matching trusted Evidence。

## 5. Skip reason

Skip 是 requirement 级的显式例外，不是把 Evidence 缺失改名为成功。一个 skip 仅在以下条件全部成立时生效：

1. requirement 声明 `skip`，reason code 位于 allowlist，且调用方提供非空 reason；
2. `human_evidence_id` 指向同一 Work 的 active、passed、trusted `human` Evidence；
3. provenance 必须为 `human_attestation + human_attestation`，producer.kind 必须是 `user`；
4. decision 与 Evidence 使用同一 `audit_event_ref`；
5. Evidence facts 必须绑定 `decision=skip`、精确 `requirement_id` 和 `reason_code`。

不满足任一条件时 skip 不生效，requirement 回到正常 Evidence 判定。LLM 不能通过生成 reason、伪造 actor 文本或声明“用户同意”跳过门禁。

## 6. Risk 与人工 override

Risk 值为 `safe|confirm|high|forbidden`。命中的 `risk_overrides` 先把 `additional_required_groups` 加入 effective policy，再决定 `manual_override`：

- 默认和 `deny`：禁止人工 override；
- `allow_with_human_evidence`：只有绑定精确 policy id/revision/risk 的可信 human Evidence 才能把 raw `pending|failed` 结果变为 `overridden`；
- `forbidden` 在 schema semantic validation 中固定不能允许人工 override。

人工 override 的 human Evidence facts 必须为 `decision=verification_override`、精确 `policy_id`、`policy_revision` 与 `risk`，并满足与 skip 相同的 user producer/audit binding。`overridden` 被单独保留，不能伪装成 deterministic `passed`，后续 P04.07 必须把两者写成可审计的不同 outcome。

## 7. Project override

`ProjectVerificationOverride(schema_version=1)` 绑定 `project_id + policy_id + base_policy_revision + audit_event_ref`。为避免项目设置成为绕过 workflow contract 的旁路，V1 只允许收紧：

- `additional_required_groups`：增加 required groups；
- `promote_optional_requirement_ids`：把 base optional requirement 提升为单项 `all` group；
- `disallow_skip_requirement_ids`：移除 base/risk requirement 的 skip 权限；
- `deny_manual_override`：关闭 base risk 已允许的人工 override。

Project override 不能删除 required group、降低 freshness/artifact/fact 条件、注册新 trust kind 或允许原本被拒绝的人工 override。policy id、revision 或 project 不匹配时整次 evaluation 为 `invalid`，不得回退到忽略 override 的宽松判定。

本期不把该对象写入现有 `verification_policy_json`。未来 project-settings adapter 必须先完成授权写与 append-only audit，再把精确 override snapshot 交给 evaluator。

## 8. 决策与审计边界

Evaluator 输出 `passed|pending|failed|overridden|invalid`，并保留每个 group/requirement、选中 Evidence id、reason、risk/project override 是否应用以及人工 override rejection reasons。

- policy/context/project override schema 或引用冲突产生 `invalid`；
- 缺 Evidence 一般产生 `pending`，已有决定性失败产生 `failed`；
- `satisfied=true` 仅对应 `passed|overridden`；
- evaluator 不生成、补写或修改审计事件；它只校验调用方提供的绑定。P04.07 mutation service 必须把 policy snapshot/ref、input Evidence ids、decision、actor、intent/outcome 与 state transition 写入现有 append-only audit boundary；
- 外部写、destructive action 和 permission/approval gate 不属于 Verification Policy。即使 verification passed，也不能绕过原 action gate。

## 9. 兼容、迁移与回滚

| 窗口 | authority / 读写 |
| --- | --- |
| W0（P04.06） | V1 policy 合同/evaluator 是新 Workflow verification 语义 authority；现有 PI timeout policy 继续只拥有 runtime timeout，二者不互相投影、不双写 |
| W1（P04.07–P04.08） | P04.07 在现有 Issue/Work authority 上调用 V1 evaluator；legacy verifier report 只作展示/parity，不能满足新 gate |
| W2（P04.09 起，最多两个正式 release window） | structured Evidence/policy persistence/API primary；legacy read 仅作显式 provenance fallback/parity |
| W3 | structured-only consumer；legacy payload 仅按 retention/audit 保存 |

- **本期双写窗口为 0。** 没有新 table/repository/writer，也不改现有 `verification_policy_json`。
- **双读期限：** W1/W2 合计最多两个正式 release window；rollout 必须记录 owner、起止版本、parity、fallback 和 override audit 指标。
- **回滚：** 禁用 P04.07/P04.09 consumer，恢复当前 Issue/PI timeout 与 verification report 路径；保留已产生的 structured Evidence/policy/audit，不反写、不删除，也不得把 legacy report 升级为 trusted Evidence。
- **最终删除门禁：** 仅 P11.03/P11.06 在 G7、Workflow Registry/Project settings/Guardian/PI consumer 完成映射、legacy producer/consumer 连续一个正式 release 为零、override 审计抽样和 artifact restore 演练通过后，才能删除 V0 adapter/timeout compatibility path。

## 10. 最小验证

```bash
bun test backend-ts/src/domain/evidence/policy.test.ts
cd backend-ts && bunx --package typescript tsc --noEmit --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022 \
  --types bun --allowImportingTsExtensions \
  src/domain/evidence/policy.ts src/domain/evidence/policy.test.ts
```

Table tests 必须覆盖 required group 的 `all/any`、缺 Evidence、failed/blocked、错误 Work/scope、latest selection、freshness/artifact、unknown kind registration、skip reason、risk groups、可信/不可信人工 override，以及 Project override stale revision/tightening 分支。
