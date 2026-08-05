# ADR-XW-0089 P0：基线、consumer inventory 与 fixture 冻结

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 状态：实现修复中（branch `feature/provider`；W2 正式 release 观察窗尚未开始）
- 性质：P0 只冻结清单、fixture 与检测基线，无运行行为变化，可整体回滚

## 1. Provider ID / label / capability / session field 生产 consumer 清单

### 1.1 后端生产代码（非测试）

| consumer 文件 | 使用点 | 说明 |
| --- | --- | --- |
| `providers/types.ts:3` | `EXECUTOR_PROVIDER_IDS = ["codex","claude","fake-execution-only"]` | 闭合联合唯一权威（P1 起改兼容投影） |
| `providers/types.ts:175` | `isExecutorProviderId()` | 校验入口（12+ 处消费） |
| `runtime/core.ts:191-202` | `executorProviders()` | 手写 codex/claude map（P4 改 registry） |
| `domain/review/humanReview.ts:379` | `isExecutorProviderId(providerID)` | 续 Session 校验 |
| `runner/piAcceptanceApplication.ts:130,218` | 同上 | same-session continuation / retry |
| `runner/automationRuntime.ts:113-114` | `isExecutorProviderId(selected/fallback)` | 选择回退 |
| `runner/interrupt.ts:337` | `isExecutorProviderId(provider)` | interrupt 可用性 |
| `runner/projectLoop.ts:83,178,197,214,269` | 多处 | 选择器 / authority / 校验 |
| `http/sessionApi.ts:59,112,137,153` | 多处 | session list / resume / read 校验 |
| `http/piActionDispatch.ts:412,494` | 多处 | dispatch 校验 |

### 1.2 前端生产代码

| consumer 文件 | 使用点 | 说明 |
| --- | --- | --- |
| `pages/sessions/sessionOptions.js:25-31` | `PROVIDER_OPTIONS`（含 opencode/kimicode disabled） | P6 删除静态权威 |
| `pages/sessions/sessionOptions.js` `CAPABILITY_LABELS` | 含 `transcript_export` | 与后端漂移（见 §3） |
| `utils/issueRuns.js:2` | `SESSION_CAPABLE_PROVIDERS = new Set(['codex','claude'])` | P6 删除 |
| `utils/issueRuns.js:19-22` | `providerLabel` switch（含 opencode/kimicode） | P6 删除 |
| `db/schema/068_builtin_executor_profiles.ts:16-17` | seed `xuanwu-provider-codex` / `xuanwu-provider-claude` | P6 起新 Provider 不走 seed migration |

## 2. Fixture snapshot（P0 冻结）

- `providers/testing/executionOnlyProvider.ts`：仅 `issue_execution`，不写 Session、不产出 session/message/cursor ref；
- `providers/testing/resumableProvider.ts`：`fake-resumable`，有稳定 sessionRef、无 turn/message ref，recover 不依赖上一 message ref；
- `providers/testing/fullSessionProvider.ts`：`fake-full-session`，Codex-like，声明全部 Session/control/approval/model_list 且方法齐全；
- `providers/testing/conformanceFixtures.ts`：三类聚合导出，P2 conformance suite 复用。

## 2.1 P1 变更（动态 Provider ID 第一步）

- `providers/types.ts` 新增 branded `ProviderId`（`^[a-z0-9][a-z0-9._-]{0,63}$`，禁止冒号）与 `asProviderId()`/`isProviderId()` 校验；
- 新增 `ProviderExecutionRef`（providerId + invocationRef 必需；sessionRef/messageRef/cursorRef 可选）与 legacy `SessionRef` 双向映射 adapter（`executionRefFromSessionRef`/`sessionRefFromExecutionRef`）；
- `EXECUTOR_PROVIDER_IDS` 扩展 `fake-resumable`/`fake-full-session`（fixture 合法 ID，仍为闭合联合，P2 registry 起改 `registry.has`）；
- `domain/run/service.ts`：`ProviderAttemptStart.provider_session_id/turn_id` 放宽为可选；`completeRunAttemptStart` 用 `clean()` 容错空值，保留 `invocation_ref` 必填与 session 不匹配 fail-closed；
- 验证：`providers/types.test.ts`（ProviderId 校验 + ref 映射）、`domain/run/service.test.ts` P1 块（session-only resume、缺 invocation fail closed、session 不匹配 fail closed、缺 session ref 不变量）、`runner/providerRuntime.test.ts` P1 测试（execution-only 完成 Attempt 不写 Session）。

## 3. 前后端 capability drift 基线

| 项 | 前端 | 后端 | 处置 |
| --- | --- | --- | --- |
| `transcript_export` | `CAPABILITY_LABELS` 有 | `ExecutorCapability` 无 | 已固定为已知基线（P6 从 manifest/nativeActions 投影消除） |
| `opencode/kimicode` | `PROVIDER_OPTIONS` disabled 占位 + `providerLabel` switch | 未注册 | P6 从可提交 option 删除，仅留文档/roadmap |
| 可提交 enabled option | codex / fake-execution-only / claude | 均在 `EXECUTOR_PROVIDER_IDS` | 由 `p0Baseline.test.ts` 自动断言 |

## 4. typecheck 历史噪音（本分支不做修复）

`bunx tsc --noEmit` 基线 351 行错误，分布（top）：
| 文件 | 错误数 | 性质 |
| --- | --- | --- |
| `http/sessionApi.test.ts` | 19 | 测试接口漂移 |
| `http/piAttentionInboxApi.test.ts` | 11 | 测试接口漂移 |
| `runner/interrupt.test.ts` | 9 | 测试接口漂移 |
| `http/piActivityApi.test.ts` | 9 | 测试接口漂移 |
| `http/piActionDispatch.test.ts` | 9 | 测试接口漂移 |
| `providers/codex/provider.test.ts` | 6 | `FakeCodexIssueAdapter` 缺 `listThreads/listModels` |
| `skills/intentAudit.ts` | 5 | `*_json` 列名漂移 |
| 其余 ~20 文件 | 各 1-5 | 历史噪音 |

规则：重构不借机修无关错误；P0-P12 新增代码必须保持 typecheck 不劣化（新文件零错误）。

> P1 更新：`EXECUTOR_PROVIDER_IDS` 扩展两个 fixture ID 后，cascade 错误大幅收敛，当前分支 `bunx tsc --noEmit` 总错误 147 行（P0/P1 新增文件零错误）。

## 5. 检测自动化（P0 验收对应）

`providers/testing/p0Baseline.test.ts`：

1. enabled provider option ⊆ `EXECUTOR_PROVIDER_IDS`，opencode/kimicode 不在 enabled 集合；
2. 前端 `CAPABILITY_LABELS` 与后端 capability 的漂移差集 = `["transcript_export"]`（新增漂移即失败）；
3. `issueRuns.js` 中 opencode/kimicode 仅存在于 label switch（P6 删除清单），不在 `SESSION_CAPABLE_PROVIDERS`；
4. execution-only 完成 Attempt 不写 Session；resumable 无 message ref 可 recover；full-session 方法齐全。

后续阶段基线：P1 迁移 `isExecutorProviderId` 消费点时应保持上述 1 不回归。

## 6. P9 更新：consumer-zero inventory 与 W2 观察窗（rollback runbook）

### 6.1 消费点迁移状态（P9 时点）

| consumer | 状态 | 说明 |
| --- | --- | --- |
| `runtime/core.ts` Provider 装配 | migrated | registry 的 ready 实例是 Runner/HTTP/调度/关停唯一运行时投影；不再构造第二套 Codex/Claude executor map |
| `providers/core/registry.ts` | migrated | registry authority（P2） |
| `providers/core/catalog.ts` + `http/providersCatalogApi.ts` | migrated | /api/providers（P6） |
| `http/systemStatus.ts` `providerStatus()` | migrated | registry 投影 + 旧 bridge（P4） |
| `runner/interrupt.ts` `providerID()` | migrated | 手写穷举删除（P5） |
| `runner/recovery.ts` `providerID()` | migrated | 手写穷举删除（P5） |
| `http/frontendCompatHandlers.ts` `resolveApproval` | migrated | provider 绑定路由（P5） |
| `frontend sessionOptions.js/issueRuns.js` | migrated | catalog 派生 + 静态 authority 删除（P6） |
| `http/sessionApi.ts` | legacy | P6 聚合分页 cursor 合同已冻结，sessionApi 重构仍待 P6 收尾（W2） |
| `runner/projectLoop.ts`/`piAcceptanceApplication.ts`/`automationRuntime.ts`/`humanReview.ts`/`piActionDispatch.ts` | legacy | `isExecutorProviderId` 白名单校验（随 `ExecutorProviderId` 放宽收口） |

### 6.2 W2 观察窗与 rollback runbook

- 开关：`XUANWU_PROVIDER_LEGACY_PROJECTION_COMPARE=1` 开启 manifest/实例 capabilities parity 对比（`providers/core/parity.ts`）。
- drift 处理：记录 `provider.legacy_projection_drift` warning（含 drifted providers 与 diffs），不阻断运行。
- **rollback**：该 flag 只控制只读 parity telemetry，不是执行链切换开关。Registry primary 发布前仍须保留上一可运行 release；发现 drift 时回滚部署版本。对比不写 DB，因此无需 DB 回填或删除事件。
- parity 范围：refs（thread_id/turn_id ↔ sessionRef/messageRef）、capabilities（manifest detail ↔ 实例 legacy 数组）、status/session 数量由 runtime 快照对比（`compareRefsParity`/`compareCapabilitiesParity`）。

## 7. P12 更新：conformance harness 与 adapter 接入路径

- `providers/core/conformance.test.ts`：§20 矩阵自动断言（initial execution、稳定 invocation ref、resume 拒绝/支持、interrupt/model list 按 capability、unknown event preserve、支持矩阵快照）。
- `providers/testing/conformanceFactories.ts` `BUILTIN_FACTORIES`：fixture 经 factory 注册即纳入矩阵。
- 新 Provider 接入清单：`0089-provider-adapter-checklist.md`。
- Freshness Gate 调研模板：`0089-gate-investigation-template.md`（G0/G10/G11 通用，依赖升级重验规则见计划 §17.2）。
- G10 freshness 调研完成：`0089-g10-pi-freshness-gate.md`（pi 0.83.0）；P10 仍须以真实 RPC/Runner/Chrome acceptance 记录闭环。
- Pi Coding Agent 的 canonical Provider ID 固定为 `pi-coding-agent`；`pi` 只指 CLI 命令或玄武 PI Supervisor 前缀，不作为 Provider ID。
- G11：Qoder（Qoder.app Electron IDE）待调研结论定案（见 `0089-g11-qoder-freshness-gate.md`，未通过前不进入 adapter 实现）。
- 删除门禁当前未满足：Qoder acceptance、W2 一个正式 release、legacy consumer-zero 与 rollback 演练均需独立证据；测试 fixture 或 flag 就绪不能替代观察窗。

## 8. P12 当前状态：删除门禁核对与 legacy 删除清单

### 8.1 删除门禁核对（P12 验收）

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| 至少 Codex/Claude/Pi/Qoder 四种形态过 conformance | ⏳ | fixture conformance 存在；Qoder 按当前决策延期到本机安装后验收，不能标记完成 |
| §20 conformance 矩阵 | ⚠️ | fixture 自动化覆盖存在；生产 adapter 仍需分别附真实调用 acceptance |
| W2 一个正式 release 无 parity drift | ❌ | 尚未开始正式 release 观察窗；`XUANWU_PROVIDER_LEGACY_PROJECTION_COMPARE` 仅表示 telemetry 就绪 |
| rollback 演练 | ❌ | 需用上一可运行 release 做部署级演练；关闭 parity flag 不等于执行链回滚 |
| schema 迁移经 ADR-XW-0070 演练 | ✅（零 schema 迁移） | P0-P12 未新增任何 schema migration（042 列语义不变，空字符串合法） |
| 物理 schema 删除需单独 superseding ADR | 不适用 | 本重构未删除物理列 |

### 8.2 legacy switch / DTO consumer / bridge 删除清单（W3 目标）

以下为 W3（删除代码级 legacy consumer）的候选清单，需逐个确认 consumer-zero 后删除；物理删除前各需独立 ADR/非 LLM 授权：

| 项目 | 位置 | W3 删除动作 |
| --- | --- | --- |
| 静态 `EXECUTOR_PROVIDER_IDS` 闭合联合 | `providers/types.ts` | 改为 registry 驱动（P2 已完成 registry；W3 删枚举） |
| `isExecutorProviderId` 白名单消费 | `projectLoop.ts`/`piAcceptanceApplication.ts`/`automationRuntime.ts`/`humanReview.ts`/`piActionDispatch.ts` | 改 registry.assertCapability |
| `http/sessionApi.ts` 单页 best-effort merge | `sessionApi.ts` | 替换为聚合分页 cursor（§3.6 合同已冻结） |
| 手写 codex/claude status bridge | `systemStatus.ts` `providerStatus()` | registry 投影 primary 后删除 |
| `runtime/core.ts` 旧 executor map bridge | 已删除 | Registry ready projection 已成为唯一运行时实例来源 |
| 前端静态 `PROVIDER_OPTIONS`/fallback | `sessionOptions.js`/`issueRuns.js` | catalog 全量消费后删除静态 authority |
| `providerID()` 手写映射 | 已删除（P5） | — |

### 8.3 全量回归基线（P12 时点）

- `bun test src/providers/ src/domain/run/ src/runner/ src/http/ src/db/`：890 pass / 0 fail（186 文件，4660 expect）。
- `bunx tsc --noEmit`：151 行历史噪音（P0-P12 新增文件零错误）。
- `git diff --check`：干净。
