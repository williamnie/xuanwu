# PI 运行时代码审查

> 审查范围：分支 `feat/bun-ts-pi-runtime` 最近 5 个 commit 的 PI 运行时新逻辑
> （`backend-ts/src/pi/`、`backend-ts/src/runner/`、`backend-ts/src/schedule/`、`backend-ts/src/http/`）。
> 分支相对 `main` 共 445 个文件改动，但绝大多数是 Go→Bun/TS 的机械迁移，本次高强度审查聚焦在含新逻辑、最易藏 bug 的 PI 运行时部分。
> 审查日期：2026-06-03

## 结论速览

整体质量不错：审计时间线、动作门禁、`activeXxx` 幂等守卫设计完整，测试覆盖到位。
以下为按严重度排序的潜在问题，**第 1 条为功能性硬伤，建议优先修复**。

| # | 严重度 | 位置 | 问题 |
|---|--------|------|------|
| 1 | 🔴 严重 | `piProjectControlApi.ts:203` / `actionGate.ts:48` / `piSdkToolAudit.ts:31` | 托管周期封掉 agent 自己的 `read/grep/find/ls` 工具 |
| 2 | 🟠 中-高 | `piProjectControlApi.ts:88-90` | `runProjectPiCycle` 的 409 并发保护存在 TOCTOU 竞态 |
| 3 | 🟠 中 | `cronSchedule.ts:118-128` | 周/月调度在停机后会漂移到错误的星期/日期 |
| 4 | 🟠 中 | `heartbeatOrchestrator.ts:40-48` | 单个坏 delegation 会中断整批心跳 + 自动托管 |
| 5 | 🟡 低-中 | `issueStateManager.ts:198` | `policyEvidence` 在 Invalid Date 上会抛 RangeError |
| 6 | 🟡 低-中 | `issueStateManager.ts:225` | `latestActivity` 字典序排序混合精度时间戳会选错"最新" |
| 7 | 🟡 低 | `cronSchedule.ts:50-58` | `今晚/今天` 的 once 任务可能生成过去时间 |
| 8 | 🟡 低 | `issueStateManager.ts:37,179` | `hasVerificationEvidence` 正则过宽导致漏报 |

---

## 🔴 1. 托管周期（delegated 模式）会把 PI agent 自己的 `read/grep/find/ls` 工具直接封掉

**调用链：**

- `piProjectControlApi.ts:203` `managerCycleAuthorization()` 返回的授权信封**只列了**
  `issue.list/read/state_diagnose`、`project.list/status`、`session.list/read_summary`，且 `mode: "delegated"`。
- `piRuntime.ts:81` 把内置只读工具 `["read","grep","find","ls"]`(`PI_ALLOWED_TOOLS`) 暴露给 agent；
  `piRuntime.ts:91` 又用**同一个 delegated 授权**安装 `installPiSdkToolAudit`。
- `actionGate.ts:48-52` delegated 模式是**纯白名单**：凡不在 `authorizedActions` 内的动作一律 `deny`
  （`runnerActionGate.test.ts:33` 已将该语义钉死）。`sdk.read/grep/find/ls` 不在白名单。
- `piSdkToolAudit.ts:31` 一旦 gate 决策不是 `execute`，`beforeToolCall` 直接 `return { block: true }`。

**后果：** 自动托管 / `run-once` 的 manager cycle 一旦让 agent 读文件、grep、ls，全部被硬拦截。
而 prompt(`piProjectControlApi.ts:232`) 明确写着 "execute only safe read/comment tools"——设计意图是允许读，
实际却被门禁封死，agent 等于被蒙住眼睛。`memory.search` / `memory_write_candidate` 同理也会返回 `denied`（只是不抛错）。

**修法建议（二选一）：**
- 在 `gatePiActionEnvelope` 的 delegated 分支对 `SAFE_ACTIONS` 永远放行；或
- 在 `managerCycleAuthorization` 里补上 `sdk.read/grep/find/ls`、`memory.search`、`memory.write_candidate`。

---

## 🟠 2. `runProjectPiCycle` 的 409 并发保护存在 TOCTOU 竞态

`piProjectControlApi.ts:88-90`：

```ts
if (activeProjectPiRuns.has(project.id)) throw new HttpError(409, ...); // 同步检查
const state = await createManagerCycleState(...);                       // await，让出事件循环
activeProjectPiRuns.set(project.id, state.runtime.session);             // 之后才登记
```

检查在 `await` 之前、登记在 `await` 之后。两个 `run-once` 请求几乎同时到达时，都能通过 `has()` 检查，
于是**同一 project 并行跑两个 manager cycle**。

**修法建议：** 在 `await` 之前同步占位（先占坑再创建 runtime），失败时回滚占位。

---

## 🟠 3. 周/月调度在停机后会漂移到错误的星期/日期

`cronSchedule.ts:118-128` `normalizeCandidate` 的追赶逻辑**每次只 +1 天**：

```ts
for (let i = 0; i < 370 && candidate.getTime() <= now.getTime(); i += 1)
  candidate = addZonedDays(candidate, 1, ...);
```

`nextRunAfter` 对 weekly 先 `+7 天`、monthly 先 `+1 月`(`advanceParts`)，但只要 runner 停机超过一个周期、
结果仍 `<= now`，后续就被这段按天追赶——weekly 任务会落到**错误的星期几**、monthly 落到**错误的日子**。
日常运行（没漏跑）无问题，漏跑后才暴露。

**修法建议：** 追赶应按任务周期推进，而非按天。

---

## 🟠 4. 单个坏 delegation 会让整批心跳 + 自动托管都中断

`heartbeatOrchestrator.ts:40-48` 的循环里 `await runPiHeartbeatOnce(...)` 没有 try/catch，
而 `heartbeatContext`(`heartbeatOrchestratorSupport.ts:13-14`) 在 project 不存在时会 **throw**。
只要有一个 active delegation 指向已删除的 project，整个 `runDelegationHeartbeatsOnce` 直接 reject，
后面所有 delegation 不再处理；更糟的是 `piAutoManageScheduler.ts:88-89` 里它排在 `runPiAutoManageCycle` 之前，
连带把这一 tick 的自动托管也跳过。

**修法建议：** 对每个 delegation 单独 try/catch，单条失败不影响整批。

---

## 🟡 5. `policyEvidence` 在 Invalid Date 上会抛 RangeError

`issueStateManager.ts:198` `iso(new Date(next))`，其中 `next = nextRetryAt(...)`。
当 `issue.auto_retry_next_at` 与 `issue.updated_at` 都解析失败时，`parseTime` 返回 `POSITIVE_INFINITY`，
`new Date(Infinity).toISOString()` 抛 `RangeError: Invalid time value`，使整个 `diagnoseIssueState` 崩溃。
正常持久化的 issue 不会触发，属潜在崩溃点。

**修法建议：** 对非有限值兜底（如回退到 `now` 或空串）。

---

## 🟡 6. `latestActivity` 字典序排序混合精度时间戳会选错"最新"

`issueStateManager.ts:225` `[...].filter(Boolean).sort().at(-1)`。
当各来源时间戳格式不一致（有的带毫秒 `.500Z`、有的不带），字典序会把 `...00.500Z` 排在 `...00Z` 之前——
选出的"最新活动时间"可能反而更早，导致 staleness 时长算错。

**修法建议：** 按 `Date.parse` 数值排序而非字符串排序。

---

## 🟡 7. `今晚/今天` 的 once 任务可能生成过去时间

`cronSchedule.ts:50-58`：现在 22:00 时解析"今晚8点"，`todayParts` 给出今天 20:00（已过去），
cron executor 会立刻触发。语义上更可能应顺延或拒绝。

---

## 🟡 8. `hasVerificationEvidence` 正则过宽导致漏报

`issueStateManager.ts:37,179` `VERIFY_PATTERN` 含 `test/build/lint` 等词，
任何事件 payload 出现这些子串都会被判为"有验收证据"，从而漏报 `done_missing_verification_evidence` 诊断。
