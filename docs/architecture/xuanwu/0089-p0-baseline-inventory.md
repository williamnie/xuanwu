# ADR-XW-0089 P0：基线、consumer inventory 与 fixture 冻结

- 关联：0089 Provider Core 多 Coding Agent 重构 [计划](0089-provider-core-multi-code-agent-refactor-plan.md) / [设计](0089-provider-core-multi-code-agent-refactor-design.md)
- 状态：完成（branch `feature/provider`）
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
