# 玄武（Xuanwu）代码整体评估

- 日期：2026-08-04
- 范围：`backend-ts/src`（639 个源文件 / 374 个测试文件）、`frontend/src`（330 个文件）、`backend-ts/src/db/schema`（68 个迁移）
- 方法：静态阅读 + 调用链追踪。所有结论都给出 `文件:行号` 证据；未做压测，性能结论按"每次调用做了什么工作"推导。
- 状态：评审记录，不是 canonical 规范。不授权 schema/route 变更，仅作为改进输入。

---

## 0. 总体判断

这个项目的**工程纪律明显高于平均水平**：测试覆盖密集（374/639 ≈ 0.59 的测试文件比），issue.log 有显式写入预算与截断标记，子进程有 process-group 归属文件与重启对账，有脱敏注册表，调度器在阶段之间主动让出事件循环并对慢阶段告警，ADR 体系完整。

但存在一类**系统性的架构缺陷**，集中在同一个模式上：

> **在同步路径（尤其是持有 SQLite 写事务时）执行 `spawnSync` 子进程与文件 IO。**

Bun 是单线程事件循环 + SQLite 是单写者。这两个约束叠加时，一次 `spawnSync` 不只是"慢"，它会同时冻结 HTTP 服务、SSE 推送、调度器，并把 SQLite 写锁一直握着。由于 reader 连接的 `busy_timeout` 只有 50ms（`db/database.ts:17`），锁一旦被握住超过 50ms，**整个读 API 会返回 503**（`http/errors.ts:47-49`）。

第二类问题是**读路径的复杂度失控**：`GET /api/issues` 无分页 + 每项目 O(N²) 依赖图 + 每 Issue 多次 N+1 查询，而前端每 30 秒 + 每个生命周期 SSE 事件都会调用它。

第三类是**数据只增不减**：`issue_events` 的保留/压缩逻辑只在 CLI 里可达，运行时没有任何调度调用它。当前实例 `data-bun/runner.db` 已 186MB。

下面按严重度排列。

---

## 1. P0 — 严重，建议优先修

### P0-1. Issue 认领在 SQLite 写事务内 fork 大量 `git` 子进程

**调用链**

```
claimNextIssue                     db/repositories/issueQueue.ts:22-24   ← db.transaction(...).immediate()
  └ claimNextIssueID                                          :109-125
      └ createIssueRun             db/repositories/issueRuns.ts:20-47
          ├ currentIssueProjectRevision                       :49-65    → Bun.spawnSync(git rev-parse)
          └ recordIssueRunGitWorkspaceBaseline
              └ workspaceEntries   domain/evidence/runGitWorkspaceBaseline.ts:166-187
                  ├ Bun.spawnSync(git status --porcelain -z --untracked-files=all)   :167-175
                  └ worktreeObjectID  ——— 对**每一个**变更/未跟踪文件           :182, 189-198
                        └ Bun.spawnSync(git hash-object --no-filters -- <path>)
```

**问题**：`workspaceEntries` 对 `git status` 返回的每一条目都单独 fork 一次 `git hash-object`。一个有 300 个未跟踪文件的工作区 = **300 次同步 fork**。按每次 5–15ms 计，就是 **1.5–4.5 秒的事件循环完全冻结**，而且这段时间 SQLite 的 IMMEDIATE 写事务一直开着。

**后果链**：
- writer `busy_timeout = 250ms`（`db/database.ts:16`）→ 其他写入直接 SQLITE_BUSY；
- reader `busy_timeout = 50ms`（`db/database.ts:17`）→ 非 WAL 模式下读者被写锁挡住，50ms 后失败；
- `http/errors.ts:47-49` 把它翻译成 **HTTP 503 "database temporarily busy"**。

也就是说：**每次认领一个 Issue，整个 Web 控制面会有数秒不可用。** 代码里 `isSqliteContention` 的快速失败逻辑（`http/router.ts:42-50`）实际上是在给这个自伤问题打补丁。

**修法**（按性价比排序）
1. 用 `git hash-object --stdin-paths` 一次性处理全部路径 —— 300 次 fork 变 1 次；或直接从 `git status --porcelain=v2` 的 `<mH> <mI>` 字段拿 OID，零额外 fork。
2. 把 baseline 采集移出事务：事务内只做 `insert into issue_runs`，baseline 作为异步 Evidence 事件后补。
3. 把 `git` 调用改成 `Bun.spawn` + await，让事件循环能被其他任务复用。
4. 顺带：`createIssueRun` 里 `issueProjectCwd` 被查了两次（`issueRuns.ts:24` 和 `:50`）。

---

### P0-2. 每一条 provider 事件都 `spawnSync("ps -axo …")` 并原子写一次文件

**调用链**

```
CodexStdioJsonRpcTransport.deliverEvent   providers/codex/jsonRpc.ts:269-276
  └ processLifecycle.refresh(...)                          :271        ← 每条事件
      ├ ownedTree → inspect → inspectProcessTable  providers/codex/processLifecycle.ts:124-130, 216-220
      │     └ Bun.spawnSync(["ps","-axo","pid=,ppid=,pgid=,rss=,command="])
      └ persist()                                                      :102-112
            └ mkdir + writeFile(tmp) + chmod + rename
```

`request()` 的 `finally` 也调一次（`jsonRpc.ts:196`）。

**问题**：Codex/Claude 一个 turn 会推送**成百上千条** `item/agentMessage/delta`、`item/commandExecution/outputDelta` 等流式事件。每一条都会：
1. 同步 fork 一个 `ps`，拉取**整机进程表**，再用正则逐行解析（`processLifecycle.ts:222-232`）；
2. 做一次 mkdir + 写临时文件 + chmod + rename 的原子落盘。

macOS 上进程表通常 400–800 行，一次 `spawnSync ps` 保守 3–8ms。1000 条事件 = **3–8 秒纯阻塞**，叠加上千次文件写。

值得注意的是团队**已经意识到这个模式的代价**——`runtime/core.ts:63-65` 的注释专门说明内存观察器改用了非挂起的 `proc_pid_rusage`，"keep process discovery allocation-free on the HTTP loop"。但 provider 事件路径仍然走 `ps`。

**修法**
- 给 `refresh()` 加节流：每 1s 最多刷新一次（进程树在两条 delta 之间不会变）。
- 或复用 `ProcessGroupMemoryObserver` 已有的 1s 采样结果（`observability/processGroupMemory.ts:108`），不要再独立探测。
- `persist()` 改为合并写：脏标记 + 定时落盘，而不是每次调用都原子重写。
- 附带：`ownedTree`（`processLifecycle.ts:184-198`）是 `while(changed)` 全表重扫，最坏 O(n²)；改成按 ppid 建邻接表一次 BFS。

---

### P0-3. `GET /api/issues` 无分页 + O(N²) 依赖图 + 多重 N+1

**路由**：`http/readApiRoutes.ts:39` → `issueFilter`（`:140-147`）**只解析 projectId / sourceSessionId / status，不解析 limit / offset**。
→ `issuePagination`（`db/repositories/issues.ts:213-217`）在 limit/offset 均为 undefined 时返回空 SQL
→ 最终 SQL 是 `select <全字段> from issues [where …] order by …`，**没有 LIMIT**。

然后 `publicIssues`（`http/readApiDomain.ts:258-268`）在每个 issue 上继续放大：

| 层 | 位置 | 每次调用的代价 |
| --- | --- | --- |
| 依赖图（每项目一次） | `domain/work/issueDependency.ts:71-83` | 拉取该项目**全部** issue（无状态过滤、无 limit）+ 全部 `work_relations` |
| 逐 issue 图遍历 | `issueDependency.ts:108-147` | 每个 issue 各跑一次 `findReachableCycle` DFS（`:178-198`）+ `collectRootBlockers`（`:166-176`）→ 整体 **O(V·(V+E))** |
| 逐 issue readiness | `domain/readiness/contracts.ts:112-148` | 每个有依赖的 issue：`getIssue` 1 次 + `issue_events` 查询 1 次 + `directDependencyWorkIDs` 1 次 + 每条 requirement 再 1 次 |
| 逐 issue 决策投影 | `domain/review/humanReview.ts:148-171` | 每个 issue ≥3 次查询（`mustGetIssue` 还把已在手的 issue 又查了一遍） |

**`collectRootBlockers` 还有额外风险**：它每层递归都 `new Set(path)` 复制路径集合（`:173`），且没有跨调用记忆化。菱形依赖会指数级重复展开；深链会栈溢出（`findReachableCycle` 同样是递归）。

**前端每 30 秒调一次，外加每个生命周期 SSE 事件都调一次**（`frontend/src/store/dataStore.js:19`、`frontend/src/App.jsx:335,352-364`），且从不带分页参数（`frontend/src/api/work.js:95-101`）。

**修法**
1. `issueFilter` 解析 `limit`/`offset`，服务端设默认上限（如 200）并返回 total。
2. `readProjectIssueDependencies` 只对**本次返回的 issue 集合**求值，不要对全项目求值。
3. `collectRootBlockers` / `findReachableCycle` 改迭代 + memo；把 `path` 复制换成"进入时 add、退出时 delete"。
4. `readIssueDecisionProjection` 接受已加载的 `Issue` 对象，去掉 `mustGetIssue`；`humanReviewRequests` + `readPiAcceptanceActivity` 批量按 issue_id IN (...) 一次取回。

---

## 2. P1 — 高

### P1-1. 同一份依赖图在一次调度 tick 内被重复计算多次

`nextIssueRow`（`db/repositories/issueQueue.ts:144-155`）本身就是三重放大：

```ts
const dependencyByIssueID = readProjectIssueDependencies(db, projectID);   // 全项目 O(N²)
const rows = db.sqlite.query(`select id from issues where project_id=? and status=?
  order by priority desc, created_at asc, id asc`).all(...);              // 无 LIMIT
return rows.find((row) => {
  if (dependencyByIssueID.get(row.id)?.ready !== true) return false;
  const issue = getIssue(db, row.id);                                     // N+1
  return issue !== null && filter(issue);
});
```

而它的调用方还会再乘一层：

- `projectLoopDecision` 一次调用里 `peekNextReadyIssue` 被调用 **2 次**（`runner/projectLoop.ts:66` 和 `:78`）；
- `shouldContinue` 每轮循环调用 `projectLoopDecision`（`runner/projectLoopManager.ts:117-120`）；
- `requeueProjectsWithTodo` 对**每个 auto_run 项目**调用（`:137-149`）；
- `nextRunnableProject` 对**每个等待中项目**调用（`:174-194`）。

且 `filter` 传的是 `issueProviderAvailable` → `issueProviderID` → `resolveExecutorSelection(db, project, issue)`，又是每候选一次 DB 访问（`runner/projectLoop.ts:189-215`）。

**修法**：每个 tick 开头算一次依赖图，向下透传；`select id from issues` 加 `limit`；把 provider 可用性判断提到候选循环之外（provider 集合在一个 tick 内不变）。

### P1-2. SSE 流在 controller 出错时泄漏订阅与心跳定时器

`http/events.ts:21-36`：

```ts
const write = streamWriter(controller, () => closed);
heartbeat = setInterval(() => write(comment("heartbeat")), heartbeatMs);
while (!closed) {
  const event = await subscription.next();
  if (event) write(data(event));
}
```

`streamWriter`（`:47-52`）只判断 `closed`，**不判断 controller 是否已 errored**。一旦 `controller.enqueue` 抛出，异常从 `start()` 的 `while` 里逃逸，`cancel()` 不会被调用 → `clearInterval(heartbeat)` 不执行、`subscription.close()` 不执行 → 该订阅者**永久留在 `EventBus.#subscribers` 里**继续接收并缓冲事件。

对照 `http/piConversationApi.ts:369-377`，那里的 `enqueue` 是包在 try/catch 里并在失败时 `clearHeartbeat()` 的 —— 同一个项目里两种写法，`events.ts` 是漏的那个。

**同一文件的另两个问题**：
- **没有背压**：从不检查 `controller.desiredSize`。慢客户端会让流的内部队列无限增长。
- **静默丢事件**：`events/bus.ts:41` 缓冲满 64 条后 `shift()` 丢最老的，不发 gap 标记。SSE 消费者无法感知自己丢了事件。

**修法**：`write` 加 try/catch，失败即 `closed = true` + 清理；`start()` 外层加 try/finally 兜底清理；缓冲溢出时推一条 `{type:"stream.gap", dropped:n}`。

### P1-3. 每个 `/api/` 请求都从磁盘读一次 token 文件

`http/server.ts:229-231`：

```ts
configuredToken = typeof authToken === "string"
  ? authToken
  : isApiPath(request) ? await authToken.refresh() : authToken.current();
```

`refresh()` 就是 `readFile(path, "utf8")`（`http/auth.ts:109-118`）。**每个 API 请求 = 一次文件系统读**。

同一请求还会解析 `new URL(request.url)` 约 5–6 次：`applyLocalCors`、`isApiPath`（×2）、`requireBearerAuth → isApiRequest`、`isPublicIntegrationCallback`、`router.dispatch`。URL 解析不便宜。

**修法**：token 用 mtime 或 `fs.watch` 失效，`rotate()` 时主动更新内存值；每请求解析一次 URL 并向下传递。

### P1-4. `issue_events` 运行时只增不减

保留与压缩服务确实存在且写得不错，但**只有 CLI 能触发**：

```
events/maintenanceService.ts        ← deleteIssueEventBatch 等
events/payloadCompactionService.ts
        ↑ 唯一调用方：cli/maintenance.ts:10, 23
```

`runtime/core.ts` 里没有任何调度器调用它们。同时 `BackgroundProjectionWorker`（`events/projectionWorker.ts`）在持续**往 `event_summary_projection` / `compact_event_summary_projection` 写派生行**。净效果是单调增长。

当前实例：`data-bun/runner.db` = **186MB**；`data/app.db` = 179MB。

`issue_events` 上只有两个索引：`(issue_id, type)`（`schema/001_base_schema.ts:80`，`schema/005` 重复定义了一次）和 `(issue_id, id desc)`（`schema/056_issue_log_mode.ts:9`）。没有 `created_at` 索引，`listMaintenanceEvents` 的 `e.created_at < ?` 只能扫。

**修法**：把保留策略接到 Automation/heartbeat 上定期跑；或在 `projectionWorker` 的空闲窗口顺带做小批量裁剪；给 `issue_events(created_at)` 加索引。

### P1-5. 请求处理器里对最大的表做全表扫描 + `json_extract`

`http/evidenceApi.ts:80-83`：

```sql
select count(*) as count from issue_events
where type=? and json_valid(payload) and json_extract(payload,'$.evidence.id')=?
```

`type` 单独没有索引（复合索引是 `(issue_id, type)`，前缀不匹配），所以这条 SQL 会**扫遍 `issue_events` 并对每一行做 JSON 解析**。在 186MB 的库上，每次 `POST /api/issues/:id/evidence/readiness` 都付这个代价。

**修法**：加 `issue_events(type, id)` 索引；或者更好的做法是给 evidence id 建一张独立索引表，别在事件表上做 JSON 谓词。

---

## 3. P2 — 中

### P2-1. 路由表线性扫描，且每次比较都重新切分字符串

`http/router.ts:34-53`：240 条已注册路由（全仓 `router.<method>(` 计数）。每个请求 `routes.find(...)` 逐条调用 `routeMatches`，而 `routeMatches`（`:73-79`）对**pattern 和 path 都**执行 `normalizePath` + `split("/")` + `filter(Boolean)`。404 时 `allowedMethods`（`:63-65`）再全表扫 5 遍。

**修法**：注册时预切分 segments；按 `method + segment 数量` 分桶。

### P2-2. 每次启动重放 28 个迁移

`db/migrations.ts:77-81` 的 `repairKnownSchemaDrift` 在**每次启动**、在迁移事务内，把 `REPAIRABLE_MIGRATION_IDS`（`:15-44`，28 个）全部重新 apply 一遍。

除了冷启动成本，这本身是个设计味道：用"每次重放"来兜底 schema 漂移，而不是定位漂移来源。建议把它降级成一次性修复迁移 + 启动时的只读一致性校验。

### P2-3. issue.log 采样路径上对完整 payload 做 `JSON.stringify`

`runner/issueLogPersistence.ts:555-565` 的 `eventFingerprint` 把**整个 raw payload** 序列化，只为做变更检测。而被采样的 method 里就包含 `turn/diff/updated`（`:21`）——那是完整 diff。

同文件其他热点：
- `boundedUtf8`（`:524-530`）即使没超限也会 `Buffer.from(value)` 全量复制一次，且在多处每事件调用；
- `push` 里 `[...samples.values()].some(...)`（`:199`）每条采样事件都分配一个数组；
- `chunkKey` / `sampleKey`（`:532-553`）每事件各一次 `JSON.stringify`。

**修法**：fingerprint 换成增量 hash（如对 payload 长度 + 前后若干字节做 FNV/xxhash）；`boundedUtf8` 先用 `value.length <= byteLimit` 快速返回。

### P2-4. 预算超限时从 provider 事件回调里抛异常

`runner/issueLogPersistence.ts:287`：

```ts
throw new Error(`issue.log protected event budget exceeded for ${method}`);
```

fail-closed 的意图可以理解，但从流式事件回调里抛异常是很脆的表达方式——异常会沿着 `deliverEvent` → `onEvent` 往上跑，最终落在哪个 catch 里取决于 provider 接线。建议改成返回结构化的 `{dropped: true, reason}` 并由调用方决定是否终止 Run。

### P2-5. 运行时不启用 WAL，而 busy_timeout 极短

`db/database.ts:78-83` 的 `configureWalConnection` **只在数据库已经是 WAL 时**才设置 `synchronous`/`wal_autocheckpoint`；注释明确说 WAL 切换只由审计过的维护命令做。

如果实例仍在 rollback-journal 模式，那么**读者和写者互相阻塞**。配合 writer 250ms / reader 50ms 的 `busy_timeout`，再叠加 P0-1 的秒级写事务，503 是必然结果。

**建议**：把 WAL 切换纳入标准安装/升级流程（它是幂等的单次操作），并把 reader 的 `busy_timeout` 提到 1–2s。

### P2-6. "全量取回再在 JS 里过滤"的模式

- `openIssueRunID`（`runner/projectLoop.ts:255-257`）：取该 issue 的**所有** run，再 `.filter(ended_at === "").at(-1)`；
- `issueExecutionNoLongerCurrent`（`:248-253`）：同样取全部 run 再 `find`；
- `ensureOpenIssueRun`（`db/repositories/issueRuns.ts:76`）：同上；
- `hasOpenIssueRun`（`http/readApiDomain.ts:317-319`）：同上。

都可以改成 `where issue_id=? and ended_at='' order by attempt desc limit 1`。

### P2-7. 未分批的 `IN (?,?,…)` 参数展开

`db/repositories/eventMaintenance.ts:86-100` 的 `currentIssueEventRows` 直接把 `ids.length` 个占位符展开；而同文件的 `countExistingIssueEvents`（`:104-115`）**正确地**按 500 分批。前者存在触碰 SQLite 变量上限的隐患。

---

## 4. 前端

### F-1. 每次 reconcile 拉全量 issue 列表，然后逐条算签名

`store/dataStore.js:19` → `workApi.getIssues()` → `/api/issues` **不带任何分页参数**（`api/work.js:95-101`）。

拿回来之后 `sameIssues`（`utils/stateGuards.js:91-93`）对**每个 issue 的 26 个字段**拼接签名字符串做比较——字段里包含 `description`、`source_excerpt`、`workflow_snapshot_json`、`error`（`:19-44`）。也就是每 30 秒把全部 issue 正文在主线程上再拼一遍字符串。

### F-2. `Issues.jsx` 零 memo、零虚拟化

`pages/Issues.jsx`（629 行，看板）里 `useMemo` / `useCallback` **出现 0 次**（对比 `Sessions.jsx` 19 次）。全仓也没有任何虚拟化库。

看板上每个 state 变化都会重渲染全部卡片。`handleDragOver`（`:149-154`）虽然做了相等性保护，但拖拽期间仍会频繁触发整树重渲染。

### F-3. SSE → 刷新没有防抖，且刷新之间没有去重

`App.jsx:352-364`：收到 `ACTIVE_RECONCILE_EVENT_TYPES` 里的事件就立即 `refreshVisibleData()`，没有 trailing debounce。一批 issue 同时变更 = 一批立即的全 slice 重新拉取。

`dataStore.js:82-122` 的 `refreshData` 也**没有 in-flight 去重**：30 秒定时器与 SSE 触发可以并发，多个请求竞态，最后 resolve 的覆盖先前结果——可能写回旧数据。

好的一面是事件类型选得克制（只有生命周期事件，不含流式 delta，`App.jsx:46-59`），所以量级可控。

### F-4. 小问题

- `setPageContext`（`App.jsx:264-271`）每次调用都对 state 做 `JSON.stringify` 比较。
- `dataStore.js:25` automations slice 的 `same` 直接 `JSON.stringify` 全量比较。

---

## 5. 设计层面的观察

### 5.1 HTTP 层扁平化膨胀

`http/` 下约 60 个非测试模块、240 条路由、39k 行，其中 `pi*` 前缀独占约 30 个模块。所有模块最终都注册进同一个扁平 router，没有中间件、没有路由分组、没有统一的 context 注入。`createDefaultRouter`（`http/server.ts:69-150`）是一长串 `if (runtime.database) register…`。

这不是"必须马上改"的问题，但它是 P2-1（线性路由扫描）和"每请求 6 次 URL 解析"的根因——没有一层能承载"解析一次、复用多次"。

### 5.2 未完成的领域重命名

代码里同时活着两套词汇：`issues`/`work`、`sessions`/`runs`、`pi`/`supervisor`。为此存在大量兼容层：

- `http/legacyCompatibilityApi.ts`、`http/frontendCompatApi.ts`、`http/frontendCompatHandlers.ts`、`http/automationLegacyRedirectsApi.ts`
- `domain/work/issueAdapter.ts` 的 `issueIDToWorkID` / `workIDToIssueID` 双向翻译，在依赖图里被高频调用（`issueDependency.ts:86-93,109-117`）
- 68 个迁移里包含 `030_remove_legacy_notification_settings`、`051_remove_production_fixtures`、`052_consolidate_pi_decision_layers`、`053_drop_legacy_automation_tables`、`055_collapse_pi_agents_to_supervisor`、`058_drop_issue_templates`

每条读路径都在为这个未完成的迁移付翻译成本。`docs/architecture/README.md` 已经把这件事文档化得很清楚，但代码侧的收敛还没做完。建议把"完成重命名"当成一个有明确 exit criteria 的独立 issue，而不是持续叠加兼容层。

### 5.3 读写连接分离做对了

`runtime/core.ts:44-45` 开了独立的只读连接，`http/readApiRoutes.ts:12-13` 确实让读 handler 走 `readDatabase`。这是正确的。**但前提是数据库处于 WAL 模式**——见 P2-5。非 WAL 下这个分离拿不到任何隔离收益，只是多了一个连接。

### 5.4 值得保留的做法

以下几点做得比大多数同类项目好，改动时不要破坏：

- **issue.log 写入预算**（`runner/issueLogPersistence.ts`）：分 delta/sample/lifecycle/protected 四类预算，超限写显式 truncation marker 而不是静默丢弃。
- **子进程归属与重启对账**（`providers/codex/processLifecycle.ts`）：ownership 文件 + `reconcileStaleCodexProcessOwnership` + 进程组信号，比"kill by pid"稳健得多。
- **调度器主动让出**（`runner/piAutoManageScheduler.ts:357-369`）：阶段间 `Bun.sleep(0)`，慢阶段 ≥250ms 打 `runner.schedule_phase_slow` 告警。这个机制已经就位，P0-1/P0-2 修完后它会更有效。
- **脱敏**（`util/redact.ts` + `security/redactionRegistry.ts`）在错误、日志、状态输出上一致应用。
- **测试密度**：374 个测试文件，且迁移本身也有测试（`schema/066_pi_context_memory_authority.test.ts`）。

---

## 6. 建议的修复顺序

| 顺序 | 项 | 预期收益 | 大致工作量 |
| --- | --- | --- | --- |
| 1 | P0-2 `refresh()` 节流 + 合并落盘 | Run 期间 CPU 与阻塞骤降；见效最快 | 小（几十行） |
| 2 | P0-1 `git hash-object --stdin-paths` + 移出事务 | 消除认领期的 503 窗口 | 中 |
| 3 | P2-5 启用 WAL + 抬高 reader busy_timeout | 读写不再互斥 | 小（运维动作） |
| 4 | P0-3 `/api/issues` 加分页 + 依赖图只算返回集 | 最热读接口从 O(N²) 降到 O(page) | 中 |
| 5 | P1-2 SSE `write` 加 try/catch + 兜底清理 | 消除长跑泄漏 | 小 |
| 6 | P1-3 token 缓存 | 每请求少一次 fs 读 | 小 |
| 7 | P1-4 保留策略接入调度 | 阻止 DB 无界增长 | 中 |
| 8 | P1-1 依赖图每 tick 复用 | 调度器 CPU 下降 | 中 |
| 9 | P1-5 + P2-1 索引与路由分桶 | 尾延迟改善 | 小 |
| 10 | F-1/F-2/F-3 前端分页、memo、debounce | 大数据量下的界面流畅度 | 中 |

前三项都是小改动，且直接命中"控制面在 Run 期间卡死"这个最主要的用户可感知症状。

---

## 7. 本次评估未覆盖

- 未做真实压测，性能量级是按调用次数与系统调用成本推导的，建议用 `benchmarks/xuanwuCapacity.ts` 做基线后再验证。
- 未逐一审计 `pi/`、`agentic/`、`workflows/`、`mcp/` 的业务正确性，只在与性能/内存相关时抽查。
- 未做安全专项。仅顺带注意到：`/api/integrations/feishu/events` 与 `/api/integrations/webhook/events` 绕过 Bearer 校验（`http/auth.ts:169-175`），其签名校验逻辑未在本次核对。
- 未核对 `data-bun/runner.db` 内各表的实际行数分布（沙箱限制），`issue_events` 为主要增长源的判断来自代码路径而非实测。
