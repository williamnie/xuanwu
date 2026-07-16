# ADR-XW-0027：Evidence 结构、状态和来源合同

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.01 / Runner #663
- 依赖：[ADR-XW-0004](0004-core-domain-objects.md)、[ADR-XW-0020](0020-run-attempt-lifecycle-contract.md)、[Xuanwu migration plan](../xuanwu-migration/README.md)
- 可执行合同：`backend-ts/src/domain/evidence/contracts.ts`
- V0 兼容 projection：`backend-ts/src/domain/evidence/legacyAdapter.ts`
- canonical 级别：本文与可执行合同是 Evidence semantic record、状态、来源、redaction 和完成门禁资格的 source of truth；P00.04 继续拥有跨核心对象 ID 与共享 Evidence 状态机

## 1. 决策边界

本期只定义 Evidence 合同、纯验证/状态判定函数和 `VerificationEvidenceV0` 的无副作用 projection，不提前实现 P04.02–P04.09：

- 不新增或修改 table、migration、repository、HTTP API、collector、provider adapter、完成状态写路径、共享状态机或 UI。
- `contracts.ts` 直接复用 P00.04 的 `EvidenceID`、`EvidenceStatus`、`EVIDENCE_STATUSES` 与 `STATE_TRANSITIONS.evidence`，不在 `domain/evidence` 复制状态词表。
- P00.04 的 `Evidence` 是跨对象最小 skeleton；本合同的 `EvidenceRecord` 细化其语义，但本期不修改公开 core schema。后续持久化/API 必须从本合同投影，不能再建立一套平行 kind/status。
- **事实 source of truth 仍是产生该事实的 authority**：command/test/lint/build 的真实进程结果、Git object/repository、HTTP exchange、browser observation、human attestation，以及现有 append-only audit/event。Evidence 是带来源的事实记录，不反向覆盖这些 authority。
- Agent/LLM summary、issue comment、provider prose 与 `VerificationEvidenceV0` 的 `passed` 字符串都不能自动升级为系统证明。

## 2. Evidence 结构

`EvidenceRecord(schema_version=1)` 固定以下字段：

| 字段 | 合同 |
| --- | --- |
| `id` | P00.04 `EvidenceID`；authority 仍限制为 `issue_events/pi_action_events/issue_supervisor_events/git` |
| `work_id` | 唯一 Work owner，创建后不可静默修改 |
| `run_id` / `attempt_id` | 可选执行来源；Attempt 必须属于给定 Run，复用 P03.01 `RunAttemptID` |
| `supersedes_id` | 对 terminal Evidence 的纠正必须创建新记录并指向旧记录，不能 reopen/覆写旧事实 |
| `revision` | 非负 optimistic revision；status mutation 必须携带 `expected_revision` |
| `kind` | 已注册 kind 或满足标识符语法的未来 kind；未知 kind 的门禁规则见第 8 节 |
| `status` | P00.04 `pending \| passed \| failed \| blocked` |
| timestamps | `created_at/observed_at/updated_at`，terminal 时再有 `completed_at` |
| `decisive_output` | 可判断结果的最小摘要、可选 excerpt/exit code 和标量 facts |
| `artifact_refs` | 日志、报告、截图、trace、diff、commit、URL、文件等外部 artifact 引用 |
| `provenance` | assertion origin、source kind/ref、audit event 与 producer |
| `redaction` | policy、是否实际应用、被清理的 JSON Pointer paths |

schema 使用 `additionalProperties=false`。新增字段需要 schema version 演进；未知 `kind` 不要求未知任意字段，因此可在不丢失 kind 的前提下由通用 `decisive_output.facts` 和 artifact 承载事实。

## 3. Evidence kind

V1 注册八种 kind：

| kind | 决定性事实 | 受信 source |
| --- | --- | --- |
| `shell` | 命令是否按预期退出及关键输出 | `command_execution` |
| `test` | 测试集合、通过/失败和退出码 | `test_runner` 或 `command_execution` |
| `lint` | lint 范围、违规数和退出码 | `linter` 或 `command_execution` |
| `build` | build target、结果和退出码 | `build_system` 或 `command_execution` |
| `git` | revision/tree/diff/status 的 Git 事实 | `git_repository` |
| `http` | request target、status/assertion 等交换事实 | `http_exchange` |
| `browser` | 页面、DOM/visual assertion 与截图 | `browser_session` |
| `human` | 明确 reviewer 的人工验收/否决 | `human_attestation` |

kind 不代表信任。`test + agent_claim` 仍只是 Agent 声称测试通过；只有 provenance、状态、schema/redaction 校验和后续 Workflow Verification Policy 同时满足时才能成为完成门禁输入。

## 4. 状态与 timestamps

Evidence 直接复用 P00.04 状态表：

| from | allowed to |
| --- | --- |
| `pending` | `passed`, `failed`, `blocked` |
| `passed` | 无 |
| `failed` | 无 |
| `blocked` | 无 |

- `pending` 不得有 `completed_at`；所有 terminal 状态必须有 `completed_at`。
- `observed_at` 是 authority 产生/观察事实的时间；`created_at` 是 Evidence record 创建时间；`updated_at` 不得早于 `created_at`。
- terminal Evidence 不修改或 reopen。命令重跑、Git revision 改变、HTTP/browser 重新验证或 reviewer 改判都创建新 Evidence；需要纠正时使用 `supersedes_id` 保留审计链。
- `evaluateEvidenceTransition()` 是纯函数，只接受 ID/revision 匹配、合法 edge、完整 actor/reason/correlation/event/timestamp 且 gate=`allow` 的命令。gate authority 只能是 `deterministic_policy|human_approval`；LLM 不能声明自己是 gate。
- 本期不实现 mutation service。P04.02–P04.05/P04.07 若写状态，必须先持久化 intent/idempotency anchor，再执行外部读取或副作用，最后在同一审计边界写 outcome。

## 5. decisive output 与 artifact refs

### 5.1 decisive output

`decisive_output` 只保留“为什么能判定状态”的最小信息：

- `summary` 必需，描述测试集合/断言和结果，不接受只有“done”“looks good”的 Agent narrative；
- `exit_code` 适用于 shell/test/lint/build；HTTP、Git、browser 等可把稳定标量写入 `facts`；
- `excerpt` 仅保存经过长度限制和 redaction 的关键输出，不复制整段 raw log；
- `facts` 只允许 string/number/boolean/null，key 必须稳定且不得使用 token/password/cookie/authorization 等敏感字段名。

P04 collectors/verifier 负责各 kind 更细的必要字段策略；P04.01 不提前把 collector payload、browser DOM 或 HTTP body 固化进共享 schema。

### 5.2 artifact refs

大输出和可复核材料只以 artifact ref 关联：

- `kind` 固定为 `log|report|screenshot|trace|diff|commit|url|file|other`；
- `ref` 是 opaque reference，不能内嵌 credential；可选 `media_type/sha256/label`；
- 同一 Evidence 内 ref 唯一；sha256 若存在必须是 64 位小写 hex；
- Evidence status 不证明 artifact 永久存在。retention、hold、archive 与 restore 仍由 artifact/raw-event authority 管理。

## 6. provenance

`provenance` 必须同时记录：

- `assertion_origin`：`tool_result|system_observation|human_attestation|agent_claim|legacy_import`；
- `source_kind`：command/test/linter/build/Git/HTTP/browser/human/agent/V0 legacy 中的一个明确来源；
- `source_ref`：可回到原始事实或 observation 的 opaque ref；
- `audit_event_ref`：谁在何种 gate 下记录/转换该 Evidence 的 append-only 审计 ref；
- `producer`：P00.04 `DomainActor`，不能用模型文本补猜。

`tool_result|system_observation|human_attestation` 是合同层可受信 origin。受信 origin 的已知 kind 必须匹配第 3 节 source；例如 `git` 不能把 Agent statement 冒充 Git authority，`human_attestation` 只能产生 `human` kind。`agent_claim` 只能绑定 `agent_statement`，可以保存和展示，但不能满足完成门禁。

provider/agent session 只提供 observation；Run/Attempt 关系沿用 P03.01。Evidence 不拥有 Run，也不能修改 Run terminal 状态。Run succeeded、Agent 说完成和 Evidence passed 是三件独立事实。

## 7. redaction

`redactEvidenceRecord()` 对 `decisive_output`、artifact ref、provenance ref 等嵌套字符串执行统一敏感值清理，并记录真实发生变化的 JSON Pointer path：

- Bearer credential、TOKEN/SECRET/PASSWORD/API_KEY/ACCESS_KEY assignment、`token is ...` 短语和敏感 URL query value 必须在序列化/持久化前替换为 `[redacted]`；
- `redaction.status=applied` 必须至少有一个 `redacted_paths`；`not_required` 不得伪造 path；
- 即使 value 已写成 `[redacted]`，`decisive_output.facts` 也禁止敏感 key。调用方应保存安全派生事实或指向受控 artifact，而不是把 secret-shaped field 放进 Evidence；
- schema/semantic validation 发现未清理敏感值时 fail closed。仅声明 `status=applied` 不能掩盖仍存在的 secret；
- redaction 不是权限。artifact 的读取仍需原 authority 的授权和审计。

P10 的长期 secret scanning/retention 可以收紧 policy，但不得让更宽松的模型输出绕过 V1 规则。

## 8. 未知 kind 前向兼容

schema 接受符合 `^[a-z][a-z0-9_.-]*$` 的未知 kind 并原样保存，使新 collector 产生的记录可被旧 reader 列出、审计和导出。旧 reader 必须同时做到：

1. 不把未知 kind 改写成 `shell`/`test` 等已知 kind；
2. 不丢弃 `decisive_output`、artifact 或 provenance；
3. `validateEvidence().known_kind=false`，但结构正确时仍可 `ok=true`；
4. `canSatisfyEvidenceGate()` 对未知 kind 固定返回 false，直到 P04.06 policy 显式注册其决定性规则。

这实现“可读、不可误授权”的前向兼容。`legacy.independent_checker` 也遵守同一规则，因为 V0 没有足够 provenance 证明 checker 是 deterministic tool、另一个 Agent 还是人。

## 9. 完成门禁

合同层 `canSatisfyEvidenceGate()` 只提供必要条件：

- schema 与所有 semantic/redaction invariant 通过；
- kind 已注册；
- status=`passed`；
- assertion origin 为 `tool_result|system_observation|human_attestation`。

**LLM/Agent claim 不能满足完成门禁**；`legacy_import` 也不能。P04.06 仍须按 Work/Workflow 声明 required kind、revision freshness、artifact availability、过期时间和组合规则，P04.07 才能把 policy 接到 `done` mutation。任一缺失都不得把 issue comment、run success 或模型 summary 当作替代 Evidence。

## 10. `VerificationEvidenceV0` 兼容与迁移

`backend-ts/src/pi/verificationEvidence.ts` 当前仍是已运行 PI 路径的 V0 payload envelope。`projectVerificationEvidenceV0()` 只做内存 projection：

- `shell_test -> shell`、`http_smoke -> http`、`human_verification -> human`；
- `independent_checker -> legacy.independent_checker`，不猜 checker 身份；
- V0 command/url/checker/blocker 进入 redacted scalar facts，string artifact ref 转为结构化 ref；
- provenance 固定 `legacy_import + legacy_verification`，因此即使 V0 status 是 `passed` 也不能成为系统证明；
- projection 不写回 V0、不写新 table、不改变 Issue/Run 状态。

### 10.1 source of truth 与窗口

| window | authority / 读写 |
| --- | --- |
| W0（本期） | current issue/provider/action event、Git、command output 与 V0 payload 保持唯一 runtime authority；新合同和 adapter 仅用于测试/内存 projection |
| W1（P04.02–P04.05） | 新 observation 由对应 collector 生成 structured record；legacy observation 只经 adapter 读取，不对同一 observation 复制第二份 authority |
| W2（P04.06–P04.09） | structured Evidence/policy primary；V0/current legacy read 仅作 parity/fallback，记录 provenance drift |
| W3 | structured-only consumer；legacy source 只按 retention/audit 规则保留，不再参与完成门禁 |

- **本期双写窗口为 0**，即“双写窗口为 0”。P04.01 不新增 writer；后续也不得为了 migration 把同一 observation 同时写成两份互相竞争的 authority。若确需 shadow write，必须有 superseding ADR，且不得超过 migration plan 的一个 release 上限。
- **双读期限：** W1 与 W2 合计最多两个正式 release window。每个 rollout 必须记录 owner、起止版本、parity 指标和 fallback；不得无限保留 V0 + structured + 第三套 payload。
- **回滚：** 禁用 structured collector/policy consumer，恢复当前 V0/event/Git/command 读取；保留已写的 additive structured record 和 audit，不反写、不删除。任何 parity、provenance、redaction 或 artifact drift 都先回滚读/门禁，不让 LLM 补齐缺失事实。
- **最终删除门禁：** 仅 P11.03/P11.06 在 G7、所有 provenance/audit consumer 完成映射、V0 producer/consumer 连续一个正式 release 为零、contract fixture 留档、artifact/raw event 备份恢复演练和观察窗通过后，才能删除 V0 adapter/legacy payload path。本 issue 不删除 `verificationEvidence.ts`、raw event、artifact 或 Git authority。

## 11. 验证合同

最小门禁：

```bash
bun test backend-ts/src/domain/evidence/contracts.test.ts
cd backend-ts && bunx --package typescript tsc --noEmit --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022 \
  --types bun --allowImportingTsExtensions \
  src/domain/evidence/contracts.ts src/domain/evidence/legacyAdapter.ts src/domain/evidence/contracts.test.ts
```

测试必须证明：

- shell/test/lint/build/git/http/browser/human 都通过同一 schema，状态表复用 P00.04；
- terminal timestamps、Run/Attempt relation、schema closure 与 audited transition fail closed；
- 合法未知 kind 可读但不能通过完成门禁；
- 嵌套 secret 被清理、敏感 fact key 被拒绝、声明 redaction 不能隐藏 raw secret；
- Agent claim 与 V0 legacy import 即使 `passed` 也不能冒充系统证明；
- canonical 文档持续声明 runtime authority、0 本期双写、最多 2 release 双读、回滚和 P11.03/P11.06 删除门禁。
