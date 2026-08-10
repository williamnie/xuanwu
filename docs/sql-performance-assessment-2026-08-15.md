# SQL 性能优化实施方案（复核更正版）

> 修订日期：2026-08-10
> 文件名沿用原评估报告，便于追踪历史引用；本文内容替代原报告结论。
> 适用范围：`backend-ts`（Bun + `bun:sqlite`）的 runner authority database。
> 状态：P0 已实现；canonical live 已完成新鲜备份、069→077 隔离演练、回滚演练、两轮部署与线上复测。
> 复核状态：已吸收独立复测中的 schema contract、hydration、migration 风险，以及首次部署后发现的 Provider 状态同步探测和 connector history 扫描问题。

## 一、执行结论

系统当前最值得优先处理的 SQL 风险确实集中在 `issue_events`，但不能把问题简化为“缺少两个索引 + 非 WAL”。完整根因是：

1. `issue_events` 同时承载高频 `issue.log` 与少量结构化 lifecycle/Evidence/Handoff 事件；跨 Issue 查询缺少全局 type 前缀索引。
2. 部分热路径对 JSON payload 做全局过滤；冷页读取可达到 300ms 级，并同步阻塞 Bun event loop。
3. `eventErrors` 与 session event 查询的排序模式不匹配现有索引。
4. run lifecycle 一次逻辑命令会执行 2–5 次 `issue_events` 查询；其中 `readRunRevision` 本身是每次命令 1–2 次，不是旧报告所称 2–4 次。
5. WAL 只能缓解 reader/writer 锁竞争，不能解决同步 SQL、JSON 解析、event-loop blocking 或 writer/writer 竞争。
6. 首轮索引上线后，`/api/system/status` 仍有 3.8–4.7s、最坏48.4s 的长尾；phase timing 证明主因已不是 DB，而是 status projection 每次同步调用 Provider `runtimeStatus()`，其中会启动外部 CLI。
7. 同一 status 请求还会为7个 connector 重复执行 `connector.tested` 历史查询；在80,152行 `pi_action_events` 上每轮7次查询 p50 为157.35ms。
8. 仓库内 `data-bun/runner.db` 是 2026-07-24 的旧快照，只能用于复现查询形态；live 结论必须来自 canonical DB 的新鲜备份和部署后指标。

因此建议按以下顺序执行：

1. **P0：新增一个通用 type 索引和一个精确 partial index，并验证真实执行计划。**
2. **P0：给 `readRunRevision` 增加明确的 `issue_id` scope，但不改变 lifecycle replay 顺序。**
3. **P0：补齐遗漏的 Evidence 与 usage-baseline 查询测试。**
4. **P0：status projection 只读取配置/刷新阶段保存的 Provider 状态快照，不在 HTTP 请求内运行 CLI。**
5. **P0：为 connector test history 建精确 partial expression index，且忽略无效 JSON。**
6. **P1：根据 live 状态决定是否切 WAL；已是 WAL 时只 verify，不重复 cutover。**
7. **P1：控制 projection catch-up、调度错峰和 retention 增长。**

不再使用“可解决 80% 卡顿”这类未经端到端基线支持的比例结论。最终效果以 live API、event-loop lag、SQL p95/p99 和写入回归为准。

---

## 二、证据边界与当前基线

### 2.1 仓库快照只读复测

对 `data-bun/runner.db` 使用 `sqlite3 -readonly`、`PRAGMA query_only=on` 复测：

| 项目 | 当前值 |
| --- | ---: |
| 文件大小 | 186,236,928 bytes |
| `journal_mode` | `delete` |
| `synchronous` | `FULL` |
| `issue_events` | 147,965 行 |
| `issue.log` | 146,961 行 |
| `issue.log` payload | 145,783,116 bytes |
| `issue_events` 物理占用（`dbstat`） | 177,942,528 bytes |
| `idx_issue_events_issue_type` | 3,010,560 bytes |
| `idx_issue_events_issue_id_desc` | 2,072,576 bytes |
| projection switch | `read_version=v1` |
| v1/v2 watermark | 均为 0 |
| `quick_check` | `ok` |

旧报告中的“145MB”更接近 `issue.log` payload 字节数，不是 `issue_events` 的物理表大小。

### 2.2 冷热缓存差异

| 查询 | 首次触页 | 热缓存范围 | 结论 |
| --- | ---: | ---: | --- |
| `projectSnapshot.eventErrors` | 361ms | 94–96ms | 百毫秒风险成立，但使用了现有 `(issue_id,type)` 索引后排序，不是全表扫 |
| `listStoredHandoffs`（当前0条 Handoff） | 未隔离冷缓存 | 27–38ms | 外层仍扫描；当前 correlated subquery 没有执行 |
| `runProgress.latest_source_event_id` | — | 180–199ms | 真正扫描/解析全部 `issue.log` payload |
| `readRunRevision` | 未隔离冷缓存 | 26–27ms | 冷扫描可能显著更慢；热态不是稳定 300ms |
| `findLifecycleEvents` | 未隔离冷缓存 | 22–25ms | 同上 |
| `runAttemptEvents.usageBaseline` | 370ms | 26–28ms | 旧报告遗漏的条件性 P0 |
| hottest Issue session events | 40ms | 4–5ms | 当前不是 P0，但索引排序不匹配 |

冷页数据说明全局扫描会造成严重长尾；热页数据说明旧报告不能把每次请求都描述成稳定 300–426ms。

### 2.3 canonical live 上线前只读 preflight（2026-08-10）

已从 launchd 运行态确认 canonical DB 为
`~/Library/Application Support/xuanwu-bun-live/state/runner.db`，且 Core、Web、Agentic
三个服务健康。只读结果：

| 项目 | live 当前值 |
| --- | ---: |
| runtime | `v0.2.1-2-g5bf1c4e` |
| `journal_mode` | `wal` |
| `synchronous` | `NORMAL`（1） |
| DB pages | 275,615 × 4,096 bytes，约1.13GB |
| `issue_events` max id | 538,932 |
| 现有 `issue_events` indexes | `idx_issue_events_issue_id_desc`、`idx_issue_events_issue_type` |
| migration watermark | 只到 `069_builtin_pi_executor_profile` |
| projection switch | `v2` |
| v2 watermark | `last_event_id=538932`，已追平当前 max id |
| WAL/SHM | 约414KB / 32KB（采样时） |

因此本部署不需要 WAL cutover，也不需要 projection catch-up。repo snapshot 的 DELETE 模式
不代表线上现状。

### 2.4 canonical live 实施结果（2026-08-10）

新鲜备份通过应用内 backup/export 验证后恢复到隔离目录；完整执行069→076，随后恢复到
迁移前 SHA，再单独演练069→077。线上迁移仅由 Core writer 启动路径执行，Web 不持有 DB，
服务按 Core→Agentic→Web 启动。

| 项目 | 实施结果 |
| --- | ---: |
| runtime/build stamp | `v0.2.1-5-g0af6eda-dirty` / `20260810T141137Z-0af6eda58377-dirty` |
| migration | 79行，最新 `077_pi_action_event_connector_test_index` |
| authority counts | projects 4、issues 819、issue_events 538,160、issue_runs 883、agent_sessions 4,673 |
| `issue_events` max id / v2 watermark | 538,932 / 538,932，lag=0 |
| Run scope mismatch | 0 |
| integrity | `quick_check=ok`、foreign key violation=0 |
| journal | WAL + synchronous NORMAL |
| 新索引 | 3个均存在，执行计划命中 |

可恢复证据：

- fresh snapshot：`~/Library/Application Support/xuanwu-bun-live/backups/xuanwu-backup-20260810T134500Z.snapshot`；
- 第一轮停写备份：`backups/predeploy-20260810T135042Z/runner.db`；
- 第二轮停写备份：`backups/predeploy-20260810T141132Z/runner.db`；
- 第二轮 runtime rollback snapshot：`rollback/20260810T141137Z`。

部署后10次完整 `/api/system/status` 请求 p50 10.18ms、最大42.41ms；部署前常态
3.8–4.7s，观测到的最坏值为48.385s。该提升同时包含 Provider 状态快照和 connector
history 索引，不能归因于单一 SQL。

重启后另以30秒间隔采样12次完整 status 与三角色 health：status 中位数34.13ms、范围
15.54–63.55ms；Web/Core/Agentic 全部成功，migration始终为79、目标索引始终为3、
projection lag始终为0，两个 `quick_check` 均为 `ok`，新增日志中的
`SQLITE_BUSY/SQLITE_LOCKED/no such index/fatal/panic` 均为0。WAL 在约4.1MB时自动
checkpoint回约0.38MB，未见单调增长。

---

## 三、查询与索引对应关系

### 3.1 现有索引

```sql
create index idx_issue_events_issue_type
  on issue_events(issue_id, type);

create index idx_issue_events_issue_id_desc
  on issue_events(issue_id, id desc);
```

此外，`id integer primary key autoincrement` 自带 rowid 顺序；`autoincrement` 不改变本文的查询计划判断。现有索引并非“完全无用”：

- `eventErrors` 会通过 `issues.project_id` 找到 Issue，再使用 `(issue_id,type)`；瓶颈是取出大量候选后排序。
- session events 会使用 `(issue_id,id desc)` 缩小到单 Issue，但仍需按 `created_at,id` 排序。
- `order by id desc limit 1` 可以反向遍历 rowid，但遇不到匹配行时仍会扫描全部记录。

### 3.2 P0 新索引

本次实现从原最新 `074_im_outbound_dedupe` 之后只追加：

- `075_issue_event_query_indexes`：建立两个 P0 索引；
- `076_run_revision_issue_scope_invariant`：使用075索引执行历史 scope audit，发现错绑即回滚 migration 并阻止启动；
- `077_pi_action_event_connector_test_index`：建立 connector test history 的精确 partial expression index。

建议 SQL：

```sql
-- 1. 稀有结构化事件的全局 type lookup 与 id 顺序。
create index if not exists idx_issue_events_type_id
  on issue_events(type, id);

-- 2. /api/system/status 只需要当前 normalized Run Event contract 的最新 id。
-- 只索引真正匹配的行，避免 (type,id) 在 99% 都是 issue.log 时失去选择性。
create index if not exists idx_issue_events_run_event_v1_id_desc
  on issue_events(id desc)
  where type='issue.log'
    and json_valid(payload)
    and json_extract(payload, '$.run_event.contract')='xw.run-event.v1';
```

### 3.3 每个索引解决什么

| 查询 | `type,id` | run-event partial |
| --- | --- | --- |
| Handoff get/list/count | 主要收益 | 无 |
| Evidence get/list/replay | 主要收益 | 无 |
| `readRunRevision` | 仅作降级保护；首选现有 issue/type 索引 | 无 |
| `findLifecycleEvents` | 主要收益 | 无 |
| Work create replay | 主要收益 | 无 |
| usage baseline | 主要收益 | 无 |
| `eventErrors` | 现有 issue/type 索引已被使用；不是此索引的主要目标 | 无 |
| latest normalized Run Event | 选择性极差，不能解决 | 主要收益 |
| session events | 无 | 无 |

### 3.4 P1 条件索引

如果 live 的 session progress SQL p95 仍超过目标，再新增：

```sql
create index if not exists idx_issue_events_issue_created_id
  on issue_events(issue_id, created_at desc, id desc);
```

不建议在第一批无条件加入，因为旧快照热态只有 4–5ms，且它会让每条 `issue.log` 再增加一次索引写。

`eventErrors` 的 recent-created 索引也只能作为条件实验，不能直接列为 P0：

```sql
create index if not exists idx_issue_events_recent_created
  on issue_events(created_at desc, id desc, issue_id, type);
```

在副本实测中，仅新增该索引后 planner **仍然**选择 `issues ->
idx_issue_events_issue_type -> TEMP B-TREE`，不会自动按 recent-created 扫描。只有用
`CROSS JOIN` 固定 join order 并显式选择该索引，才会改为按时间倒序扫描：最活跃项目热态约1ms，稀疏项目约25ms。这个策略的成本取决于目标项目在全局事件流中的密度，不能只按最活跃项目结果上线。

因此 `eventErrors` 的优先方案是：

1. 先保留现有 SQL/索引，采集各项目候选行数与 p95；
2. 若只有高流量项目慢，可对受控查询做双策略 benchmark，再决定是否强制 recent scan；
3. 若多个稀疏项目也慢，优先把 `project_ref + source_event_id` 的 compact projection 补齐 error 查询能力，而不是再给 raw event 表添加全局宽索引。

### 3.5 不推荐的索引

不推荐仅建：

```sql
create index on issue_events(created_at);
```

原因：它没有完整覆盖 `order by created_at desc, id desc`，也不解决 session 的 `issue_id` seek；即使换成完整 recent-created 索引，当前 join order 也不会自动使用。

不推荐全量表达式索引：

```sql
create index on issue_events(type, json_extract(payload, '$.run_event.contract'), id);
```

原因：它会对几乎所有 `issue.log` 维护 JSON expression 和 NULL key。精确 partial index 更小、更可控。

### 3.6 Connector history 专用索引

`connectorTestHistory()` 的 predicate 同时固定 `event_type` 和 JSON connector id。不要为整个
审计表增加宽泛 `(event_type,id)` 索引，而使用只收录合法 `connector.tested` 行的精确索引：

```sql
create index if not exists idx_pi_action_events_connector_test_history
  on pi_action_events(json_extract(payload_json, '$.connector_id'), id desc)
  where event_type='connector.tested' and json_valid(payload_json);
```

查询必须包含相同的 `event_type='connector.tested' and json_valid(payload_json)` 条件，既让
SQLite 证明 partial predicate，也避免历史脏 JSON 使 `json_extract` 抛错。canonical 新鲜副本
只有1条匹配记录，索引为1页/4KB；7个 connector 的整轮读取从 p50 157.35ms、p95
185.34ms 降到 p50 0.034ms、p95 0.095ms。

### 3.7 实施文件清单

| 文件 | 变更 |
| --- | --- |
| `backend-ts/src/db/schema/075_issue_event_query_indexes.ts` | 新 migration：P0 两个索引 |
| `backend-ts/src/db/schema/076_run_revision_issue_scope_invariant.ts`、`backend-ts/src/db/runRevisionScopeAudit.ts` | 一次性历史 scope gate 与可复用 audit |
| `backend-ts/src/db/schema/index.ts` | 注册 migration，保持顺序只追加 |
| `backend-ts/src/db/database.ts`、`database.test.ts` | migration ID、索引存在性、重复迁移与启动 schema invariant |
| `backend-ts/src/domain/run/service.ts` | `readRunRevision` 增加 `issue_id` 参数 |
| `backend-ts/src/runner/interrupt.ts`、`backend-ts/src/db/repositories/issueActions.ts`、`backend-ts/src/http/piSupervisorActionDispatch.ts` | 传递已知 Issue scope |
| `backend-ts/src/db/repositories/runProgress.ts` | latest normalized event 显式使用专用 partial index |
| `backend-ts/src/db/repositories/issueEventQueryIndexes.test.ts` | lifecycle/usage baseline、Work replay、Evidence/Handoff anti-join、scope audit 的 query-shape plan regression |
| `backend-ts/src/db/repositories/runProgress.test.ts` | normalized run-event partial-index plan regression |
| `backend-ts/src/db/schema/077_pi_action_event_connector_test_index.ts` | connector history partial expression index |
| `backend-ts/src/integrations/connectorDiagnostics.ts`、`connectorDiagnostics.test.ts` | 查询 predicate、脏 JSON 容错与 plan regression |
| `backend-ts/src/providers/core/registry.ts`、`status.ts`、`status.test.ts` | 配置阶段保存 runtime status 快照；HTTP projection 禁止同步探测 Provider CLI |
| `backend-ts/src/pi/projectSnapshot.ts` | P1 only：按项目密度决定保留 join-first 或改 projection |
| `backend-ts/src/pi/sessionObserver.ts` | P1 session event 索引的 plan regression 与 hydration benchmark |
| `backend-ts/src/runtime/agentic.ts`、`backend-ts/src/db/walMaintenance.ts` | WAL/timeout 仅验证与独立运维变更，不在 startup 隐式切换 |

---

## 四、P0 代码与 SQL 改造

### 4.1 `readRunRevision` 增加 Issue scope

当前查询只有 `run_id` JSON predicate，无法使用 `(issue_id,type)`。建议让调用方传入已知的 `issue_id`：

```sql
select max(cast(json_extract(payload, '$.after_revision') as integer)) as revision
from issue_events
where issue_id=?
  and type in (?, ?, ?, ?)
  and json_valid(payload)
  and json_extract(payload, '$.run_id')=?;
```

调用链中 Issue scope 已经存在：

- domain command 内的 `RunRow.issue_id`；
- runner interrupt 的 `issue.id`；
- issue action 的 `issue.id`；
- Supervisor resume 查询 `issue_runs` 时可同时选择 `issue_id`。

实现约束：

1. 改为 `readRunRevision(db, issueID, runID)`，不在 helper 内静默猜测 Issue。
2. 增加一致性测试：payload `run_id` 对应事件的 `issue_id` 必须等于 `issue_runs.issue_id`。
3. 部署前在副本上做历史 mismatch audit；存在脏数据时先报告并 fail closed。
4. 不删除事务内 revision reread。它是 optimistic concurrency 校验，不得用事务外缓存替代。

### 4.2 不改变 `findLifecycleEvents` replay 语义

`findLifecycleEvents` 的 completion/replay 入口有些只携带 `eventID`，且 replay 故意发生在读取当前 mutable Run projection 之前。

第一阶段只依靠 `(type,id)` 缩小候选集，不强行增加 `issue_id`，避免：

- 先读取 mutable Run 后才允许 replay；
- 已持久化 intent 在 projection 异常时无法幂等返回；
- completion API 被迫修改公共 contract。

索引上线后若 replay 查询仍超过目标，可把一次逻辑中的 intent/outcome 查询合并为一次 `type in (?,?)`，但必须保留 fingerprint conflict、pending outcome 和 idempotency 测试。

### 4.3 修复 `/api/system/status` 的全量 JSON 扫描

保留现有 SQL predicate，使其精确匹配 partial index，并显式绑定这个专用索引：

```sql
select id
from issue_events indexed by idx_issue_events_run_event_v1_id_desc
where type='issue.log'
  and json_valid(payload)
  and json_extract(payload, '$.run_event.contract')='xw.run-event.v1'
order by id desc
limit 1;
```

这里允许 `INDEXED BY`，因为索引与查询属于同一个专用 contract，migration 一定先于代码运行。副本实测发现：同时存在通用 `(type,id)` 后，SQLite 即使执行 `ANALYZE`，也可能错误选择通用索引并继续解析全部 `issue.log`；显式绑定后，无匹配行的旧快照从约204ms降到不足1ms。

`INDEXED BY` 是硬依赖：索引不存在时 prepare/query 会直接报 `no such index`。本仓库的正常 writer 启动路径会在 `openDatabase()` 返回前同步完成 `runMigrations()`，Core 也是先迁移 writer、再打开 readonly connection，所以不需要靠“第一个 status 请求”验证 migration。但仍要防止 `schema_migrations` 已记录、索引却被人工删除或恢复不完整的 schema drift：

1. migration test 覆盖全新 DB、从074升级、重复运行三种场景；
2. writer startup 在 migration 后断言两个 P0 索引存在，缺失时 fail fast；
3. 备份恢复必须先由 writer 完成 migration/断言，再启动 Web/read connection；
4. 直接构造 SQLite fixture、绕过 `openDatabase()` 的测试必须显式应用完整 migrations；
5. 纯 readonly import 若未来需要调用 `runProgressProjectionStatus`，必须先做 schema capability preflight，不能假定索引存在。

验收执行计划必须显示 `SCAN issue_events USING INDEX idx_issue_events_run_event_v1_id_desc`，不能选择通用 type 索引或主表。

不要仅依赖 `(type,id)`：在当前分布中 `issue.log` 占 99.3%，它仍接近全表扫描。

### 4.4 `eventErrors` 保持语义，先修排序

第一阶段不改变 `eventErrorMessage()` 的筛选语义，也不承诺一个 recent-created 索引会自动消除“大量候选 + temp B-tree sort”。

要求：

- 在 canonical 数据副本上按项目密度分层比较当前 join-first plan 和强制 recent-scan plan；
- 当前 SQL 若继续选择 `(issue_id,type)` 后排序，属于已知行为，不误报成全表扫描；
- 只有所有代表性项目都获益时，才把 recent-created + 查询重写作为 P1 上线；否则建立 project error locator/projection。

benchmark 必须计入排序后的 hydration：每个入选 `issue.log` 都会调用 `hydrateStoredIssueLogPayload()`，可能再读取外置 payload。当前最多受 `PROJECT_STATUS_LIMIT` 约束，但仍应分别记录 SQL wall time、hydration query count/bytes 和完整 `eventErrors()` wall time，不能只比较裸 SQL。

长期应澄清 `eventErrors` 是否真的要把任何带 `text/message` 的 `issue.log` 当作 error；这是产品语义问题，不与本次性能修复混做。

### 4.5 Evidence 与 Handoff

旧方案漏掉：

- `http/evidenceApi.ts` 的 replay count；
- `db/repositories/evidence.ts` 的 get/list/correlated lookup；
- Handoff link validation 中逐 Evidence 的 `getStoredEvidence`；
- `db/repositories/runAttemptEvents.ts` 的 usage baseline。

第一阶段统一由 `(type,id)` 把候选从全部 `issue_events` 缩到对应稀有 type。

只有当某个结构化 type 自身增长到足以再次变慢时，才选择：

1. partial expression index；或
2. `evidence_id/handoff_id/event_id -> source_event_id` locator projection。

locator 必须是可重建 read model，不得成为第二套 Evidence/Handoff authority。

### 4.6 Provider 状态读取移出 HTTP 热路径

`statusFromRegistry()` 只能读取 `RegistryEntry.runtimeStatus` 快照。快照在 provider
`startConfigured/refreshConfigured/setEnabled` 时更新；状态页读取不得再次调用
`entry.instance.runtimeStatus()`。这保留 Provider readiness 的配置刷新语义，同时消除
Pi `--version`、Claude auth probe 等同步外部进程对 Core event loop 的阻塞。

该优化不是 SQL 索引替代品：首次部署后的 phase timing 正是先证明 DB phase 已降到毫秒内，
再把剩余48秒长尾定位到 providers phase。测试必须断言重复 status projection 不增加
runtime probe 调用次数。

---

## 五、写入开销与容量评估

### 5.1 旧快照估算

参考现有索引：

- `(issue_id,type)`：约 3.01MB；
- `(issue_id,id)`：约 2.07MB。

在旧快照副本上的实际结果：

- `(type,id)`：3,227,648 bytes；
- optional `(created_at,id,issue_id,type)`：6,729,728 bytes；
- exact partial run-event index：当前没有匹配行，仅4,096 bytes；live 大小取决于 normalized event 数量。

P0 两个索引当前约增加3.23MB；若追加 optional recent-created，总增量约9.96MB。payload 大小不会直接进入索引，但建 partial index 必须读取并检查 payload，仍会产生 CPU/I/O 成本。

### 5.2 每条 `issue.log` 的额外成本

P0 新增后每条日志会：

1. 更新 `(type,id)`；
2. 计算一次 partial-index predicate；真正匹配时再写 partial index。

只有实施 P1 recent-created 时，每条日志才再增加一次宽索引写。

`id/created_at` 基本单调，B-tree 主要在右侧追加，页分裂风险低于随机 key，但仍需实测：

- `recordIssueLogEvent` 单次 p50/p95；
- 每秒 event insert throughput；
- transaction commit latency；
- WAL bytes/sec 或 rollback journal bytes；
- DB/index 增长率；
- scheduler 与 API 并发窗口中的 event-loop lag。

可接受门槛建议：在相同 fixture/真实副本回放下，写入吞吐下降不超过 10%；超过时应重新评估 recent-created 是否改为专用 projection。

本次20,000条 `recordIssueLogEvent`、单个 immediate transaction、5轮交错副本基准的中位数：无P0索引567.755ms，有P0索引617.627ms，写入 wall time 增加8.78%，在门槛内。单条 autocommit 受文件系统抖动影响过大，不作为结论依据。

### 5.3 建索引不是零风险

`CREATE INDEX` 会扫描现有表并写入大量 B-tree page。生产实施要求：

- fresh verified backup；
- restore rehearsal；
- 无 active writer；
- 预留至少 DB size + 预计索引 + WAL/journal 的磁盘余量；
- Core 与 Agentic 不并发跑 migration；
- 在同规模副本测量 migration wall time 和峰值磁盘。

其中 exact partial index 的 predicate 包含 `json_valid/json_extract`。首次建造必须读取现有 `issue.log` payload 并逐行执行 JSON predicate；当前约145MB/148k行副本的0.40s结果受 SSD、热缓存和数据规模影响，不能线性外推。canonical rehearsal 需要冷/热各测一次，并记录 migration 持有写/schema lock 的时间；若超出维护窗口，改为离线副本建造/替换或扩大停机窗口，不在 active writer 上冒险执行。

---

## 六、WAL 决策与 busy timeout

### 6.1 先 verify，不默认 apply

每个部署先执行已有 WAL maintenance verify/dry-run。只有确认目标 DB 仍为 DELETE，才进入审计 cutover：

1. 同规模副本 rehearsal；
2. fresh backup + restore rehearsal；
3. 停止 Core/Agentic，确认没有 writer FD；
4. apply `journal_mode=wal`；
5. writer connection 使用 `synchronous=normal`、`wal_autocheckpoint=1000`；
6. verify、`quick_check`、authority row counts；
7. 启动 Core，再启动 Agentic；
8. API、scheduler、checkpoint、WAL growth smoke。

已是 WAL 的部署只做 verify，不重复切换，也不把 startup 改成隐式 journal-mode transition。

### 6.2 WAL 能解决什么

- 普通 reader 与 writer commit 大部分时间可并行；
- reader 不再因普通 writer transaction 长时间等待 rollback-journal commit；
- 顺序 WAL append 通常降低写提交抖动。

### 6.3 WAL 不能解决什么

- SQLite 仍只有一个并发 writer；
- Core 与 split Agentic 的 writer/writer 竞争仍存在；
- 同步 SQL/JSON 解析仍会阻塞所在 Bun event loop；
- 长 reader 可能阻碍 checkpoint，导致 WAL sidecar 增长；
- schema migration、checkpoint、异常恢复仍可能出现 `BUSY/LOCKED`。

### 6.4 timeout 建议

保持当前默认：

- Core writer：`db/database.ts` 默认250ms；
- readonly runner connection：`db/database.ts` 为50ms；
- split Agentic writer：`runtime/agentic.ts` 显式传入5s，作用于同一个 runner DB，应单独观察其长等待；
- usage index 的5s位于 `usage/usageIndex.ts`，是独立索引 DB；legacy cleanup 的5s位于 `db/legacyAutomationCleanup.ts`，是维护命令连接。这两者不能当成 Agentic/runtime runner timeout 证据。

不要因为启用 WAL 就统一提高 timeout。更长 timeout 可能让同步 SQLite 调用更久占据 event loop。只有拿到真实 `BUSY/LOCKED` 来源、等待分布和用户可见错误率后再调整。

---

## 七、projection、调度与 retention

### 7.1 projection catch-up

如果 live watermark 落后，不要同时进行以下操作：

- 大索引 migration；
- v1/v2 projection 全量追赶；
- archive/delete/vacuum；
- 正常高峰流量。

建议先在副本计算 catch-up 时间和 projection 额外体积，再选择：

- 低峰分批追赶；或
- 停机窗口追平后切换 read version。

worker 当前每批100行、lag时25ms继续，但 `max_wall_ms` 不能中断已经开始的同步 SQL。需要保留 phase timing，并根据上批 duration 动态降低 batch/duty cycle。

### 7.2 scheduler

Guardian 与 Agentic scheduler 是两个独立30秒循环，Supervisor phase 为60秒。优化建议：

- 启动时错开15秒，减少同一时刻争抢 writer/event loop；
- phase slow log 增加连续超限计数和最近 p95；
- 同步 SQL 没有可抢占 timeout，不能用 `Promise.race` 假装取消；
- 先消除本方案中的全局扫描，再判断是否需要拆进 worker。

### 7.3 retention

索引只降低查询复杂度，不阻止表继续增长。retention 必须继续走现有 archive → verify/restore rehearsal → delete evidence → bounded delete → vacuum 门禁。

不建议在 heartbeat/scheduler 中直接在线删除历史 event。可以自动化的第一步仅是只读容量告警：

- `issue_events` rows/bytes；
- `issue.log` rows/bytes/day；
- projection lag/bytes；
- WAL bytes/checkpoint age；
- freelist/page count；
- 预计达到磁盘阈值的天数。

归档/删除仍需显式批准和已验证备份。

---

## 八、实施步骤

### Phase 0：新鲜 baseline

1. 确认 canonical DB 与服务角色。
2. 只读采集 schema、index、type分布、`dbstat`、projection、journal状态。
3. 对每条目标 SQL 保存完整 SQL、参数类型、`EXPLAIN QUERY PLAN`。
4. 采集至少10分钟正常流量：API、scheduler phase、event-loop lag、BUSY错误。

### Phase 1：副本 rehearsal

1. 从 fresh verified backup/VACUUM INTO 副本演练，不直接复制 active WAL 的主文件。
2. 从 live 当前069状态完整执行070/070a/071/071a/072/073/074/075/076/077。
3. 用 canonical 规模副本冷/热各测一次索引 build wall time、lock duration、峰值磁盘和最终 bytes。
4. `ANALYZE issue_events` 后复跑 plan 与计时。
5. 回放代表性 `issue.log` 写入，比较前后吞吐。
6. 覆盖 fresh DB、074升级、重复迁移、schema drift fail-fast 和 restore-then-open。
7. 运行 focused tests、DB tests、build。

canonical 新鲜副本069→076演练含1GB备份、hash和健康检查共15.12s；前进后
`quick_check=ok`、外键违规0、authority counts不变，回滚恢复到迁移前完全相同 SHA。
069→077第二轮演练1.46s，connector索引4KB。数字受当前SSD和页缓存影响，不能外推到
其他部署规模。

### Phase 2：代码改造

1. `readRunRevision(db, issueID, runID)`。
2. 增加历史 scope mismatch audit/test。
3. 加 Evidence、Handoff、usage baseline、run replay 的 plan regression tests。
4. 加 `/api/system/status` 缺索引 fail-fast 与专用索引 plan regression。
5. P1 benchmark 同时统计 `eventErrors` SQL 和 payload hydration。
6. session P1 regression 放在 `pi/sessionObserver.ts` 的 `listSessionEvents` 路径。
7. 不改变 `findLifecycleEvents` replay 顺序。
8. Provider status projection 只读配置阶段快照；connector history 使用077索引。

### Phase 3：生产部署

1. 低峰维护窗口、backup/restore确认、no-writer确认。
2. 只启动一个 migration owner，避免 Core/Agentic同时迁移。
3. 完成069→077 migration，验证 migration IDs、三个新索引、scope audit 和 planner stats。
4. 启动 Core并验收；确认后再启动 Agentic。
5. 当前 canonical live 已是 WAL，只验证 journal/synchronous/checkpoint，不执行 journal-mode 切换。

### Phase 4：观察窗口

本次变更至少完成部署前后连续采样和部署后短观察；随后保留24小时容量趋势。长期基线应继续覆盖：

- SQL/API p50/p95/p99；
- event-loop lag；
- `SQLITE_BUSY/LOCKED`；
- scheduler phase slow count；
- issue.log insert latency/throughput；
- DB/WAL/SHM/index bytes；
- projection lag。

---

## 九、验收标准

### 9.1 执行计划

| 查询 | 必须满足 |
| --- | --- |
| Handoff/Evidence/usage baseline/lifecycle | 不再 `SCAN issue_events`；使用 `idx_issue_events_type_id` 或更专用索引 |
| latest normalized Run Event | 显式使用 `idx_issue_events_run_event_v1_id_desc`，不得退回通用 type 索引 |
| `readRunRevision` | 使用 `idx_issue_events_issue_type` 的 `issue_id + type` lookup |
| `eventErrors` | P0 允许继续使用现有 issue/type 索引；若实施 P1，SQL + hydration 总耗时必须对高/低密度项目均优于 baseline |
| session events（若实施 P1 索引） | `pi/sessionObserver.ts` 使用 `idx_issue_events_issue_created_id`，无 temp sort |
| connector history | `SEARCH pi_action_events USING INDEX idx_pi_action_events_connector_test_history (<expr>=?)` |

### 9.2 性能目标

目标应先在同规模副本通过，再以 live 观察确认：

- P0 单条 SQL 热态 p95 < 25ms；
- P0 单条 SQL首次触页 < 100ms，或有明确异步/隔离策略；
- `/api/system/status` DB phase p95 < 100ms；
- `/api/system/status` 端到端热态 p95 < 100ms，且读取不能触发 Provider runtime probe；
- `/api/handoffs`、`/api/evidence` SQL phase p95 < 100ms；
- scheduler正常窗口 event-loop lag p95 < 50ms、p99 < 100ms；
- 正常观察窗口 `SQLITE_BUSY/LOCKED` 为0；
- 相同写入回放下 issue.log throughput回退不超过10%；
- `quick_check=ok`，authority row counts与迁移前一致。

如果 live 基线受硬件/数据规模影响无法达到这些绝对值，应在变更前按每条 SQL 固化可比较的相对门槛，并由 p95/p99 与业务端到端指标共同验收；不能临时挑选单次最快值，也不预设“解决80%卡顿”之类无基线比例。

---

## 十、回滚策略

### 10.1 代码回滚

- `readRunRevision` 改造必须保持 event payload/schema 不变；代码回滚无需数据迁移。
- replay 合并若未实施，则 lifecycle 语义不变。

### 10.2 索引回滚

- 新索引不改变业务数据和 authority，可在代码回滚后保留。
- 紧急回滚优先回滚应用版本，不要在故障窗口立即 `DROP INDEX` 制造第二次大写事务。
- 只有确认索引导致持续写入回退或磁盘风险，才在独立 no-writer 窗口删除目标索引。

### 10.3 WAL 回滚

- 使用现有 audited WAL maintenance rollback；
- Core/Agentic保持停止；
- 先 checkpoint/truncate，再切 DELETE；
- integrity/row-count异常时不重启，恢复到 fresh state directory中的已验证 backup。

---

## 十一、建议提交拆分

1. `perf(db): 增加 issue event 查询索引`
   - migration、schema tests、plan tests。
2. `perf(run): 按 issue 收敛 revision 查询`
   - `readRunRevision` scope、历史一致性测试、replay regression。
3. `perf(db): 覆盖 evidence 与 usage baseline 慢查询`
   - focused benchmarks、API/repository tests。
4. `perf(runtime): 错峰调度并补充 SQL 指标`
   - scheduler offsets、phase/query metrics。
5. WAL cutover 不与以上代码 commit 混合；它是按部署执行的运维变更，不是默认 startup 行为。

---

## 十二、最终优先级

| 优先级 | 工作 | 原因 |
| --- | --- | --- |
| P0 | `type,id` 索引 | 同时收敛 lifecycle、Handoff、Evidence、Work replay、usage baseline |
| P0 | normalized run-event partial index | 直接消除 `/api/system/status` 对99% `issue.log` 的 JSON全扫 |
| P0 | `readRunRevision` 增加 `issue_id` | 复用现有索引，减少每个 run command 的扫描面 |
| P0 | 新增 Evidence/usage baseline regression | 防止旧报告遗漏路径继续回归 |
| P0 | Provider status 快照 | 消除状态页同步外部 CLI 导致的秒级/几十秒 event-loop 阻塞 |
| P0 | connector history partial expression index | 消除每个状态请求的7次 `pi_action_events` 扫描，索引仅覆盖目标事件 |
| P1 | live WAL verify/条件 cutover | 解决读写锁结构问题，但不替代 SQL优化 |
| P1 | `eventErrors` 双策略或 project projection | recent-created 不会被当前 SQL 自动选中，必须按项目密度验证 |
| P1 | session event复合索引 | 仅在 live p95 达到门槛时增加，控制写放大 |
| P1 | projection追赶治理 | 避免水位落后时持续抢 writer/event loop |
| P2 | locator projection | 结构化事件本身增长后再实施，避免过早造第二 read model |
| P2 | retention容量治理 | 控制未来增长，必须保持archive/delete门禁 |

这份方案可以作为修复实施依据，但每个生产写操作仍需以 canonical live baseline、副本 rehearsal、fresh backup、no-writer 和验收门槛为前置条件。
