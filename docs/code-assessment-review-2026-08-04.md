# 玄武代码整体评估二次复核与改进方案

- 日期：2026-08-04
- 复核对象：`docs/code-assessment-2026-08-04.md`
- 复核范围：原报告列出的后端、前端、SQLite 与运行时问题
- 方法：源码调用链复核、现有测试与门禁复核、只读 SQLite/HTTP 单样本取证
- 状态：评审稿，不是 canonical 架构规范；本轮未修改产品代码、schema、配置或运行状态
- 第二轮复核：2026-08-05，针对原报告作者的回应再次核对消费者挂载、进程发现注入和维护 batch 门禁

---

## 1. 结论摘要

原报告的主方向是对的：当前最值得优先处理的确是 **Core 事件循环上的同步子进程**、**legacy `/api/issues` 的无界重读**，以及由此放大的调度和前端重复刷新。

但有四个关键修正：

1. `claimNextIssue` 的确在 `IMMEDIATE` 事务内执行大量同步 Git 命令；它会冻结同一 Core 进程的 HTTP、SSE 和调度器，也会长时间占用 writer。可是 SQLite rollback-journal 中 `BEGIN IMMEDIATE` 持有的 RESERVED 锁不会在整个事务期间阻塞普通 reader。原报告“reader 50ms 后必然 503”的因果过强；当前 live DB 又已经是 WAL，读者更不会因为普通 writer 事务而被全程挡住。
2. `processLifecycle.refresh()` 的确由每条 Codex notification 触发，并会在进入第一个 `await` 前同步执行一次全机 `ps -axo`。后续 ownership 文件操作是异步串行队列，不是同步文件 IO，但当前仍会为每个事件排入一次原子写，可能形成很长的 IO backlog。
3. legacy `GET /api/issues` 的无分页、全项目依赖求值和逐 Issue 投影均真实存在。默认无 hash 入口是 Command Center，会读取该接口；Settings 和 legacy Issues 也会读取。另一方面，WorkBoard 的页面数据配置只读取 `projects`，`AppSidebar` 中读取 `selectIssues` 的过滤组件也只在 legacy `issues` route 挂载，因此“包括 WorkBoard 在内的所有页面都会请求”同样不成立。优先方案仍是让真实消费者退出 legacy 全量接口，而不是再建立一套长期分页合同。
4. 当前 canonical live DB 已是 WAL，`enable WAL` 不是本次前三项之一。真正的数据风险是 live DB 已约 1.3 GiB，并且仍读 v1 `event_summary_projection`；现有 destructive retention 明确要求已验证备份、无 active writer 和 consumer-zero gate，不能直接接到 heartbeat 在线删除。

建议按以下顺序推进：

1. Provider 进程归属刷新节流、single-flight、按变化落盘；终止/退出路径强制刷新。
2. 清除 Command Center / Settings 等剩余页面对全量 `/api/issues` 的周期刷新，复用 canonical Work/聚合 API。
3. 把 Git workspace observation 移到 `IMMEDIATE` 事务外，批量计算 object id；事务内只做 CAS 认领、Run 与已捕获 baseline 的持久化。
4. 把 SSE 幂等 cleanup 作为独立小改动；前端 refresh in-flight/generation 则在 B 的目标接口确定后实施。
5. 独立设计并演练 event projection v2 cutover、归档、删除和 vacuum；不得把现有离线门禁改成无条件在线任务。

---

## 2. 复核证据边界

### 2.1 代码与工作树

复核开始时工作树已有 8 个与本次任务无关的未跟踪源码文件；写文档期间共享工作树又出现了新的 tracked 修改和文件变化。本轮将这些变化全部视为用户所有，未覆盖、清理或纳入本文档 diff。

原报告中的规模数字已有轻微漂移。复核期间仓库约有 1,034–1,035 个 `backend-ts/src` TypeScript 文件，其中 380–381 个 `*.test.ts`；schema 目录有 69 个非测试 TypeScript 文件；HTTP 目录的生产代码路由注册计数为 227，而不是原报告的约 240。它们不影响问题判断，但说明这些数字应视为评审时快照，不应写成长期合同。

### 2.2 只读 live 单样本

2026-08-04 21:54 CST 对 canonical live DB 和两个 GET 接口做了一次只读取证；这不是压力测试，也不代表稳定分位数：

| 指标 | 结果 |
| --- | ---: |
| live `runner.db` 文件大小 | 约 1.3 GiB |
| `journal_mode` | `wal` |
| `issues` | 817 |
| `issue_runs` | 874 |
| `issue_events` | 538,042 |
| `issue_events` 对象占用 | 676,544,512 bytes |
| v1 `event_summary_projection` 行数 / 占用 | 538,042 / 405,671,936 bytes |
| v2 `event_summary_projection_compact` | 0 行 |
| projection read version | `v1` |
| 单次 `GET /api/issues` | HTTP 200，3.668s，3,649,250 bytes |
| 单次 `GET /api/works/board?page_size=20` | HTTP 200，0.028s，143,439 bytes |

最大的项目当前有 656 个 Issue。live `issue_events` 中 `issue.log` 为 530,794 行，是主要增长源；这次结论已经不再只是从代码路径推导。

仓库内旧快照 `data-bun/runner.db` 仍是 `journal_mode=delete`，约 178 MiB、147,965 条 `issue_events`。因此 WAL 状态必须按具体部署检查，不能用 repo-local 快照替代 live 结论。

### 2.3 2026-08-05 隔离补证

原报告作者在第二轮回应中要求补 SSE、migration 和 token 的运行证据。本轮没有重启 live 服务，采用当前 Bun 运行时、已验证 DB 副本和低风险 live HTTP 单窗口：

| 项目 | 输入 | 结果 | 边界 |
| --- | --- | --- | --- |
| SSE fetch abort | 隔离 Bun server，10 次连接，读到首帧后 `AbortController.abort()` | 最终 subscriber 0；无 uncaught/unhandled error | 同机 Bun fetch，不代表所有代理/内核组合 |
| SSE raw TCP close | 隔离 Bun server，10 次原始 TCP 连接，收到响应后立即断开 | 最终 subscriber 0；无 uncaught/unhandled error | 覆盖真实 socket close，但不是长时慢消费者测试 |
| migration replay | canonical DB 已验证副本；schema 对齐后 20 次交替测量 | 仅 open + 读 migration 表中位约 1.2ms；`runMigrations` 暖态中位约 33.5ms；首个冷样本约 1.28s | 当前源码比 deployed snapshot 多 migration 068，先完成对齐后才统计 replay；不是 live restart |
| migration repair | 为所有用户表挂临时审计 trigger 后运行一次 | 仅 `projects` 发生 4 次 UPDATE；副本前后 4 个项目本来都已 `auto_run=1`，语义 drift repair 命中 0 | trigger 会显著放大耗时，所以只用来定位写入，不用于时间结论 |
| token refresh | live web，200 个未授权 API 请求，并发 10 | p50 0.783ms，p95 2.977ms；同期非 API `/health` p50 0.274ms，p95 0.888ms | 单窗口、未做系统调用级 attribution |
| token 文件读取 | 同一文件，1,000 次异步读取，并发 10 | p50 0.058ms，p95 0.113ms | page cache 热态；只说明当前机器上的量级 |

这些样本足以否定“已确认的 SSE 断连永久泄漏”和“token 是当前 P1 热点”，但还不足以给出稳定 p99 或长期 repair 命中率。migration 冷样本说明首次触页/SQL 编译可能明显，暖态重放仍约 30ms；应先消除 migration 059 的无条件同值 UPDATE 并加逐 migration 指标，再决定是否重构 repair 合同。

---

## 3. 逐项复核结果

| 原报告项 | 结论 | 修正后的判断 |
| --- | --- | --- |
| P0-1 认领事务内大量 Git fork | 确认存在 | 严重；事件循环阻塞和 writer 长事务成立，reader 必然 503 不成立 |
| P0-2 每条 Provider 事件刷新进程表并落盘 | 确认存在 | 严重；Provider lifecycle 的 `ps` 同步阻塞，文件操作异步但逐事件排队；生产内存观察器不另行 fork `ps` |
| P0-3 `/api/issues` 无分页、O(N²)、N+1 | 确认存在 | 严重且有 live 单样本；默认 Command Center、Settings、legacy Issues 受影响，WorkBoard 不受该数据源影响 |
| P1-1 调度 tick 重复算依赖图 | 确认存在 | 高；实际还会在 claim 时再算一次，不能用任意 `LIMIT` 牺牲候选正确性 |
| P1-2 SSE 清理、背压、gap | 部分成立 | Bun 断连会触发 cancel，本轮未复现订阅/心跳泄漏；统一 cleanup 是防御项，背压和 gap 合同仍属实 |
| P1-3 每 API 请求读 token 文件 | 确认机制、热点不成立 | live 低风险单窗口显示文件读取远小于请求开销；缓存仍需保留跨进程 rotation 语义 |
| P1-4 `issue_events` 无界增长 | 确认存在 | live 数据比原报告更严重；原建议“heartbeat 在线裁剪”违反现有维护门禁 |
| P1-5 Evidence replay 查询全表 JSON 扫描 | 确认存在 | `EXPLAIN` 为 `SCAN issue_events`；应做表达式索引或独立 locator |
| P2-1 Router 线性扫描 | 确认机制 | 低优先级；235 routes，先做 method-first 与注册时预编译即可 |
| P2-2 每次启动重放 repairable migration | 确认机制、已补副本样本 | 暖态约 33.5ms，首个冷样本约 1.28s；本快照语义 repair 命中为 0，但有 4 次无效 UPDATE |
| P2-3 issue.log 对大 payload stringify | 部分成立 | debug 模式存在；默认 normal 在进入采样前已丢弃 diff/plan 等事件 |
| P2-4 protected budget 抛异常 | 不认定为缺陷 | 这是测试锁定的 fail-closed 行为；不能改成静默 `{dropped:true}` |
| P2-5 未启用 WAL / timeout 太短 | 当前 live 不存在 | live 已是 WAL；startup 不自动切换是审计设计，不宜盲目提高 reader timeout |
| P2-6 全量 Runs 后 JS 过滤 | 确认存在 | 若干 legacy helper 存在，已有其他调用点使用正确的 `LIMIT 1` 查询 |
| P2-7 `IN` 参数可能超 SQLite 上限 | 当前不成立 | 所有相关维护路径统一经过 `batchSizeValue()`，硬上限 5000；Bun 构建常量只作环境背景 |
| F-1 全量 issues + 签名比较 | 部分成立 | 默认 Command Center、Settings 和 legacy Issues 会加载；WorkBoard 不加载，常驻 selector 本身不会触发 fetch |
| F-2 legacy Issues 无 memo/虚拟化 | 机制存在、严重度有限 | legacy 页面会全树渲染，旧 `issues` route 会重定向到有界且 memo 化的 WorkBoard；但默认无 hash 入口其实是 Command Center，不是 WorkBoard |
| F-3 SSE refresh 无防抖/in-flight 去重 | 确认存在 | legacy dataStore 可并发请求并由旧响应覆盖新响应 |
| F-4 JSON stringify 小热点 | 确认机制 | 微优化，不能进入当前性能修复主线 |

### 3.1 P0-1：认领事务内同步 Git observation

调用链确认如下：

- `db/repositories/issueQueue.ts:22-24` 用 `transaction(...).immediate()` 包住完整 claim；
- `issueQueue.ts:109-124` 在事务内更新 Issue 后调用 `createIssueRun`；
- `db/repositories/issueRuns.ts:20-46` 同步读取 cwd、执行 `rev-parse`、插入 Run 并记录 baseline；
- `domain/evidence/runGitWorkspaceBaseline.ts:166-198` 先做一次 `git status`，再为每个 dirty/untracked path 单独执行一次 `git hash-object`。

因此 `N` 个工作区条目会产生 `N+2` 次同步 Git 子进程（`rev-parse`、`status`、每 path 一次 `hash-object`），而且全部位于 claim 的 `IMMEDIATE` 事务中。这一问题真实存在。

需要修正的是锁解释：

- rollback-journal 下 `BEGIN IMMEDIATE` 取得 RESERVED lock，普通 reader 仍可读取旧快照；只在提交阶段升级锁时可能与 reader 竞争；
- 本次用两个连接做了最小验证：writer 在 `journal_mode=delete` 下 `begin immediate` 并 update 后，50ms timeout 的第二连接仍成功读取旧值；
- current live 为 WAL，普通读写更是分离；
- 其他 writer 会被长事务阻挡，超过 250ms 后可能 `SQLITE_BUSY`；
- 同一 Core 进程的 HTTP/SSE/调度器仍会被 `spawnSync` 直接冻结，这才是最稳定的控制面影响链。

`http/errors.ts:47-49` 只说明真实发生 `SQLITE_BUSY/LOCKED` 时会返回 503，不能反推这段事务必然让 reader 503。

原报告建议“baseline 以后异步补写”有归因竞态：Provider 可能在 baseline 采集前已经修改工作区。建议改为：

1. 事务外预选候选 Issue；
2. 用异步、批量 Git observation 捕获 HEAD 与 dirty workspace；
3. 进入短 `IMMEDIATE` 事务，重新校验项目锁、Issue 状态、依赖和候选身份；
4. CAS 更新 Issue，同时插入 Run 与刚才捕获的 baseline Evidence；
5. CAS 失败则丢弃本次 observation，重新选择，不启动 Provider。

批量 `hash-object --stdin-paths` 需要先定义包含换行文件名的行为；不能从当前逐 path argv 方案直接替换而降低 path 安全性。可以把无法安全批处理的 path 标为 attribution uncertainty，或选用支持无歧义 NUL 输入的 Git plumbing 组合。

### 3.2 P0-2：每条 Codex notification 同步扫描全机进程表

`providers/codex/jsonRpc.ts:269-276` 对每个 notification 无条件调用 `processLifecycle.refresh()`。虽然调用结果没有 await，但 async 函数会立即执行到第一个 await：

- `processLifecycle.ts:64-71` 先调用 `ownedTree`；
- `processLifecycle.ts:124-130` 进入 `inspectProcessTable`；
- `processLifecycle.ts:216-220` 同步 `spawnSync(["ps", "-axo", ...])` 并解析全机进程表；
- 之后 `persist()` 才进入异步 `mkdir/writeFile/chmod/rename` 队列（`:102-121`）。

所以每条 delta 同步 fork `ps` 的判断成立；“每条事件同步写文件”不准确，正确描述是每条事件都会排入一项异步原子写。高事件率下既有 event-loop 阻塞，也有 file-operation queue backlog。

这里还需要排除一个第二轮误判。`observability/processGroupMemory.ts:599-603` 的默认 `inspectMemoryProcessTable()` 的确也会执行同步 `ps`，但生产 Core 创建 `ProcessGroupMemoryObserver` 时在 `runtime/core.ts:101-110` 显式注入了 `inspect: () => runtimeMemoryRows(...)`。仓库中只有这一处生产实例；它从 Core、Agentic、Provider ownership snapshot 和 Provider lease 组装进程行，不调用默认 inspector。因此当前生产态不是“两个子系统各自每秒 fork `ps`”，也没有必要为这两个并不存在的生产消费者先抽共享 TTL inspector。

内存观察器仍反向依赖 Provider lifecycle snapshot，所以不能作为 lifecycle 的独立新鲜进程发现源。短期方案应保持职责边界：

1. `refresh()` 做 leading + trailing coalescing，普通事件最多每秒 inspect 一次；
2. register、stop、processExited、terminal event 和 request-finally 提供 `force` 路径；
3. 同一时间只允许一个 refresh in flight；
4. 进程集合没有变化时不重写 ownership 文件，`observed_at` 可按较低频率 heartbeat 持久化；
5. `ownedTree` 改成 ppid adjacency + BFS，避免反复全表重扫；
6. 加指标：requested/coalesced/inspected/persisted 次数、队列深度、最大等待时间。

### 3.3 P0-3：legacy `/api/issues` 无界读路径

以下代码事实全部成立：

- `http/readApiRoutes.ts:39,140-147` 没有解析 `limit/offset`；
- `db/repositories/issues.ts:213-217` 在二者缺失时不生成 `LIMIT`；
- `http/readApiDomain.ts:258-279` 为涉及到的每个项目计算完整依赖投影，再为每个 Issue 读取 decision；
- `domain/work/issueDependency.ts:71-83,108-147` 为全项目每个 Issue 分别做 cycle/root-blocker/readiness 计算；
- `readiness/contracts.ts:112-148,168-180` 和 `humanReview.ts:148-177` 继续产生逐 Issue 查询。

live 单样本已经证明它不是只有理论复杂度：817 个 Issue 的响应为约 3.65 MB、3.67s；同一时刻已有 `/api/works/board` 只需约 28ms。

第二轮消费者复核需要同时修正两边的过度概括：

- `appRouteModel.js:19-29` 表明默认无 hash 入口是 `command-center`，并非 WorkBoard；`App.jsx:61-68` 让 Command Center 和 Settings 周期读取 `issues`，所以“默认入口影响有限”的原表述不准确；
- `AppSidebar.jsx:102-110` 只在 `currentPage === 'issues'` 时挂载 `IssuesSidebarFilters`，后者才在 `:192` 读取 `selectIssues`；不能因为整个 Sidebar 常驻就推导 WorkBoard 也会 fetch issues；
- `App.jsx:61-68` 为 `work` 只配置 `projects`，`refreshVisibleData()` 也严格按该配置执行；`useRunnerBrandState` 虽然常驻订阅 store 中已有的 issues，但 selector 不会主动发请求；
- 已确认的主动消费者是默认 Command Center 的 `Dashboard.jsx`、Settings 内的 `Projects.jsx`、legacy `Issues.jsx`，以及这些页面中的显式 refresh 动作。WorkBoard 不在这条请求链上。

原报告提出“依赖图只计算本次返回集合”会漏掉分页外的传递依赖。正确方向是：

- 兼容期：给 `/api/issues` 加硬上限之前先盘点并迁移消费者，避免把 array 响应静默截断；
- 产品页：Command Center / Settings 改读 bounded aggregate 或 canonical Work API；主 WorkBoard 已经这样做；
- 依赖算法：可以读取完整轻量 graph，但只对请求 roots 求值，并跨 root 共享 SCC/cycle、root blocker 与 readiness 中间结果；
- 投影查询：按本页 Issue IDs 批量读取 review/activity/readiness，不逐 Issue hydrate；
- sunset：legacy `/api/issues` 到既有 v0.3.x 兼容期结束后再收口，不新增长期并行合同。

### 3.4 P1-1：队列重复依赖计算

`runner/projectLoop.ts:63-89` 在一次 decision 中最多调用两次 `peekNextReadyIssue`；`projectLoopManager.ts:117-120,137-149,174-194` 又在 continue、requeue 和 worker 选择阶段重复 decision；最终 `claimNextIssue` 还会再计算依赖图。结论成立。

不能简单给 `select ... status='todo'` 加一个任意 `LIMIT`：前几项可能因为依赖或 Provider 不可用被跳过，硬截断可能让后面的可运行 Issue 永久饥饿。建议定义 tick-scoped `ProjectRunnableSnapshot`：

- 一次读取项目、todo candidates、依赖 graph、Provider runtime/profile selection 所需数据；
- decision、queue、worker selection 和 claim 共用 snapshot；
- claim 事务仍重新校验 authority 字段，snapshot 只做候选优化，不替代数据库真相；
- 若 candidates 很多，使用稳定 cursor 分批扫描，而不是固定只看头部。

### 3.5 P1-2：SSE 清理、背压和 gap

`http/events.ts:21-35` 只有 consumer 正常 cancel 时才清 heartbeat/subscription；`start()` 没有统一 `try/finally`，`streamWriter` 也不处理 enqueue/serialization 错误。这个结构性缺口成立，现有测试只覆盖 `reader.cancel()` 正常清理（`http/events.test.ts:25-53`）。

但“controller enqueue 一旦抛错后 cancel 必然不执行，所以已经存在永久泄漏”没有在当前 Bun 中复现。隔离 server 的 10 次 fetch abort 与 10 次原始 TCP close 后，EventBus subscriber 都归零，且没有捕获到 enqueue 的 uncaught/unhandled error。当前网络断连会进入 underlying source 的 `cancel()`，先把 `closed` 设为 true，后续 writer 不再 enqueue。

因此要拆开定性：统一 `cleanup()` 是低成本防御性加固；慢消费者背压和 gap/reconcile 是仍未覆盖的独立合同，不能用本次断连结果替它们免责。也不能再把“已存在永久泄漏”作为 SSE cleanup 的修复前提。

建议：

- 抽出幂等 `cleanup()`，cancel、catch、finally 全部调用；
- 改成 pull-driven 或有明确上限的 outbound queue，不能只检查一次 `desiredSize` 后继续 while；
- EventBus overflow 产生包含 dropped count / last known id 的 gap 事件；客户端收到后回 authoritative read API reconcile；
- 测试正常 cancel、注入 enqueue/serialization failure、同步 burst 超 64、慢 consumer 的内存上限和 gap 恢复。

### 3.6 P1-3：token 文件与 URL 重复解析

`http/server.ts:229-231` 和 `http/auth.ts:106-137` 证明 file-backed token 在每个 API 请求都 `readFile`；常规认证 GET 还会在 server、auth、router、compat instrumentation 等层多次 `new URL(request.url)`。机制属实。

补充的 live 低风险单窗口进一步支持降级：200 个未授权 API 请求、并发 10 时 p50/p95 约 0.783/2.977ms；同一 token 文件 1,000 次异步读取、并发 10 时 p50/p95 约 0.058/0.113ms。两者不是严格的系统调用 attribution，对照 `/health` 也包含不同路由逻辑，但足以说明当前 page-cache 热态文件读取不是 P1 量级。

每请求 refresh 还提供了 Web/Core 跨进程 token rotation 的即时一致性。若以后 profile 出热点，应先定义最大 rotation 生效延迟，再采用 watch/mtime/短 TTL + `rotate()` 主动失效，并保留 read/parse 失败时 fail closed。URL context 可以和 router 预编译一起处理，优先级低于前三项。

### 3.7 P1-4：事件与 projection 增长

原报告判断成立，并且 live 证据更明确：raw `issue_events` 约 646 MiB，v1 projection 约 387 MiB，二者各 538,042 行；v2 compact projection watermark 仍为 0，read version 仍是 v1。

现有 `events/maintenanceService.ts` / `payloadCompactionService.ts` 只有 CLI 入口属实，但这是有意的安全门禁：apply 需要 `confirmBackupTested`、`confirmNoActiveWriters`，delete 还要求 archive/evidence/checkpoint/consumer-zero。不能让 projection worker 或 heartbeat 绕过这些条件。

建议拆成两条工作流：

1. 在线只读治理：周期采集文件大小、page/freelist、各对象占用、row rate、projection lag，越阈值告警；允许生成 dry-run report，不做 delete/vacuum。
2. 受控维护窗口：先补齐 v2 projection，完成 observation/cutover/consumer-zero，再 archive、生成 delete Evidence、停 writer、备份与恢复演练、分批 delete、quick/foreign-key check，最后按报告决定 vacuum。

这应作为独立高风险 issue，不与前三个小型性能修复混在一个变更中。

### 3.8 P1-5：Evidence replay lookup

`http/evidenceApi.ts:80-83` 的查询没有可用索引；live `EXPLAIN QUERY PLAN` 为 `SCAN issue_events`。结论成立。

只加 `(type,id)` 能把 538k 行缩到同 type 的约 408 行，已经会显著改善，但仍需 JSON predicate。更完整的选择是 partial expression index，或在不制造第二 authority 的前提下增加 `evidence_id -> source_event_id` locator projection。无论哪种都要验证：append-only replay conflict、全局/Issue 内唯一性、迁移写放大、rollback 和 consumer 对齐。

### 3.9 P2 与前端项

- **Router**：`http/router.ts:34-65` 的线性匹配成立。先把 method 比较放在 path matching 前、注册时预切 pattern，再评估是否需要 radix tree；不需要先做 HTTP 层大重构。
- **Migration replay**：`db/migrations.ts:15-44,77-80` 每次重放 28 个 repairable migration。已验证 DB 副本在 schema 对齐后，20 次测量的暖态中位约 33.5ms，首个冷样本约 1.28s；临时 trigger 定位到 migration 059 每次会把 4 个已经 `auto_run=1` 的项目再次 UPDATE，语义 repair 命中为 0。先给每项加耗时/changed/no-op 指标，并把 059 改成有条件 UPDATE；不要仅凭这个单副本样本删除整体自愈语义。
- **issue.log stringify**：`runner/issueLogPersistence.ts:153-159` 说明 normal mode 在 fingerprint 前就过滤了 diff/plan；热点主要属于显式 debug run。原建议用 payload 长度和首尾片段做弱 hash 可能碰撞并错误抑制审计事件，不采纳；先 profile debug，再选稳定 digest 或版本字段。`value.length <= byteLimit` 也不能直接作为 UTF-8 快速返回条件，因为非 ASCII 字符可能占多字节。
- **protected budget throw**：`issueLogPersistence.test.ts:347-374` 明确测试 fail-closed。若要改善，只应在 Provider 边界把异常转换成结构化 fatal outcome/metric，不能继续执行并静默丢 protected event。
- **WAL/busy timeout**：live 已 WAL，保持 50ms reader timeout 有助于 fail fast；没有证据支持统一改成 1–2s。安装/升级流程应执行已有 WAL maintenance `verify`，未通过再走显式 apply，而不是 startup 隐式切换。
- **Runs 全量过滤**：`issueRuns.ts:75-77`、`projectLoop.ts:248-257`、`readApiDomain.ts:317-319` 存在；复用已有 `where issue_id=? and ended_at='' order by attempt desc limit 1` helper 即可。
- **IN 参数**：`events/maintenanceService.ts:1267-1271` 的 `batchSizeValue()` 对缺省值和调用者输入统一收口，超过 5,000 直接抛错；这是当前风险不成立的稳定依据。Bun SQLite 的 `MAX_VARIABLE_NUMBER=500000` 是版本相关构建常量，只能作为当前环境的额外余量，不能作为合同。可以为一致性分批，但不应作为缺陷排期。
- **legacy Issues 渲染**：`Issues.jsx` 的确无 memo/virtualization，旧 `issues` route 默认会重定向到 Work，`WorkBoard.jsx` 已有分页加载、AbortController、`useMemo/useCallback`。但应用默认无 hash 入口是 Command Center；这不改变 legacy 页面不宜先做大规模虚拟化重构的结论。
- **dataStore refresh 竞态**：`dataStore.js:82-122` 无 single-flight/generation；`App.jsx:351-364` 的 lifecycle event 立即 refresh。应按 slice 合并 in-flight，请求完成时校验 generation，SSE 做短 trailing debounce。主 WorkBoard 的局部请求继续使用 AbortController。
- **签名与 JSON stringify**：只在退出 legacy 全量接口后仍有 profile 证据时优化；当前不单独排期。

---

## 4. 建议实施 DAG

以下是等待 review 后再执行的建议拆分。每项保持可独立 review，避免把高风险 schema/maintenance 与小型 event-loop 修复绑在一起。

### A. Provider lifecycle 热路径（P0，小到中）

依赖：无。

内容：refresh throttle/single-flight、force refresh、tree change detection、BFS、指标与 focused tests。

验收：固定 event fixture 下 1,000 次 notification 的 inspect/persist 次数有明确上限；terminal/stop 后 ownership 仍完整；进程组终止与 stale reconciliation 回归通过；记录 event-loop delay 对比。

### B. legacy `/api/issues` 消费者收口（P0，中）

依赖：无；可与 A 并行设计，但不要并行改共享入口文件。

内容：盘点默认 Command Center、Settings、legacy Issues 的计数与列表需求；改读 canonical Work/aggregate surface；不要为 WorkBoard 或常驻 Sidebar 虚构并不存在的全量请求；legacy API 加 usage metric 和响应大小/耗时告警；确认 v0.3.x sunset。

验收：默认 Command Center 和 Settings 不再周期性请求全量 `/api/issues`，WorkBoard 继续保持零 `/api/issues` 请求；817+ fixture 下请求预算、payload budget、SSE reconcile 和页面统计正确；旧 deep link 兼容不回归。

### C. claim 前 Git observation（P0，中）

依赖：先评审 baseline capture/CAS 合同。

内容：拆分 capture 与 persist；异步批量 Git plumbing；事务内 revalidate/CAS；特殊 path 与 observation failure 显式 uncertainty。

验收：300/1,000 dirty path fixture 下子进程数为常数级；`IMMEDIATE` 持有时间有上限；并发 claim 仍只有一个赢家；Provider 不会在 baseline 落库前启动；Handoff attribution 六类回归保持通过。

### D. SSE 与前端 reconcile 健壮性（小到中，拆成两个 PR）

依赖：D1 SSE cleanup 无；D2 前端 reconcile 等 B 的目标接口确定后实施，避免重复改 refresh 合同。

内容：D1 先做幂等 SSE cleanup 和异常注入测试；背压/gap 合同若会改变协议则另行设计。D2 做 dataStore per-slice single-flight/generation/debounce。

验收：D1 的 cancel/异常路径 subscriber 与 heartbeat 回到基线；D2 中旧响应不能覆盖新响应、30 秒兜底仍保留。慢 consumer 队列上限与 gap 后 authoritative reconcile 作为协议项单独验收，不能混成几十行 cleanup 的完成条件。

### E. 调度依赖 snapshot（P1，中）

依赖：C 完成后的 claim 边界。

内容：tick-scoped runnable snapshot、共享 graph/memo、稳定 cursor、事务内 authority revalidation。

验收：大项目 DAG、菱形、深链、cycle、missing/failed/readiness/provider unavailable 均保持 fail closed；每 tick graph/readiness/profile 查询次数有预算断言；无候选饥饿。

### F. Evidence locator 索引（P1，小 schema 变更）

依赖：独立 ADR/迁移 review。

内容：partial expression index 或 locator projection；锁定 replay 与唯一性语义。

验收：迁移前后 `EXPLAIN`、538k+ fixture lookup、写入成本、rollback、conflict tests。

### G. Event 数据生命周期（高风险，独立项目）

依赖：v2 projection correctness、consumer-zero、受控维护窗口和备份恢复门禁。

内容：在线只读治理；v2 backfill/observation/cutover；archive/delete/vacuum runbook 与 Evidence。

验收：live 副本演练后才进入 quiescent live window；需要完整 report、checkpoint、archive receipt、delete Evidence、quick_check、foreign_key_check、恢复演练和前后对象占用，不以文件变小或 health 200 单独判定完成。

### H. 低优先级清理

依赖：A/B/E 完成并重新 profile。

内容：Router 预编译、migration repair 指标、open Run 查询 helper、token/URL context 缓存；只做 profile 能证明有收益的项目。

---

## 5. 建议的统一性能验收口径

原报告没有压测，所以实施前应先固定基线，实施后用同一输入复测：

- **event-loop**：Core event-loop delay 的 p50/p95/p99/max；Provider notification rate；`ps` inspect 与 ownership persist 次数；
- **claim**：dirty path 数 0/10/300/1,000；Git 子进程数；baseline capture 总时长；`IMMEDIATE` 事务时长；并发 writer busy 次数；
- **read API**：100/800/5,000 Issue；依赖边 sparse/chain/diamond/cycle；响应 bytes、DB query count、p50/p95/p99；
- **frontend**：首次加载请求数/bytes、SSE burst 下 refresh 次数、并发请求峰值、旧响应覆盖断言；
- **SSE**：慢 consumer 队列上限、gap 次数、subscriber/heartbeat 基线恢复；
- **DB**：raw/projection/artifact bytes、row rate、projection lag、WAL checkpoint、freelist/page count；
- **运行窗口**：focused fixture 与真实 Run 分开报告，至少覆盖一次高 delta turn 和一次 dirty workspace claim。

所有结论需区分：静态调用次数、隔离 benchmark、单次 live observation、持续 live window。不能用 focused test 代替真实运行窗口，也不能用 health 200 代替控制面延迟恢复。

---

## 6. 本轮不建议做的事

- 不把 WAL 切换放进每次 startup；当前已有审计 maintenance path，live 也已经是 WAL。
- 不把 destructive retention 直接接进 projection worker/heartbeat。
- 不在 baseline 落库前启动 Provider，也不把 baseline 简单异步后补。
- 不给候选 SQL 加任意固定 `LIMIT` 而引入后部 Issue 饥饿。
- 不把 protected Evidence/approval event 超预算改成静默丢弃。
- 不为 legacy Issues 页面先做大规模 memo/virtualization；先退出无界数据源。
- 不把 HTTP 扁平路由、领域重命名和前三个性能修复合并成一次大重构。

---

## 7. 最终判断

原报告不是“问题都不存在”，也不是“全部按原修法执行”。更准确的结论是：

- 三个主热点都能在代码中确认，其中 `/api/issues` 已有 fresh live 单样本支持；
- SQLite reader/503 因果、Provider 文件 IO 同步性、WAL 现状需要纠正；
- 第二轮对消费者范围的反驳只成立一半：默认 Command Center 确实受影响，但 WorkBoard 不会因常驻 Sidebar 请求 `/api/issues`；
- 第二轮提出的“双 `ps`”不符合生产 wiring：默认 memory inspector 存在，Core 实例却显式注入了无 `ps` 的 snapshot/lease 数据源；
- P2-7 应以统一 batch cap 为主要安全依据，这项更正接受；
- Bun 断连泄漏未复现，token 热点不成立；migration replay 已取得副本量级但仍需长期指标；
- retention、protected budget、WAL startup 的现有门禁是工程纪律的一部分，修性能时不能拆掉；
- canonical Work API、normal issue.log mode、read/write connection split、Provider ownership 与维护 Evidence 链已经提供了正确基础，优先收口旁路与 legacy 消费者即可，不需要推倒重来。

建议批准 A、B、C 和 D1 的普通小 PR 准备；D2 在 B 的接口收口后实施；E、F 单独 review；G 作为高风险数据治理项目另立维护窗口；H 等新一轮 profile 后再决定。
