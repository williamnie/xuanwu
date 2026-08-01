# ADR-XW-0049：Workflow Manifest 与 Registry

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.07 / Runner #686
- 硬依赖：XW P00.04 / #634、XW P04.06 / #668（均 `done`）
- 可执行合同：`backend-ts/src/workflows/manifest.ts`
- Registry：`backend-ts/src/workflows/registry.ts`
- canonical 级别：本文、`WORKFLOW_MANIFEST_SCHEMA`、`WORKFLOW_PROJECT_OVERRIDE_SCHEMA` 与 `createWorkflowRegistry()` 共同构成本阶段 Workflow revision、项目收紧 override、引用解析和诊断的 source of truth

## 1. 决策边界

`WorkflowManifest(schema_version=xuanwu.workflow-manifest.v1)` 用一个 closed schema 描述顺序 stage。每个 stage 必须显式声明：

- Agent role、可选 profile 与来自现有 skills registry 的 required skill IDs；
- `max_tool_permission`、tool allowlist 与 action allowlist；
- 精确到 revision 的 P04.06 `verification-policy:<id>@<revision>`；
- `max_attempts` 与逐次 retry backoff；
- stage approval mode 与确定性 policy ref；
- P05 Handoff mode、`required=true` 与 base manifest 明确允许的 project mode 集合。

Manifest 只描述受控执行合同，不创建 Run、不执行 tool/action、不改变 Work 状态，也不替代现有 Action Gate、approval、Evidence evaluator 或 Handoff service。`dangerous` stage 没有显式 approval 会被 schema semantic validation 拒绝；但 manifest 中存在 approval 或 allowlist 也只构成上限，不能给 LLM 或 Agent 授予高于项目 policy、tool registry 和确定性 Action Gate 的权限。

P06.08–P06.11 负责注册具体 Investigate/Implement/Repair/Review/Release/Research/Migrate manifests，P06.12 才负责可执行 Skill Runtime。本 issue 不提前接入 planner/executor，不修改 DB、HTTP API、共享状态机、provider adapter 或现有 project public schema。

## 2. Versioning 与引用

- V1 manifest ref 固定为 `workflow:<stable-id>@<positive-revision>`；同一 stable ID 可注册多个 revision。
- Registry resolution 必须提供完整 ref，不提供 `@revision`、请求未知 revision 或传入未来 schema version 都 fail closed；不存在自动选择 latest、降级到旧 revision或 provider/LLM 自选 winner。
- 同一 ref 来自多个 source 时该 revision 整体 quarantine，Registry 不以 load order 决定胜者。
- V2 必须通过新 schema/adapter 显式加入；V1 reader 对未知字段给出精确 `unknown_field` diagnostic，不能静默忽略可能扩权的字段。

这使 Work 可以冻结精确 manifest revision。后续 selector 可以显式选择一个 revision，但一旦写入 Work snapshot/ref，Registry 新增 revision 不得升级已有 Work。

## 3. Registry 与 diagnostics

`createWorkflowRegistry()` 消费带 `source_path` 的 manifest registrations，并可注入现有 skill/tool/action/agent-profile/verification-policy registries 进行交叉检查。每个 item 公开 `ready`；以下情况保留可读 diagnostic 但禁止 resolve：

- schema/semantic invalid、未来版本或未知字段；
- duplicate manifest revision；
- missing skill/tool/action/profile/P04 verification policy；
- required skill/tool permission 高于 stage 最大权限，或 skill required tool 不在 stage allowlist。

一个坏 manifest 不影响其他 ref；但坏 ref 本身没有兼容 fallback。诊断只包含 registry source label、manifest ref、项目 ID 和字段 path，不要求记录 prompt、secret 或绝对 project path。

## 4. Project override

`WorkflowProjectOverride(schema_version=xuanwu.workflow-project-override.v1)` 是 project config adapter 的 canonical input。它必须绑定：

- `project_id + workflow_id + base_revision`；
- 非空 `audit_event_ref`；
- 唯一的 stage overrides；
- 可选 P04.06 `ProjectVerificationOverride` 列表。

V1 override 只能收紧或在 base 明确授权的集合内选择：

- tool permission 只能降低，tool/action allowlist 只能取 base 子集；
- retry attempts 只能减少；
- approval mode 只能从 `none → before_external_write → before_stage` 增强；同一 mode 不允许偷换 policy ref；
- Agent role/required skills 不可改，只能选择已注册 profile；
- Handoff mode 只能来自 base `project_override_modes`；
- Evidence policy 不能直接替换，只能复用 P04.06 已证明“只能收紧”的 `ProjectVerificationOverride`，并绑定精确 policy revision。

如果某项目存在指向该 workflow revision 的 invalid/duplicate override，Registry 对该项目 fail closed，不能忽略 override 后回退到更宽的 base；没有 override 的其他项目仍可使用健康 base。Registry 只校验和生成 effective snapshot，不写 project config。未来 project-settings writer 必须先经授权 mutation 与 append-only intent/outcome audit，再把带 audit ref 的配置交给 Registry。

## 5. Authority、兼容、迁移与回滚

- **Workflow template authority**：V1 schema + Registry 拥有可选择 manifest revision 与 effective project override 的语义。
- **Per-Work authority**：现有 Issue `workflow_snapshot_json` / Work `workflow_ref` 继续拥有某个 Work 已冻结的执行合同；Registry 不反向覆盖历史 snapshot。Issue Prompt 模板已由 `058_drop_issue_templates` 删除，不能被猜测成 V1 manifest。
- **Verification authority**：P04.06 policy/evaluator 继续拥有 Evidence gate 语义；Workflow 只保存精确 ref。现有 `project_pi_policies.verification_policy_json` 继续只拥有 PI timeout/evidence-required V0 设置。
- **Permission/state authority**：既有 tool registry、project policy、Action Gate、approval repository 与 Work/Run/Evidence/Handoff services 最终裁决；manifest/override/LLM output 都不是 writer。

兼容计划：

| 窗口 | 读写与 authority |
| --- | --- |
| Workflow Manifest V1 | Registry 与既有 `workflow_snapshot_json` / `workflow_ref` 继续按精确 revision 工作，双写 0、双读 0 |
| Issue Prompt 模板移除 | 删除无实际多模板消费者的 UI、API、CLI、快照字段与表；不兼容历史模板数据，也不做双读或双写；普通 Issue 执行仅传递原始标题和描述，不注入通用 Goal Contract 或 Runner lifecycle contract |

- **回滚**：恢复上一版应用和迁移前 SQLite 备份；删除模板后的新 Issue 不再生成 `template_id` / `prompt_template`，不能把 Workflow manifest 反写成旧模板。
- **删除边界**：`058_drop_issue_templates` 只删除 Issue Prompt 模板。`workflow_snapshot_json`、Work `workflow_ref`、Registry、Evidence 与 Handoff authority 全部保留。

## 6. 最小验证

```bash
cd backend-ts
bun test src/workflows/registry.test.ts
bunx --package typescript tsc --noEmit --target ES2022 --module ESNext \
  --ignoreConfig --moduleResolution Bundler --strict --skipLibCheck --lib ES2022 \
  --types bun --allowImportingTsExtensions \
  src/workflows/manifest.ts src/workflows/registry.ts src/workflows/registry.test.ts
```

Canonical fixtures 位于 `docs/fixtures/workflows/`，覆盖合法 manifest、含未知字段的非法 manifest 与 audited project override。自动化测试还必须覆盖 future version、精确 revision、不安全 override、missing registry dependency 和 duplicate revision quarantine。
