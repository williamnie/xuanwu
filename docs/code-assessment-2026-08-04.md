# 玄武（Xuanwu）代码整体评估

- 日期：2026-08-04（初版）／2026-08-04 复核修正
- 范围：`backend-ts/src`、`frontend/src`、`backend-ts/src/db/schema`
- 方法：静态阅读 + 调用链追踪；初版未做压测，性能结论按"每次调用做了什么工作"推导
- 状态：评审记录，不是 canonical 规范。不授权 schema/route 变更，仅作为改进输入。

> **修订记录**
>
> 本文初版经 `docs/code-assessment-review-2026-08-04.md` 复核。复核推翻了初版的若干判断，本文已就地修正，被推翻的原始表述以 `~~删除线~~` 或"修正"块保留，便于追溯。
>
> 修正涉及：P0-1 的 SQLite 锁因果、P0-2 的文件 IO 同步性、P0-1/P0-3/P1-1/P2-3 的修法安全性、P2-4、P2-5、P2-7 的定性，以及 F-1/F-2 的消费者定位。
>
> **证据分级**（下文标注）：
> - `[静态]` 本文作者阅读代码得出；
> - `[复核实测]` 复核方 2026-08-04 21:54 CST 对 canonical live DB 与两个 GET 接口的**单次只读取证**，非压测、非稳定分位数，本文作者未独立复现；
> - `[已复验]` 本文作者在修订时重新核对过代码事实。
>
> 文件与路由计数是评审时快照，会漂移，不应写成长期合同。

---

## 0. 总体判断

这个项目的**工程纪律明显高于平均水平**：测试覆盖密集，issue.log 有显式写入预算与截断标记，子进程有 process-group 归属文件与重启对账，有脱敏注册表，调度器在阶段之间主动让出事件循环并对慢阶段告警，ADR 体系完整。

存在一类**系统性的架构缺陷**，集中在同一个模式上：

> **在事件循环的同步路径上执行 `spawnSync` 子进程，其中一处还位于 SQLite `IMMEDIATE` 写事务内。**

Bun 是单线程事件循环。一次 `spawnSync` 会同时冻结 HTTP 服务、SSE 推送和调度器 —— 这是最稳定、最可预测的控制面影响链。

> **修正（复核后）**：初版在此处写"锁一旦被握住超过 50ms，整个读 API 会返回 503"。**这个因果链是错的。**
>
> `BEGIN IMMEDIATE` 取得的是 RESERVED 锁；已持有 SHARED 的 reader 在事务全程仍可读取旧快照，只有在 commit 升级到 EXCLUSIVE 的窗口才有争用。复核方用双连接实验证伪了初版说法。
>
> 准确的分工是：
> - **读请求**：在 `spawnSync` 期间单线程事件循环轮不到它们，症状是**数秒挂起**，不是 503；
> - **其他 writer**：会被长事务挡住，超过 `busy_timeout = 250ms` 后拿到 `SQLITE_BUSY`，经 `http/errors.ts:47-49` 变成 **HTTP 503**。
>
> 即"写 503 / 读卡住"，而不是初版写的"读 503"。P0-1 的严重性不变，但不能用 `isSqliteContention` 的存在反推 reader 必然 503。

第二类问题是**读路径的复杂度失控**：`GET /api/issues` 无分页 + 每项目 O(N²) 依赖图 + 每 Issue 多次 N+1 查询。

第三类是**数据只增不减**：`issue_events` 的保留/压缩逻辑只在 CLI 里可达。`[复核实测]` canonical live DB 约 **1.3 GiB**，`issue_events` 538,042 行、约 645 MiB，v1 `event_summary_projection` 同样 538,042 行、约 387 MiB，v2 compact projection watermark 仍为 0。

> **修正**：初版据 `data-bun/runner.db` = 186MB 立论。该文件是**仓库内旧快照**（`journal_mode=delete`，147,965 条事件），不代表 live 状态。

---

## 1. P0 — 严重，建议优先修

### P0-1. Issue 认领在 SQLite 写事务内 fork 大量 `git` 子进程

**调用链** `[静态，复核确认]`

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

**问题**：`N` 个工作区条目 = `N+2` 次同步 `git` 子进程（`rev-parse` + `status` + 每 path 一次 `hash-object`），全部位于 `IMMEDIATE` 事务内。300 个未跟踪文件、每次 5–15ms，就是 **1.5–4.5 秒事件循环完全冻结**。

**后果**：
- 同一 Core 进程的 HTTP / SSE / 调度器被 `spawnSync` 直接冻结（主要影响）；
- 其他 writer 被长事务挡住，>250ms 后 `SQLITE_BUSY` → 503；
- ~~reader 50ms 后被写锁挡住必然 503~~ —— 见 §0 修正。

**修法**

> **修正**：初版建议"把 baseline 采集移出事务，作为异步 Evidence 事件后补"。**这有归因竞态** —— Provider 可能在 baseline 采集前就已修改工作区，导致 baseline 把 Provider 的改动记成 Run 前既有状态。不能采用。

正确形状是"事务外捕获 → 事务内 CAS 复核"：

1. 事务**外**预选候选 Issue；
2. 用异步、批量的 Git observation 捕获 HEAD 与 dirty workspace；
3. 进入**短** `IMMEDIATE` 事务，重新校验项目锁、Issue 状态、依赖与候选身份；
4. CAS 更新 Issue，同时插入 Run 与**刚才已捕获**的 baseline Evidence；
5. CAS 失败则丢弃本次 observation，重新选择，**不启动 Provider**。

批量化本身：`git hash-object --stdin-paths` 可把 N 次 fork 降为 1 次，但**需要先定义含换行文件名的行为**，不能直接替换现有逐 path argv 方案而降低 path 安全性；或直接从 `git status --porcelain=v2` 的 `<mH> <mI>` 字段取 OID，零额外 fork。无法安全批处理的 path 应显式标记为 attribution uncertainty。

顺带：`createIssueRun` 里 `issueProjectCwd` 被查了两次（`issueRuns.ts:24` 和 `:50`）。

---

### P0-2. 每一条 provider 事件都 `spawnSync("ps -axo …")`

**调用链** `[已复验]`

```
CodexStdioJsonRpcTransport.deliverEvent   providers/codex/jsonRpc.ts:269-276
  └ processLifecycle.refresh(...)                          :271        ← 每条事件，未 await
      └ ownedTree → inspect → inspectProcessTable  providers/codex/processLifecycle.ts:67, 124-130, 216-220
            └ Bun.spawnSync(["ps","-axo","pid=,ppid=,pgid=,rss=,command="])   ← 第一个 await 之前，同步执行
```

`request()` 的 `finally` 也调一次（`jsonRpc.ts:196`）。

**问题**：Codex/Claude 一个 turn 会推送成百上千条流式事件，每一条都同步 fork 一个 `ps`、拉取整机进程表、正则逐行解析（`processLifecycle.ts:222-232`）。macOS 上进程表通常 400–800 行，一次 `spawnSync ps` 保守 3–8ms。1000 条事件 = **3–8 秒纯阻塞**。

> **修正**：初版写"每条事件做一次 mkdir + 写临时文件 + chmod + rename 的原子落盘"，把文件 IO 也算成同步阻塞。**不准确。**
>
> `[已复验]` `persist()`（`processLifecycle.ts:102-112`）把整个原子写交给 `enqueueFileOperation`（`:118-122`），后者是 `this.fileOperation.then(operation, operation)` 构成的**异步串行队列**。文件 IO 不阻塞事件循环。
>
> 但问题换了形态而非消失：每条事件仍会**排入一次完整原子写**，队列无界。高事件率下这是 IO backlog 与内存增长，某种意义上比同步写更难观测。

**修法**
- `refresh()` 做 leading + trailing coalescing，普通事件最多每秒 inspect 一次；`register` / `stop` / `processExited` / terminal event / request-finally 走 `force` 路径。
- single-flight：同一时刻只允许一个 refresh in flight。
- 进程集合无变化时不重写 ownership 文件；`observed_at` 按较低频率 heartbeat 持久化。
- `ownedTree`（`:184-198`）是 `while(changed)` 全表重扫，最坏 O(n²)；改成按 ppid 建邻接表一次 BFS。
- 加指标：requested / coalesced / inspected / persisted 次数、队列深度、最大等待时间。

> **修正**：初版建议"复用 `ProcessGroupMemoryObserver` 已有的 1s 采样结果"，并引用 `runtime/core.ts:63-65` 的注释说观察器"改用了非挂起的 `proc_pid_rusage`"。**两处都要更正：**
>
> - 行号错误 `[已复验]`：该注释在 `runtime/core.ts:102-103`。
> - 事实错误 `[已复验]`：`proc_pid_rusage` 只用于**已发现 PID 的 footprint**（`collectMacOSFootprint`，`processGroupMemory.ts:605`）。观察器的**进程发现**是它自己的 `inspectMemoryProcessTable`（`:599-603`），同样是 `Bun.spawnSync(["ps","-axo",...])`，每 1s 一次。
> - 复核方指出观察器已反向依赖 Provider lifecycle snapshot（`RuntimeOwnership.process`，`:48`），因此让 provider 反过来消费观察器会形成循环依赖。
>
> **两个子系统各自独立 `spawnSync ps`** —— 这是初版和复核稿都没点破的部分。正确方向不是让一方依赖另一方，而是抽出一个**带 ~1s TTL 的共享进程表 inspector**，两边都从它读，保持职责边界不变。

---

### P0-3. `GET /api/issues` 无分页 + O(N²) 依赖图 + 多重 N+1

**路由** `[静态，复核确认]`：`http/readApiRoutes.ts:39` → `issueFilter`（`:140-147`）**只解析 projectId / sourceSessionId / status，不解析 limit / offset** → `issuePagination`（`db/repositories/issues.ts:213-217`）在二者均 undefined 时返回空 SQL → 最终 SQL **没有 LIMIT**。

然后 `publicIssues`（`http/readApiDomain.ts:258-279`）逐层放大：

| 层 | 位置 | 每次调用的代价 |
| --- | --- | --- |
| 依赖图（每项目一次） | `domain/work/issueDependency.ts:71-83` | 拉取该项目**全部** issue（无状态过滤、无 limit）+ 全部 `work_relations` |
| 逐 issue 图遍历 | `issueDependency.ts:108-147` | 每个 issue 各跑一次 `findReachableCycle` DFS（`:178-198`）+ `collectRootBlockers`（`:166-176`）→ **O(V·(V+E))** |
| 逐 issue readiness | `domain/readiness/contracts.ts:112-148` | 每个有依赖的 issue：`getIssue` + `issue_events` 查询 + `directDependencyWorkIDs` + 每条 requirement 各一次 |
| 逐 issue 决策投影 | `domain/review/humanReview.ts:148-171` | 每个 issue ≥3 次查询（`mustGetIssue` 把已在手的 issue 又查了一遍） |

`collectRootBlockers` 每层递归都 `new Set(path)` 复制路径集合（`:173`），无跨调用记忆化；菱形依赖指数级重复展开，深链会栈溢出。

**`[复核实测]` 这不是纯理论复杂度**：817 个 Issue 时，单次 `GET /api/issues` = **3.668s / 3,649,250 bytes**；同一时刻 `GET /api/works/board?page_size=20` = **0.028s / 143,439 bytes**。

**`[已复验]` 消费者定位（初版和复核稿都不完整）**：`frontend/src/components/AppSidebar.jsx:192` 消费 `selectIssues`，而 sidebar **在每个页面都挂载**；它的用途只有 `issues.length` 与按项目计数（`:193, 205, 255, 259`）。也就是说这次 3.65MB / 3.67s 的请求，**在包括 WorkBoard 在内的所有页面都要付，只为渲染几个计数徽章**。其余消费者：`Dashboard.jsx:30`、`Projects.jsx:35`、`Issues.jsx:34`。

> 复核稿称"默认入口已重定向到 WorkBoard，legacy 页面影响有限"—— 就 `Issues.jsx` 而言成立，但 `AppSidebar` 是常驻组件，这条不能用来降低整体严重度。

**修法**

> **修正**：初版建议"`readProjectIssueDependencies` 只对本次返回的 issue 集合求值"。**会漏掉分页外的传递依赖** —— readiness 依赖传递闭包，闭包可以延伸到页外。不能采用。
>
> 初版建议"`issueFilter` 解析 limit/offset 并设默认上限 200"也有问题：该接口返回裸数组，加硬上限会**静默截断**现有消费者。

正确顺序是：

1. **先退出，再收口**：`AppSidebar` 改读 bounded aggregate（它只要计数）；`Dashboard` / `Projects` 同理改读 canonical Work / 聚合接口。给 legacy `/api/issues` 加 usage metric 与响应大小/耗时告警，确认无消费者后再按既有 v0.3.x 兼容期 sunset，不新增长期并行合同。
2. **依赖算法**：可以读取完整轻量 graph，但只对请求 roots 求值，并跨 root 共享 SCC/cycle、root blocker 与 readiness 中间结果；`collectRootBlockers` / `findReachableCycle` 改迭代 + memo，`path` 复制换成"进入时 add、退出时 delete"。
3. **投影查询**：按本页 Issue IDs **批量**读取 review / activity / readiness，不逐 Issue hydrate；`readIssueDecisionProjection` 接受已加载的 `Issue` 对象，去掉 `mustGetIssue`。

---

## 2. P1 — 高

### P1-1. 同一份依赖图在一次调度 tick 内被重复计算多次

`nextIssueRow`（`db/repositories/issueQueue.ts:144-155`）本身三重放大：

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

调用方再乘一层：`projectLoopDecision` 一次调用里 `peekNextReadyIssue` 被调 **2 次**（`runner/projectLoop.ts:66, 78`）；`shouldContinue` 每轮循环调 `projectLoopDecision`（`runner/projectLoopManager.ts:117-120`）；`requeueProjectsWithTodo` 对每个 auto_run 项目调（`:137-149`）；`nextRunnableProject` 对每个等待中项目调（`:174-194`）。且 `filter` 是 `issueProviderAvailable` → `resolveExecutorSelection`，每候选一次 DB 访问（`projectLoop.ts:189-215`）。最终 `claimNextIssue` 还会再算一次。

**修法**

> **修正**：初版建议"`select id from issues` 加 `limit`"。**会造成饥饿** —— 头部候选可能因依赖未就绪或 Provider 不可用被跳过，硬截断会让后面本可运行的 Issue 永久排不到。不能采用。

定义 tick-scoped `ProjectRunnableSnapshot`：一次读取项目、todo candidates、依赖 graph、Provider runtime/profile selection 所需数据；decision / queue / worker selection / claim 共用。claim 事务内仍重新校验 authority 字段 —— snapshot 只做候选优化，不替代数据库真相。候选很多时用**稳定 cursor 分批扫描**，而不是固定只看头部。

### P1-2. SSE 流在 controller 出错时可能泄漏订阅与心跳定时器

`http/events.ts:21-36`：

```ts
const write = streamWriter(controller, () => closed);
heartbeat = setInterval(() => write(comment("heartbeat")), heartbeatMs);
while (!closed) {
  const event = await subscription.next();
  if (event) write(data(event));
}
```

`streamWriter`（`:47-52`）只判断 `closed`，不判断 controller 是否已 errored。`start()` 没有统一 `try/finally`。若 `controller.enqueue` 抛出，异常从 `start()` 逃逸，`cancel()` 不被调用 → `clearInterval` 与 `subscription.close()` 都不执行。

对照 `http/piConversationApi.ts:369-377` —— 那里的 `enqueue` 包在 try/catch 里并在失败时 `clearHeartbeat()`。同一项目两种写法，`events.ts` 是漏的那个。

> **修正**：初版称该订阅者"**永久留在** `EventBus.#subscribers` 里"。这是代码路径推导，**尚未运行时复现**。正常 `reader.cancel()` 会先把 `closed` 置真，后续 writer 不再 enqueue；现有测试也只覆盖正常 cancel（`http/events.test.ts:25-53`）。应记为**高价值的长跑防御缺口**，而不是已量化的确定泄漏。

**同一文件的另两个问题**：无背压（从不检查 `controller.desiredSize`，慢客户端令内部队列无限增长）；静默丢事件（`events/bus.ts:41` 缓冲满 64 条后 `shift()` 丢最老的，不发 gap 标记）。

**修法**：抽出幂等 `cleanup()`，cancel / catch / finally 全部调用；改成 pull-driven 或有明确上限的 outbound queue；overflow 时产生含 dropped count / last known id 的 gap 事件，客户端据此回 authoritative read API reconcile。测试需覆盖：正常 cancel、注入 enqueue 失败、同步 burst 超 64、慢 consumer 内存上限与 gap 恢复。

### P1-3. 每个 `/api/` 请求都从磁盘读一次 token 文件 —— 降级为观察项

`http/server.ts:229-231` 的 `refresh()` 即 `readFile(path, "utf8")`（`http/auth.ts:109-118`）。同一请求还会解析 `new URL(request.url)` 约 5–6 次。

> **修正**：初版把它列为 P1 热点，**缺乏证据**。live bounded WorkBoard 端到端仍只有约 28ms `[复核实测]`。且每请求 refresh 提供了 Web/Core 跨进程 token rotation 的即时一致性 —— 缓存会牺牲这个语义。
>
> 若要优化：先定义"最大 rotation 生效延迟"，再用 watch/mtime/短 TTL + `rotate()` 主动失效，并保留读取/解析失败时 fail closed。优先级低于前三项。

### P1-4. `issue_events` 运行时只增不减

保留与压缩服务存在且写得不错，但只有 CLI 能触发：`events/maintenanceService.ts`、`events/payloadCompactionService.ts` 的唯一外部调用方是 `cli/maintenance.ts:10, 23`。`runtime/core.ts` 无任何调度器调用。同时 `BackgroundProjectionWorker` 持续写派生行。

`[复核实测]` raw `issue_events` 约 645 MiB / 538,042 行；v1 projection 约 387 MiB / 538,042 行；v2 compact projection 0 行，read version 仍是 `v1`。其中 `issue.log` 占 530,794 行，是主要增长源。

`issue_events` 上只有两个索引：`(issue_id, type)`（`schema/001_base_schema.ts:80`，`schema/005` 重复定义了一次）和 `(issue_id, id desc)`（`schema/056_issue_log_mode.ts:9`）。无 `created_at` 索引。

**修法**

> **修正**：初版建议"把保留策略接到 Automation/heartbeat 上定期跑，或在 projectionWorker 空闲窗口顺带小批量裁剪"。**违反现有维护门禁。**
>
> `[已复验]` destructive retention 的 apply 要求 `confirmBackupTested`、`confirmNoActiveWriters`，delete 还要求 archive / evidence / checkpoint / consumer-zero。这些门禁是有意设计的安全边界，不能让 worker 或 heartbeat 绕过。

拆成两条工作流：

1. **在线只读治理**（可以现在做）：周期采集文件大小、page/freelist、各对象占用、row rate、projection lag，越阈值告警；允许生成 dry-run report，**不做 delete/vacuum**。
2. **受控维护窗口**（独立高风险项目）：先补齐 v2 projection，完成 observation / cutover / consumer-zero，再 archive、生成 delete Evidence、停 writer、备份与恢复演练、分批 delete、`quick_check` / `foreign_key_check`，最后按报告决定 vacuum。

不与前几项小型性能修复混在同一变更。

### P1-5. 请求处理器里对最大的表做全表扫描 + `json_extract`

`http/evidenceApi.ts:80-83`：

```sql
select count(*) as count from issue_events
where type=? and json_valid(payload) and json_extract(payload,'$.evidence.id')=?
```

`type` 单独无索引（复合索引是 `(issue_id, type)`，前缀不匹配）。`[复核实测]` live `EXPLAIN QUERY PLAN` 为 `SCAN issue_events`（538k 行）。

**修法**：加 `(type, id)` 索引可把扫描面收敛到同 type 的约 408 行，但仍需 JSON 谓词；更完整的选择是 partial expression index，或在不制造第二 authority 的前提下增加 `evidence_id → source_event_id` locator projection。需验证 append-only replay conflict、唯一性、迁移写放大、rollback 与 consumer 对齐。

---

## 3. P2 — 中

### P2-1. 路由表线性扫描，且每次比较都重新切分字符串

`http/router.ts:34-53`：每个请求 `routes.find(...)` 逐条调 `routeMatches`，而 `routeMatches`（`:73-79`）对 pattern 和 path **都**执行 `normalizePath` + `split("/")` + `filter(Boolean)`。404 时 `allowedMethods`（`:63-65`）再全表扫 5 遍。（生产路由注册数约 227–240，随快照漂移。）

**修法**：先把 method 比较放到 path matching 之前、注册时预切 pattern segments，再评估是否需要 radix tree。不需要先做 HTTP 层大重构。

### P2-2. 每次启动重放 28 个可修复迁移

`db/migrations.ts:77-81` 的 `repairKnownSchemaDrift` 在每次启动、在迁移事务内，把 `REPAIRABLE_MIGRATION_IDS`（`:15-44`）全部重新 apply。

这是显式的 drift-repair 策略，不是疏忽。**修法**：先记录每项耗时与实际 repair 命中率，再决定是否降级成一次性修复迁移 + 启动时只读一致性校验；不要直接删除现有自愈语义。冷启动影响未实测。

### P2-3. issue.log 采样路径上对完整 payload 做 `JSON.stringify` —— 仅限 debug 模式

`runner/issueLogPersistence.ts:555-565` 的 `eventFingerprint` 把整个 raw payload 序列化，只为做变更检测。

> **修正**：初版称被采样的 method 包含 `turn/diff/updated`，因此"完整 diff 会被 stringify"。**在默认 normal 模式下不成立。**
>
> `[已复验]` `push` 在 `:158` 就执行 `if (mode === "normal" && !normalModeEvent(sourceEvent)) return;`，早于 `sampleEvent` → `eventFingerprint`（`:300`）。而 `normalModeEvent`（`:220-227`）的白名单只有 error / done / `item/completed`(agentMessage|commandExecution) / `turn/completed` / `error` / `protocol/error` / 错误态 `thread/status/changed` —— `turn/diff/updated` 进不来。
>
> 该热点**只存在于显式 debug run**。

同文件其他微热点：`boundedUtf8`（`:524-530`）即使未超限也 `Buffer.from(value)` 全量复制；`push` 里 `[...samples.values()].some(...)`（`:199`）每条采样事件分配一个数组；`chunkKey` / `sampleKey`（`:532-553`）每事件各一次 `JSON.stringify`。

> **修正**：初版建议 (a) fingerprint 换成"payload 长度 + 前后若干字节"的弱 hash —— **会碰撞并错误抑制审计事件**，不采用；若要优化应先 profile debug 模式，再选稳定 digest 或版本字段。(b) `boundedUtf8` 用 `value.length <= byteLimit` 快速返回 —— **不安全**，UTF-8 字节数最多可达 UTF-16 长度的 3 倍。
>
> 正确写法是用 `Buffer.byteLength(value)` 判断：它不分配副本，正好达成"避免复制"的原意，超限时才 `Buffer.from`。

### P2-4. ~~预算超限时从 provider 事件回调里抛异常~~ —— 不认定为缺陷

`runner/issueLogPersistence.ts:287` 的 `throw new Error("issue.log protected event budget exceeded …")`。

> **修正**：`[已复验]` 这是被测试锁定的 fail-closed 合同 —— `runner/issueLogPersistence.test.ts` 的 "bounds non-decisive lifecycle rows and fails closed on protected row overflow" 明确断言 `expect(...).toThrow("protected event budget exceeded")`。
>
> 初版建议改成返回 `{dropped: true, reason}` 会把 approval 等 protected 事件变成**静默丢弃**，破坏安全语义。撤回该建议。
>
> 若要改善表达方式，只应在 Provider 边界把异常转换成结构化 fatal outcome / metric，**继续 fail closed**，不得继续执行。

### P2-5. ~~运行时不启用 WAL~~ —— 当前 live 不成立

`db/database.ts:78-83` 的 `configureWalConnection` 只在数据库已是 WAL 时才设置 `synchronous`/`wal_autocheckpoint`；WAL 切换由审计过的维护命令负责。

> **修正**：`[复核实测]` canonical live DB 的 `journal_mode` **已经是 `wal`**。初版把"启用 WAL"列为前三修复项，不成立，已从 §6 移除。
>
> 仓库内 `data-bun/runner.db` 快照仍是 `journal_mode=delete` —— 所以这是**按部署检查**的项，不能用 repo-local 快照替代 live 结论，也不能反过来假设所有部署都已 WAL。
>
> 另：初版建议把 reader `busy_timeout` 从 50ms 提到 1–2s。WAL 下没有证据支持；50ms fail fast 反而有利。撤回。
>
> 正确做法：安装/升级流程执行已有的 WAL maintenance `verify`，未通过再走显式 apply，而不是 startup 隐式切换。

### P2-6. "全量取回再在 JS 里过滤"的模式

`openIssueRunID`（`runner/projectLoop.ts:255-257`）、`issueExecutionNoLongerCurrent`（`:248-253`）、`ensureOpenIssueRun`（`db/repositories/issueRuns.ts:76`）、`hasOpenIssueRun`（`http/readApiDomain.ts:317-319`）都是取该 issue 全部 run 再在内存里 filter/find。

**修法**：复用已有的 `where issue_id=? and ended_at='' order by attempt desc limit 1` 查询形状。

### P2-7. ~~未分批的 `IN (?,?,…)` 参数展开~~ —— 当前不成立

`db/repositories/eventMaintenance.ts:86-100` 的 `currentIssueEventRows` 直接展开 `ids.length` 个占位符，而同文件 `countExistingIssueEvents`（`:104-115`）按 500 分批。

> **修正**：`[已复验]` 该路径的调用方都经过 `maintenanceService.ts:1267-1271` 的 `batchSizeValue`，它在 `> 5000` 时直接 `throw`。**是这个上游 cap 保证了安全**，而不是 SQLite 的变量上限（复核稿引用的 `MAX_VARIABLE_NUMBER=500000` 是 Bun 打包的 SQLite 构建常量，随版本变动，不宜作为依据）。
>
> 不作为缺陷排期；若要分批只是形式一致性。

---

## 4. 前端

### F-1. 常驻 sidebar 拉全量 issue 列表，只为渲染计数

`[已复验]` `AppSidebar.jsx:192` 消费 `selectIssues`，**每个页面都挂载**，实际只用 `issues.length` 与按项目计数（`:193, 205, 255, 259`）。数据源是 `store/dataStore.js:19` → `workApi.getIssues()` → `/api/issues`，不带任何分页参数（`api/work.js:95-101`）。结合 P0-3 的实测，这意味着**每个页面都要付 3.65MB / 3.67s**。

拿回来之后 `sameIssues`（`utils/stateGuards.js:91-93`）再对每个 issue 的 26 个字段拼签名字符串比较，字段里包含 `description`、`source_excerpt`、`workflow_snapshot_json`、`error`（`:19-44`）。

**修法**：sidebar 与 Dashboard 计数改读 bounded aggregate 接口。签名比较的优化等退出全量数据源后再看是否还有 profile 证据。

### F-2. `Issues.jsx` 零 memo、零虚拟化 —— 严重度下调

`pages/Issues.jsx`（629 行）中 `useMemo` / `useCallback` 出现 0 次（对比 `Sessions.jsx` 19 次），全仓无虚拟化库。

> **修正**：默认 `issues` route 已重定向到 Work，`WorkBoard.jsx` 已有分页加载、AbortController 与 `useMemo`/`useCallback`。这是 sunset 页面，**不建议为它做大规模虚拟化重构**；先退出无界数据源即可。

### F-3. SSE → 刷新没有防抖，且刷新之间没有去重

`App.jsx:352-364` 收到 `ACTIVE_RECONCILE_EVENT_TYPES` 事件立即 `refreshVisibleData()`，无 trailing debounce。`dataStore.js:82-122` 的 `refreshData` 无 in-flight 去重也无 generation —— 30 秒定时器与 SSE 触发可并发，**最后 resolve 的覆盖先前结果，可能写回旧数据**。

好的一面是事件类型选得克制（只有生命周期事件，不含流式 delta，`App.jsx:46-59`）。

**修法**：按 slice 合并 in-flight，请求完成时校验 generation，SSE 加短 trailing debounce，保留 30 秒兜底。WorkBoard 的局部请求继续用 AbortController。

### F-4. 小问题

`setPageContext`（`App.jsx:264-271`）每次调用对 state 做 `JSON.stringify` 比较；`dataStore.js:25` automations slice 的 `same` 直接 `JSON.stringify` 全量比较。微优化，不单独排期。

---

## 5. 设计层面的观察

### 5.1 HTTP 层扁平化膨胀

`http/` 下约 60 个非测试模块、约 227–240 条路由，其中 `pi*` 前缀独占约 30 个模块。所有模块注册进同一个扁平 router，没有中间件、没有路由分组、没有统一 context 注入；`createDefaultRouter`（`http/server.ts:69-150`）是一长串 `if (runtime.database) register…`。

这不是必须马上改的问题，但它是 P2-1 和"每请求 6 次 URL 解析"的根因 —— 没有一层能承载"解析一次、复用多次"。**不应与前几项性能修复合并成一次大重构。**

### 5.2 未完成的领域重命名

代码里同时活着两套词汇：`issues`/`work`、`sessions`/`runs`、`pi`/`supervisor`。为此存在大量兼容层：`http/legacyCompatibilityApi.ts`、`http/frontendCompatApi.ts`、`http/frontendCompatHandlers.ts`、`http/automationLegacyRedirectsApi.ts`；`domain/work/issueAdapter.ts` 的 `issueIDToWorkID` / `workIDToIssueID` 在依赖图里被高频调用（`issueDependency.ts:86-93, 109-117`）；迁移里包含 `030_remove_legacy_notification_settings`、`051_remove_production_fixtures`、`052_consolidate_pi_decision_layers`、`053_drop_legacy_automation_tables`、`055_collapse_pi_agents_to_supervisor`、`058_drop_issue_templates`。

每条读路径都在为这个未完成的迁移付翻译成本。建议把"完成重命名"当成有明确 exit criteria 的独立 issue，而不是持续叠加兼容层。

### 5.3 读写连接分离做对了

`runtime/core.ts:44-45` 开了独立只读连接，`http/readApiRoutes.ts:12-13` 确实让读 handler 走 `readDatabase`。在 live 已是 WAL 的前提下，这个分离能拿到实际隔离收益。

### 5.4 值得保留的做法

改动时不要破坏：

- **issue.log 写入预算**（`runner/issueLogPersistence.ts`）：分 delta/sample/lifecycle/protected 四类，超限写显式 truncation marker 而不是静默丢弃；protected 类别 fail closed（见 P2-4）。
- **normal / debug 双模式**：默认只持久化 replay-independent 的运营证据（`:220-238`），detail 只在显式 opt-in 时落库。
- **子进程归属与重启对账**（`providers/codex/processLifecycle.ts`）：ownership 文件 + `reconcileStaleCodexProcessOwnership` + 进程组信号，比 kill-by-pid 稳健得多。
- **维护门禁**（`events/maintenanceService.ts`）：备份验证、无 active writer、archive/checkpoint/consumer-zero、batch size 上限。这些是纪律，不是障碍。
- **调度器主动让出**（`runner/piAutoManageScheduler.ts:357-369`）：阶段间 `Bun.sleep(0)`，慢阶段 ≥250ms 打 `runner.schedule_phase_slow` 告警。P0-1/P0-2 修完后它会更有效。
- **脱敏**（`util/redact.ts` + `security/redactionRegistry.ts`）在错误、日志、状态输出上一致应用。
- **canonical Work API**：`/api/works/board`（`http/workApi.ts:50`）已经是有界、快速的替代面，legacy 收口有落点。

---

## 6. 建议的修复顺序（复核后重排）

| 顺序 | 项 | 预期收益 | 工作量 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | P0-2 `refresh()` 节流 + single-flight + 变化才落盘 | Run 期间事件循环阻塞与 IO backlog 骤降 | 小 | 无 |
| 2 | F-1 / P0-3 消费者收口：sidebar 与 Dashboard 改读计数聚合 | 每个页面省下 3.65MB / 3.67s | 小到中 | 无 |
| 3 | P1-2 SSE 幂等 cleanup + gap 合同 | 消除长跑防御缺口 | 小 | 建议在 2 之后，避免重复改 refresh 合同 |
| 4 | P0-1 Git observation 移出事务 + CAS 复核 | 消除认领期的控制面冻结 | 中 | 需先评审 baseline capture/CAS 合同 |
| 5 | P0-3 依赖算法与投影批量化 | 最热读路径复杂度收敛 | 中 | 2 |
| 6 | P1-1 tick-scoped runnable snapshot | 调度器 CPU 下降 | 中 | 4 |
| 7 | P1-5 evidence locator 索引 | 消除全表 JSON 扫描 | 小 schema 变更，独立 ADR | 独立 review |
| 8 | P1-4 在线只读治理（仅告警/dry-run） | 让增长可观测 | 中 | 无 |
| 9 | P1-4 事件生命周期 cutover / archive / delete | 阻止 DB 无界增长 | 大，高风险 | 独立项目 + 维护窗口 |
| 10 | P2-1 / P2-6 / P1-3 / F-3 / F-4 | 尾延迟与健壮性 | 小 | 1/2/6 完成后重新 profile 再定 |

前三项都是小改动，且直接命中"控制面在 Run 期间卡死"与"每页 3.65MB"这两个最主要的用户可感知症状。

**~~启用 WAL~~ 已从本表移除** —— 见 P2-5。

---

## 7. 验收口径

初版无压测。实施前应固定基线，实施后用同一输入复测：

- **event-loop**：Core event-loop delay 的 p50/p95/p99/max；Provider notification rate；`ps` inspect 与 ownership persist 次数、队列深度；
- **claim**：dirty path 数 0/10/300/1,000；Git 子进程数（应为常数级）；baseline capture 总时长；`IMMEDIATE` 事务持有时长；并发 writer busy 次数；并发 claim 仍只有一个赢家；
- **read API**：100/800/5,000 Issue；依赖边 sparse/chain/diamond/cycle；响应 bytes、DB query count、p50/p95/p99；
- **frontend**：首次加载请求数/bytes、SSE burst 下 refresh 次数、并发请求峰值、旧响应覆盖断言；
- **SSE**：慢 consumer 队列上限、gap 次数、subscriber/heartbeat 基线恢复；
- **DB**：raw/projection/artifact bytes、row rate、projection lag、WAL checkpoint、freelist/page count。

所有结论需区分：静态调用次数、隔离 benchmark、单次 live observation、持续 live window。不能用 focused test 代替真实运行窗口，也不能用 health 200 代替控制面延迟恢复。

---

## 8. 本次评估未覆盖

- 未逐一审计 `pi/`、`agentic/`、`workflows/`、`mcp/` 的业务正确性，只在与性能/内存相关时抽查。
- 未做安全专项。仅顺带注意到：`/api/integrations/feishu/events` 与 `/api/integrations/webhook/events` 绕过 Bearer 校验（`http/auth.ts:169-175`），其签名校验逻辑未在本次核对。
- `[复核实测]` 标注的数字来自复核方单次只读取证，本文作者未独立复现；它们不是稳定分位数。
- 冷启动成本（P2-2）、SSE 泄漏的运行时复现（P1-2）、token 读取的 profile 证据（P1-3）均未实测。

---

## 9. 本轮明确不建议做的事

- 不把 WAL 切换放进每次 startup；也不因此盲目提高 reader `busy_timeout`。
- 不把 destructive retention 直接接进 projection worker 或 heartbeat。
- 不在 baseline 落库前启动 Provider，也不把 baseline 简单异步后补。
- 不给候选 SQL 加任意固定 `LIMIT` 而引入后部 Issue 饥饿。
- 不给返回裸数组的 legacy `/api/issues` 加硬上限而静默截断现有消费者。
- 不把 protected Evidence/approval 事件超预算改成静默丢弃。
- 不为 sunset 的 `Issues.jsx` 先做大规模 memo/virtualization。
- 不把 HTTP 扁平路由重构、领域重命名与前几项性能修复合并成一次大变更。
