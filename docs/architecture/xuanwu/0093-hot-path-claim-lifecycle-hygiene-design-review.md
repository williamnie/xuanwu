# ADR-XW-0093 Review 问题清单

- 状态：Proposed（作者已提交减重后的 v3 文档修订，等待最终复核，未授权实现）
- 日期：2026-08-19
- 对象：[ADR-XW-0093 Work 热路径、Run 两阶段准备、Codex 进程观察与发布门禁](0093-hot-path-claim-lifecycle-hygiene-design.md)
- 范围：设计逻辑审查 + 与当前代码的事实核验（`frontend/src/store/dataStore.js`、`frontend/src/api/work.js`、`backend-ts/src/http/{workApi.ts,readApiDomain.ts}`、`backend-ts/src/db/repositories/{issueRuns.ts,issueQueue.ts,issueActions.ts}`、`backend-ts/src/providers/codex/{jsonRpc.ts,processLifecycle.ts}`、`scripts/repository-hygiene-audit.mjs`、`scripts/package-release.sh`）+ live DB 只读抽样 + 相邻 ADR 一致性
- 说明：本清单由独立 reviewer 评审产出（4 个并行只读探索代理分别核查 Read path / Run 两阶段 / Codex lifecycle / Hygiene-release 四个领域 + 主代理沿关键 file:line 抽查复核）；2026-08-19 经第二轮独立 reviewer（qwen3.8-max）复核并勘误：B2 降级为重要问题、retry 入口链路更正、6 处行号修正，详见核验方法。

## 总体结论

**建议修订后批准。** 五个决策方向正确、证据扎实：live DB 抽样与代码调用链基本全部验证属实，crash/CAS/signal-safety/独立授权等边界覆盖良好。但须先修补 2 个阻断问题——§12.1 预算与 §5.2 cap 的硬性数字冲突、部署过渡期存量 open Run 无 baseline marker 的迁移缺口——并补齐若干边界细节（含 §6.5 CAS 状态转移契约的明确化、SSE 刷新节流、Phase C 原子 once 等）后，再进入 Phase 0。

## 作者 v3 响应（2026-08-19）

第二轮减重意见已采纳，并对 DB authority 事实作如下最终收敛：

- Project counts 首期一次返回全部结果，硬上限 128；第 129 个 Project 返回显式 capacity error，删除 `project_page_size/project_cursor/ProjectSummaryCursorV1`。
- Work cursor v1 只支持 `(updated_at DESC, issue_id DESC)`；title/status/created-at/ascending 继续使用既有 page contract。
- `issue_runs` 没有“每 Issue 单 open Run”的 partial unique constraint，因此保留 current-Run/status/cwd validation；同时删除 `already_finalized`、captured/unavailable 冲突 marker 和 prepared-marker authority。Captured baseline 只走 guarded UPDATE + 现有单 event，`changes=0` 即停止。
- Git observation 失败返回 `null`，不新增 unavailable event；Phase C 复核 current Run 后允许继续，现有 missing-baseline attribution 保持 uncertain/fail-closed。
- Provider fence 收敛为显式 `issueRunId + canonical current open Run`，不再要求 marker。
- 删除原 §6.7.1 legacy transition/startup reconciliation。旧 Run 按既有 Run/session/invocation truth re-enter；无 session/turn 时继续由 `canRequeueUnstartedClaim` 收敛。
- 实施顺序改为 Phase 1 hygiene → Phase 2 lifecycle → Phase 3 summary → Phase 4 run split；同步删除 marker/legacy/project-cursor/multi-sort 对应验收项。

v3 保留 Phase A 状态矩阵、Phase B transaction 外观察与并发/timeout、Phase C current-Run guard、显式 Run ID、materializer dependency test、失败语义和 rollback；减重不改变 authority、Handoff uncertainty 或 stop fresh-scan 安全边界。

## 作者 v2 响应（2026-08-19，历史记录）

正文 v2 已逐项吸收本清单，状态保持 Proposed：

- **B1 resolved：** global/single-project summary 默认不返回 Project 明细且预算 `<16 KiB`；per-project counts 改为默认 50、最大 100 的独立 page，预算 `<64 KiB`，不再存在 500 项与 64 KiB 冲突。
- **B3 resolved：** 新增 startup exact-set reconciliation。旧 open Run 已有 marker 则复用；有 session/turn 但缺 marker 只写 `legacy_open_run_before_preparation_contract` unavailable marker；无 invocation facts 则 recovery/requeue；禁止用部署时 workspace 伪造启动 baseline。
- **I1 resolved：** §6.3 增加 queue、human review、PI acceptance、Automation、Provider runtime 的 Phase A 状态与事务矩阵，并明确 retry/forceRetry 只是上游触发链。
- **I2 resolved：** summary coordinator 固定 500ms debounce、1s monotonic minimum interval、single-flight + one trailing，并只响应 aggregate-affecting events；增加 SSE burst request-count budget。
- **I3 clarified/resolved：** marker lookup、current-Run validation、guarded update 和 event insert 被明确要求位于同一 SQLite `.immediate()` transaction。该边界已串行化 writer；正文没有把 I3 继续描述为已证明的并发缺陷，同时补充 captured guard、unavailable 幂等和未来 multi-writer uniqueness migration 门禁。
- **I4 resolved：** 明确 `total = operational + history + unknown_status_count`；删除重复的 `activity.in_progress`，只保留全局 `guarding`。
- **I5 resolved：** Git observation 固定 global concurrency=2、per-cwd=1、总 deadline=15s、单 child≤10s、hash worker=2、HEAD-change 最多重试一次。
- **I6/I7 resolved：** 直接 materializer、orchestrator、上游触发链分表记录并由 source test 锁定；Phase 2 直接删除 `allPages()/getAllWorks()`。
- **附加项：** contract 统一为 `xuanwu.work-summary.v1`；cursor 固定 strict base64url JSON 并重新应用真实 filters；unknown status 接入 health/metric；补 title/created-at keyset、显式 production roots、临时 page-level rollout flag 与移除门禁。

另经同口径复核，正文 `110,208` 是 terminal Issue 关联 events；全表 `110,218` 还包含 10 个 triage Issue 的 10 条事件，故不修改 terminal 口径，只在 v2 补充 UTC 采样时间和 read-only SQL。

## 阻断性问题

### B1. §12.1 summary payload 预算（< 64 KiB）与 §5.2 projects cap（500 项）硬冲突

§12.1 要求 `/api/works/summary` payload 在当前规模 < 64 KiB 且随历史增长不变；§5.2 允许 `projects` 最多 500 项。每项 per-project counts 序列化约 185–250 字节（`project_id` + 11 个 count 字段），500 项 ≈ 92–125 KiB，**必然超过 64 KiB 预算**。需作者裁决：

- 降低 `projects` cap（如 200），或
- 提高预算（如 < 256 KiB）并同时收紧"不随 Issue 数增长"的不变量，或
- 精简 per-project 结构（如只返回有 operational 项的 project + 顶层聚合），并明确定义截断时 Projects 页面的回退读取协议。

否则预算与 cap 无法同时满足，验收会自相矛盾。

### B3. 部署过渡缺口：存量 open Run 无 baseline marker，其 recover/continuation 将 fail closed

部署新代码时，DB 中若存在 `ended_at=''` 的 open Run（本设计之前的旧版本创建、无 baseline marker），其后续 re-enter（recover/continuation 经 `providerRuntime.ts:75/132`）将触发 §6.6 `mustGetPreparedOpenIssueRun` 的 fail-closed，导致这些存量 Run 无法继续。（注：2026-08-19 采样的 live DB 中 `ended_at=''` 为 0 行，属瞬态——open Run 是短期存在状态；但任何部署时点都可能遇到存量 open Run，且部署本身不会中断正在运行的 provider，风险限于此后对旧 Run 的再进入。）§6.7 只覆盖"本设计创建的、无 session/turn 的 reservation"恢复路径，未定义存量 Run 的过渡策略。需补：

- 一次性迁移条款（首次部署时对存量 open prepared Run 做后台 observation backfill，或显式标记 legacy-prepared），或
- 明确"无 marker 的存量 Run 在过渡期视为 prepared"的兼容窗口及其关闭条件，或
- 显式声明 fail-closed 且需人工重跑（并评估该影响的接受度）。

## 重要问题

### I1. §6.5 Phase C CAS 的 `i.status='in_progress'` 与多入口 Phase A status 转移契约未写明（原 B2，复核后降级）

§6.5 CAS SQL 要求 `i.status = 'in_progress'`，而 §6.8 声明 human review request-changes、PI acceptance recover/retry、Automation 也走 Phase A/B/C，文档未写明这些入口在 Phase A 的 status 转移。经复核现有实现，各入口在创建 Run 前都会把 status 置为 `in_progress`：human review resume 在 `createIssueRun` 同事务前 `updateIssue(...,{status:'in_progress'})`（`humanReview.ts:438-439`）；PI acceptance 的 `assertCurrentCard` 强制要求 `in_progress`（`piAcceptanceApplication.ts:360-361`）。因此忠实迁移后这些路径的 Phase C CAS 会通过，初版"永远 `claim_invalidated`"的阻断判断不成立。真实问题：若迁移实现遗漏某入口的 status 转移（或未来新增入口时忘记），Run 会静默无法 finalize。建议 §6.3 为每个入口写明 Phase A 的 status 转移规则（含 `needs_user`→`in_progress` 的时点与事务边界），并纳入测试。

### I2. §5.7 SSE reconcile 与 summary 刷新缺少节流/合并策略

当前前端有两条常驻全量读取通道：SSE onEvent 对 `ACTIVE_RECONCILE_EVENT_TYPES` 无节流地 `refreshVisibleData()`（`App.jsx:373-385`），另有 30s 固定 interval 兜底（`App.jsx:345-351`）。§5.7 只说 mutation/SSE 后 invalidate `workSummary`，未定义刷新频率与合并策略。若 SSE 事件高频（tool/MCP 生命周期事件），summary 请求仍会放大（虽比 3.8 MB 全量小，但按 §12.1 的 < 150 ms p95 预算仍是负担）。建议：

- summary/lane 刷新复用 §7.2 的 coalesce + monotonic min-interval 思路；
- 或限定只对 work 状态相关事件类型 invalidate；
- 并在 §12.1 预算中断言"SSE 突发窗口内 summary 请求数有界"。

### I3. §6.5 Phase C 防重放是 check-then-act，非 DB 原子 once

§6.5 说"相同 Run 重放时读取现有 marker 并返回 `already_finalized`，不得写第二条冲突 baseline"，这是"读 marker 再写"的应用层检查。crash 重试与 recovery 并发执行两次 Phase C 时存在竞态，可能双写 baseline event。建议把 finalize 改为原子写：

```sql
UPDATE issue_runs SET git_base_revision = :rev
WHERE id = :run_id AND issue_id = :issue_id AND attempt = :attempt
  AND ended_at = '' AND git_base_revision = ''
```

检查 `changes=1`（或为 baseline outcome event 增加唯一约束），让"只 finalize 一次"由 DB 保证，而不是依赖读后写的顺序。

### I4. §5.2 counts 守恒公式未定义，`activity` 字段语义重复

- §14.1 有"per-project counts 与全局 counts 守恒"测试，但未定义守恒公式。`unknown_status_count` 不为零时，`total` 与 `operational/history` 的关系不明。建议明确：`total = operational + history + unknown_status_count`（unknown 不进 lane 但计入 total）。
- 顶层 `activity` 含 `guarding` 与 `in_progress`，后者与 `counts.in_progress` 重复；且 per-project 项无 `activity` 字段。Projects 页面若要在项目卡上显示"进行中/guarding"数，拿不到 per-project activity。请澄清两个字段语义与 per-project 形态。

### I5. §6.4 Phase B Git observation 缺少并发度与 timeout 数值

queue claim、human review、PI retry、Automation 可同时进入 Phase B，对同一 repo（多 Project 同 cwd 或恢复重试）并发执行 `hash-object`，这是 CPU/IO 密集操作，虽然不再阻塞 DB writer，但无上限并发仍可能拖垮事件循环与磁盘。建议：

- observation 走 bounded concurrency（如 semaphore 2–4）；
- 按 `project_cwd` 单飞去重；
- 明确 Phase B 总 timeout 数值（文档只说"有总 timeout"，§12.2 预算应联动，如 10–30 s）。

### I6. §6.8 Run materialization 入口：retryIssue/forceRetryIssue 是上游触发链路，非遗漏入口（复核更正）

初版曾把 `issueActions.retryIssue/forceRetryIssue` 列为遗漏的 materialization 入口，经第二轮复核不成立：`requestIssueRun`（`issueActions.ts:133-144`）只调 `requestNewRun`（`domain/run/service.ts:426`）→ `queueIssueForRun`（`:668`，仅 `UPDATE issues SET status='todo'`）或回退 `queueIssue`，全程不触碰 `runIssueWithProvider`/`ensureOpenIssueRun`；Run 最终由 `claimNextIssue` → `createIssueRun`（`issueQueue.ts:122`）materialize，该入口已在 §6.8 清单中。HTTP 入口（`readApiDomain.ts:288`、`piSupervisorActionDispatch.ts:204`）经 `retryIssueWithInterrupt` 汇入同一链路。建议改为：

- 以"全部 `createIssueRun`/`ensureOpenIssueRun` 调用点"为准重建清单（含间接触发链，如 retry/forceRetry）；
- 用静态 source test 锁定入口全集，防止未来新增 call site 绕过 Phase A/B/C（与 §6.8 末句的依赖方向测试合并）。

（另注：`claimNextIssue` 与 `runProjectLoopOnce` 实为同一链路，后者是间接入口，单列有冗余。）

### I7. 未防 `getAllWorks()`/`allPages()` 回退路径

`work.js:65-69` 的 `getAllWorks()` 已存在且可无界拉全量，生产当前未调用（仅测试断言不使用）。§12.1 只断言"0 次 getAllWorks()"，但没有机制防止未来某页面悄悄用回它。建议与无参 `/api/issues` 同列：标记 deprecated、加 source/请求预算测试断言生产调用为零。

## 次要问题 / 建议

1. **契约命名**：文档建议 `xw.work-summary.v1`，但仓库 Work 域现有惯例是 `xuanwu.work-*`（`xuanwu.work-timeline.v1`、`xuanwu-work-shadow-v1` 等），另有 `xw.<domain>.*` 并存（`xw.execution-policy.v1`）。请明确新 contract 采用哪套，避免引入第三套命名。
2. **cursor 编码未定义**：v1 cursor 的 wire 格式（JSON + base64url?）与 decode 校验步骤未写。请补充，并重申"解码后必须重新应用当前 project/status 过滤条件"（防篡改 `value`/`issue_id` 越权翻页的 defense in depth）。
3. **§5.2 `include_projects=false` 的响应结构未示例**。
4. **unknown status 的 health warning 触发机制未定义**（systemHealth 端点？日志？metric？）。
5. **`sort=title` 与 `sort=created_at` 的 keyset 稳定性**：SQLite 默认 BINARY collation 下 title 排序跨页不稳定；候选 index `(status,updated_at,id)` 也不覆盖 `created_at` 排序的 keyset。建议固定 collation，并把 `(status,created_at,id)` 纳入 §10.2 候选评估。
6. **§8.3 显式 roots 与 audit 现状的衔接**：现有脚本隐式根 = `main.ts` + `spikes/piSmoke.ts` + `usage/benchmark.ts` + 全部 test/scripts 文件，无显式 roots 数组。文档要求的"显式 roots 数组（附 owner/用途/启动命令/test）"是新增机制；请明确 packaging 引用但不经 `main.ts` 可达的 production 文件（如 `providers/pi/xuanwuPolicyExtension.ts`，被 `package-release.sh:117` 直接 staging）必须列入显式 roots，否则可能被误判 unreferenced。
7. **§8.4 orphan fixture test 尚未实现**（当前仓库无），Phase 1 需新建。
8. **release.yml 与 package-release.sh 会重复跑 `bun test`**；§8.2 已声明 defense in depth 有意为之，建议注明重复成本已评估。
9. **§2.1 live 数字已过时**：issue_events 实测 110,218（文档 110,208，差 10，事件持续增长）；建议标注采样时间与只读复核命令（`sqlite3 "file:$HOME/Library/Application Support/xuanwu-bun-live/state/runner.db?mode=ro" ...`）。
10. **§0 版本记录**：增加 v2（本次 review 修订记录）。
11. **前端迁移灰度**：现有 `WORK_BOARD_ENABLED` feature flag（`App.jsx:27/87/218`）是先例；建议 summary/board 迁移同样带 flag 或按页灰度，避免一次性大切换。
12. **§7.1 现状补充**：当前 refresh 均为 fire-and-forget（`jsonRpc.ts:204/280` `.catch(()=>{})`），扫描失败静默吞掉；文档应把"显式失败结果 + 不把 failure 冒充空进程"列为明确的现状修复项，并补充 scan-failure metric（§7.6 已有 `scan_failed_total`，但需在失败语义表 §11 中明确普通 observation 的失败分支）。

## 已核验的正面事实

- **§2.1 live 数字**：`848|750|88|10|913` 与只读 sqlite3 实测完全一致；DB 主文件 661,581,824 B ≈ 630.9 MiB 一致；`automation_execution_links` 存在 `on delete restrict` FK（`schema/049:11-12`），支持 §9.1 级联风险论述。
- **§2.2 调用链**每环属实：`dataStore.js:16-20/65`、`workApi.getIssues`、`App.jsx:63-64` PAGE_DATA_SLICES、`readApiRoutes.ts:44`、`readApiDomain.ts:95/262-277/282`、`issues.ts:69-83` 宽列 + `attachLatestRuns`（:219-246）、`readIssueDecisionProjection`（`humanReview.ts:193-208`）。
- **§2.3 createIssueRun 内含 Git I/O 且在 immediate txn 内**属实：`issueRuns.ts:53-54` `Bun.spawnSync git rev-parse`、`runGitWorkspaceBaseline.ts:167`（git status）+ `:190-191`（hash-object）、`issueQueue.ts:23-24` `claim.immediate()` 内同步执行；candidate 选择纯 DB（`nextIssueRow` 依赖 `readProjectIssueDependencies`）。
- **§2.4 Codex 断言**属实：`jsonRpc.ts:204` request finally refresh、`:280` 结构事件 refresh、`processLifecycle.ts:101-105` 每次扫描更新 `observed_at` 并 `persist`（无 fingerprint 比较）、`:264` `ps -axo pid=,ppid=,pgid=,rss=,command=` 命令吻合、stop/exit 已有 refresh + 二次 live inspect（:111/:115）。
- **§2.5 hygiene 缺口**属实：`release.yml` 无 hygiene 步骤；`package-release.sh:171-184` preflight 无 hygiene；`release-compliance.test.mjs` 只断言 ci.yml 含 7 个 gate；`node scripts/repository-hygiene-audit.mjs --json` 实测 ok=true（7/7 checks）。
- **§6.8 入口清单**基本属实（retry/forceRetry 属上游触发链，见 I6）：`issueQueue.ts:122`、`humanReview.ts:439`、`piAcceptanceApplication.ts:144/248`、`automationWorkRunExecutor.ts:137`、`providerRuntime.ts:75/132`；`ensureOpenIssueRun` 隐式创建属实（`issueRuns.ts:75-78`）。
- **§6.7/§6.3 依据成立**：unstarted open Run recovery 存在（`runner/recovery.ts:23` recoverInProgressIssues，unstarted 判定 `:42/:50`、session/turn 检查 `:128` → `requeueUnstartedIssueClaim` `issueActions.ts:36-42`）；project execution lock 存在（`issueQueue.ts` `hasActiveExecutorWorkForProject`，按 cwd/project 键）。
- **§7 提议均为全新概念**：interval throttle、coalesced/force mode API、fingerprint unchanged no-write、generation fence、定时器版 trailing timer、5s active fallback、async ps；已有雏形为 `drainRefresh` 微任务合并 + 立即 trailing（`processLifecycle.ts:88-96`）与 stop/exit fresh scan。
- **§5.3 board 现状属实**：`workApi.ts:190-196` 对每个 `WORK_STATUSES` 以 `{limit:pageSize, offset:0, statuses:[status]}` 读 first page。
- **认证**：`auth.ts:40` `requireBearerAuth` 保护所有 `/api/*`（feishu/webhook 排除在 `:172-173`），新 summary/cursor route 走同一 `createRequestHandler` 天然继承隔离。

## 已发现的事实修正（相对原文）

1. **§2.1 issue_events 数字过时**：实测 110,218 ≠ 原文 110,208（差 10）。
2. **§2.4 "只有 single-flight 无节流"**：基本属实，但已有 `drainRefresh` 微任务级合并（`processLifecycle.ts:88-96`），文档可注明以现有行为为基线。
3. **§6.8 claimNextIssue 与 runProjectLoopOnce 为同一链路**，单列有冗余（见 I6）。
4. **§2.5 状态描述已过时**：audit 脚本实际用"隐式根"（main.ts + spikes/piSmoke.ts + usage/benchmark.ts + 全部 test/scripts 文件），无显式 roots 数组、无目录 allowlist、无 glob 例外；文档称"旧的 telegram.ts 已不存在"属实。

## 核验方法

- 4 个并行只读探索代理（`subagent_type: default`，`inherit_context: false`）分别核查 Read path / Run 两阶段（含 live DB 只读抽样）/ Codex lifecycle / Hygiene-release；其中 2 个因 provider 503/429 失败，已重派并取得完整结果。
- 主代理沿关键 file:line 抽查复核：`processLifecycle.ts:101-105`（observed_at 每次更新 + persist）、`issueRuns.ts:75-78`（ensureOpenIssueRun 隐式创建）、`workApi.ts:190-196`（board 每 status 读 first page）、`package-release.sh:171-184`（preflight 无 hygiene）、live DB 数字。
- 第二轮独立复核（`subagent_type: reviewer`，qwen3.8-max）：B1 成立（数字修正为 11 字段 / 92–125 KiB）；B2 经 `humanReview.ts:438-439`、`piAcceptanceApplication.ts:360-361` 证实为过度断言，降级为 I1；retry 入口经 `issueActions.ts:133-144` → `requestNewRun`（`domain/run/service.ts:426`）→ `queueIssueForRun`（`:668`）核实为上游触发链路，改写为 I6；B3 经 live DB 实测 `ended_at=''`=0 行收窄措辞；6 处行号已勘误（runGitWorkspaceBaseline、processLifecycle、auth、recovery、App.jsx、issueRuns 微调）。
