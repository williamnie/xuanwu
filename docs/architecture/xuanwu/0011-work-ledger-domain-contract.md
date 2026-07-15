# ADR-XW-0011：Work Ledger 领域合同与状态机

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.01 / Runner #647
- 依赖：[ADR-XW-0004](0004-core-domain-objects.md)、[ADR-XW-0006](../xuanwu-migration/README.md)
- 可执行合同：`backend-ts/src/domain/work/contracts.ts`
- canonical 级别：本文是 Work Ledger 的 type、关系、provenance、acceptance 和状态前置条件的 source of truth；ADR-XW-0004 仍是跨核心对象 ID、共享状态词表和 Work → Run → Evidence → Handoff 完成不变量的 source of truth

## 1. 决策边界

本合同细化 P00.04 的 Work，不创建第二套运行态 ledger，也不提前实现 P02.02–P02.09：

- 本期不新增 table、migration、repository、API、adapter、feature flag、双写或双读。
- `contracts.ts` 直接复用 `coreDomainContracts.ts` 的 `WorkID`、`WorkStatus`、`WORK_STATUSES` 与 `STATE_TRANSITIONS.work`，不复制第二张状态表。
- 当前运行态继续以 `issues`、`issue_events` 与现有 Issue API/state service 为唯一 authority；本合同只给后续 schema、repository、adapter 和 parity 工具提供确定性输入。
- Session 仍是 Run drill-down；Guardian 失败先形成 Attention；PI Action、Delegation、Completion Watch 仍使用现有 carrier。它们不能仅因名称相近而获得新的 Work identity。
- P02.02 才能新增 additive `works` / `work_relations` / `work_events`；P02.03 才能把纯函数合同接入事务、optimistic precondition 和 event append；P02.04/P02.05 才实现兼容映射。

## 2. Work type

Work type 表达**工程语义**，不表达来源表、provider 或执行手段：

| type | 语义 | 允许关系 | 当前映射 |
| --- | --- | --- | --- |
| `objective` | 需要拆成多个可验收 Work 的工程目标；自身仍必须有 acceptance contract | 可作为 parent；可依赖其他 Work | 新 Work Ledger 接入后由明确的用户请求/Supervisor proposal 创建；当前无独立 carrier |
| `engineering_task` | 可由一个受控 Workflow 执行并独立验收的最小工程工作单元 | 可作为 parent 或 child；可声明 dependency | 所有现有 Issue 在 P02.04 中确定性映射为此类型 |

Action、Delegation、Completion Watch 不是 Work type：

- Action 是 Work 的执行或外部副作用事实，必须经过 Permission/Approval gate 并进入审计。
- Delegation 是授权/触发关系；一次 Delegation 可以导致多个 Work，但不拥有 Work 状态。
- Completion Watch 是观察关系；完成条件满足不会反向创造第二个 Work 或改写 Work 验收结果。
- Guardian alert 是 Attention；需要工程修复时，另建有明确 provenance 的 `engineering_task`。

新增 type 必须先证明它具有不同的生命周期或完成语义；按 UI 筛选、来源表或 provider 增加 type 不被允许。

## 3. Work 合同

`WorkLedgerEntry` 在 P00.04 基础字段上增加以下必需字段：

| 字段 | 合同 |
| --- | --- |
| `id` | P00.04 `WorkID`；迁移前 Issue projection 固定为 `xw:work:issues:<issues.id>` |
| `owner` | 唯一 project owner；本版关系不跨 project |
| `type` | `objective | engineering_task` |
| `title` / `goal` | title 用于稳定识别，goal 描述要达成的工程结果 |
| `status` | 复用 P00.04 七态，不允许局部扩展字符串 |
| `acceptance` | 版本化 acceptance contract，见第 7 节 |
| `provenance` | 唯一 origin 加有序 causes，见第 6 节 |
| `workflow_ref` | Workflow snapshot/ref；不得由 provider session 反向覆盖 |
| `revision` | 非负 optimistic revision；P02.03 的写命令必须携带 `expected_revision` |
| timestamps | `created_at`、`updated_at`；P02.03 的 mutation 与 event append 必须同事务 |

关系不嵌入 Work JSON；它们使用独立 `WorkRelation`，避免更新父对象时覆盖并发新增的 dependency。

## 4. 状态转移表

下表由 P00.04 `STATE_TRANSITIONS.work` 唯一实现；`contracts.ts` 仅导出引用 `WORK_STATE_TRANSITIONS`：

| from | allowed to |
| --- | --- |
| `triage` | `todo`, `cancelled` |
| `todo` | `triage`, `in_progress`, `cancelled` |
| `in_progress` | `todo`, `pending_verification`, `failed`, `cancelled` |
| `pending_verification` | `triage`, `in_progress`, `done`, `failed`, `cancelled` |
| `failed` | `triage`, `todo`, `cancelled` |
| `done` | 无 |
| `cancelled` | 无 |

额外前置条件：

1. 所有 transition 都必须携带 `expected_revision` 与第 8 节审计字段；revision 不匹配时 fail closed。
2. 进入 `in_progress | pending_verification | done` 前，所有 `depends_on` prerequisite 必须为 `done`。
3. parent 进入 `pending_verification | done` 前，每个直接 child 必须为 `done`。被取消的 child 必须先通过受审计的 scope/关系变更移出 parent，不可把 `cancelled` 当作完成。
4. 只有 `pending_verification -> done` 可完成 Work，并且必须通过第 7 节 acceptance gate。
5. `done` / `cancelled` 不原地 reopen；后续需求创建新 Work，并通过 provenance 或关系引用历史 Work。

当前 `issueUpdate.ts` 只校验状态字符串并保留少量运行态保护，尚未执行完整 Work 图和 acceptance 前置条件。本合同在 P02.03/P02.04 接线并通过 parity gate 前，**不得**直接改变旧 API 行为。

## 5. parent / child / dependency

### 5.1 方向

- `parent_child(parent_work_id, child_work_id)`：scope/分解关系；每个 child 最多一个直接 parent，形成 forest。
- `depends_on(work_id, depends_on_work_id)`：`work_id` 是 dependent，只有 prerequisite `depends_on_work_id` 完成后才可执行。

### 5.2 不变量

1. 两端 Work 都必须存在、ID kind 为 `work` 且 owner project 相同。
2. 禁止 self edge、重复 semantic edge 和重复 `relation_id`。
3. child 最多一个 parent；层级图必须无环。
4. dependency 图必须无环。新增一条边时，repository 必须在同一 transaction 内检查“从 prerequisite 是否可达 dependent”；命中即拒绝并不写 relation/event。
5. parent 不继承 child 的 Run/Evidence/Handoff ownership；每个 Work 分别验收，parent 的完成门禁再检查 child 状态。
6. dependency 不传播取消、失败或权限；prerequisite 非 `done` 时只阻塞 dependent。Supervisor 可提出解除/替换关系，但不能由 LLM 直接改图。
7. relation add/remove 是状态 mutation。新增关系必须带 actor、reason、correlation、timestamp 和 `audit_event_ref`；删除必须先 append 对应 `work_events` 审计记录，不能静默物理删除。

`validateWorkLedger()` 同时检查 hierarchy 与 dependency DAG；`evaluateWorkTransition()` 从完整 snapshot 推导 child/dependency，不接受模型声称“依赖已完成”的自然语言摘要。

## 6. source / provenance

### 6.1 来源分类

允许的 `WorkSourceKind`：

| kind | 示例 authority | 用途 |
| --- | --- | --- |
| `user_request` | PI conversation/message、授权 channel event | 用户原始工程请求 |
| `issue` | `issues` / `issue_events` | 现有 Issue backfill/兼容 identity |
| `supervisor_proposal` | issue supervisor/PI proposal event | 确定性 gate 批准后的拆解或修复提议 |
| `automation_trigger` | automation trigger audit | Standing Order 触发后创建的明确 Work |
| `guardian_remediation` | Guardian decision/Attention resolution event | operational Attention 升级出的工程修复 |
| `import` | 受信 migration/import manifest | 可重复导入的外部或历史工作记录 |

Action、Delegation、Watch 的原始 carrier 在 P02.05 作为 relation/source ref 映射；它们本身不获得 Work ID。

### 6.2 provenance envelope

每个 Work 必须有一个不可替换的 `origin`，并可带零个或多个去重后的 `causes`。每个 source 至少保存：

- `kind`、`authority`、`external_id`、`occurred_at`；可用时保存 `source_event_id`。
- 完整新记录必须保存 `actor` 和 `correlation_id`，并标记 `completeness=complete`。
- 历史 Issue 缺失 actor/correlation 时标记 `completeness=legacy_incomplete` 并显式列出 `missing_fields`；不得让 LLM 猜补。
- provenance 只解释来源/因果，不授予写权限，不取代 Work owner，也不把 provider Session 变成 Work identity。

P02.04 的 Issue 映射必须以 `issues.id` 生成稳定 Work ID，并以 `issues` row + `issue.created` event 生成 provenance；重复 backfill 必须得到同一 identity 与同一 origin ref。

## 7. acceptance contract

`WorkAcceptanceContract` 是创建/重新定界 Work 时冻结的版本化合同：

```text
version: positive integer
completion_rule: all_required
requires_handoff: true
criteria[]:
  id: stable within the Work
  description: human-reviewable outcome
  required: boolean
  verification_policy_ref: deterministic Verification Policy reference
```

门禁：

1. 至少一条 criterion，且至少一条 `required=true`；ID 唯一，description/policy ref 非空。
2. `done` 判定必须针对当前 acceptance version；旧 version Evidence 不得静默复用。
3. 每条 required criterion 至少关联一条 `passed` Evidence；仅有模型总结、Run `succeeded`、Issue error 文本或命令计划均不满足。
4. 至少存在一条 `passed` Evidence，并有同一 Work 的 `ready | delivered` Handoff。
5. acceptance 改版是受审计 mutation：递增 version、记录 actor/reason/correlation 和 before/after ref；Work 已进入 `pending_verification` 后修改合同必须回到 `triage | in_progress` 重新收集 Evidence。
6. `objective` 除自身 acceptance 外，还必须满足直接 children 全部 `done`；child Evidence 不自动冒充 parent criterion Evidence。

P04 Verification Policy 决定 Evidence 是否 passed，P05 Handoff 决定 review/delivery 状态；Work Ledger 只消费这些确定性结果，不复制它们的事实 authority。

## 8. 审计与权限合同

所有状态 transition command 必须包含：

- `event_id`、`work_id`、`expected_revision`、`from/to`（`from` 由当前 row 读取）；
- actor、非空 reason、correlation ID、occurred_at；
- gate `authority=deterministic_policy | human_approval`、decision 与 policy ref；
- repository 成功后写入 before/after revision、outcome；失败/deny/ask 也写不执行结果，不伪造 status change。

LLM 只能提出 transition proposal；它不能提供受信 gate authority、把 `ask/deny` 改成 `allow`、声称 Evidence passed、修改 relation 或执行 destructive operation。P02.03 必须在同一 transaction 中重新读取当前 revision/关系/Evidence/Handoff projection、运行纯函数、更新 row 并 append event；任一阶段失败整体回滚。

外部写和 destructive 操作不由 Work status 自动触发，仍经过 Action Proposal/Approval 与 P00.04 `AuditedEffect` 门禁。

## 9. source of truth、兼容窗口、回滚与删除门禁

本合同遵循 ADR-XW-0006 的 Work migration stream：

| window | authority / 读写 |
| --- | --- |
| W0（本期及 additive schema） | `issues`、`issue_events` 与现有 Issue API/state service 唯一读写；Work contract 只在内存测试 |
| W1（P02.04/P02.08） | legacy 仍唯一 authority；允许至多一个正式 release 的 idempotent target shadow write，读为 legacy primary + target parity comparison |
| W2（P02.08/P02.09） | target-primary read；通过 G4 审计 cutover 前写仍在 legacy，cutover 后 `works/work_relations/work_events` 成为唯一写 authority；窗口结束前停止全部 dual mode |
| W3 | target-only；旧 Issue API 只能翻译到同一个 Work domain command，不可第二次写 storage |

- **双读期限：** 仅 W1、W2，共最多两个正式 release window。
- **双写期限：** 仅 W1，共最多一个正式 release window；shadow failure 不改变 legacy 结果。
- **冲突规则：** G4 前 legacy 获胜并记录 mismatch；G4 后 target 获胜。LLM 不得选择版本。
- **回滚：** 禁用 Work read/write flag，恢复 Issue path；按稳定 Issue↔Work mapping 回放已审计 target-only delta，再由 legacy rows/events 重建 Work projection。启用 target-only 写前必须在 DB 副本验证此 runbook。
- **最终删除门禁：** 只有 P11.05/P11.09、G7、Issues consumer 为零、备份/恢复演练通过、观察窗结束且 rollback 不再依赖旧 route/table/fixture 时，才能删除兼容路径。

本期回滚仅删除本 ADR、`contracts.ts` 与定向测试；没有 schema、数据或外部状态需要恢复。

## 10. 验证合同

最小门禁：

```bash
bun test backend-ts/src/domain/work/contracts.test.ts
cd backend-ts && bunx --package typescript tsc --noEmit --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022 \
  --types bun --allowImportingTsExtensions \
  src/domain/work/contracts.ts src/domain/work/contracts.test.ts
```

测试必须证明：

- 纯函数状态表复用 P00.04，合法 transition 通过、非法 transition 拒绝；
- 未完成 dependency 阻止执行，dependency cycle 与 hierarchy cycle 被拒绝；
- `done` 同时要求当前 acceptance version、每条 required criterion 的 passed Evidence 与 ready/delivered Handoff；
- provenance 对新记录要求 actor/correlation，对历史缺口要求 `legacy_incomplete + missing_fields`；
- status/关系 mutation 缺少审计字段或确定性 gate 时 fail closed；
- canonical 文档持续声明唯一 authority、W1/W2 期限、回滚和 P11 删除门禁。
