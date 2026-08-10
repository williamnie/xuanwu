# 数据库与 issue.log 存储评估（2026-08-07，修订版）

> 本文是一份**只读评估**，用于支持生产维护决策；不包含、也不授权直接执行任何破坏性操作
> （compaction / archive / delete / VACUUM / checkpoint / 迁移 / 重启 / 部署均不在本次范围内）。
> 所有数字注明采样时间、数据库路径与查询口径；容量预测区分"已执行 dry-run 支撑"与"SQL 推算（未验证）"。

---

## 1. 执行摘要

1. **真正的体积问题在线上 live DB，不在仓库。** 当前 Core 服务使用的 live DB 为
   `~/Library/Application Support/xuanwu-bun-live/state/runner.db`，文件 **1,566,085,120 B（≈1.46 GiB）**；
   仓库内 `data-bun/runner.db`（186 MB）只是 2026-05-31 前后的**离线旧快照**，其结论不能直接外推到线上。
2. **live DB 已有 27.9% 空闲页**：freelist 106,795 页 ≈ **437 MB**（历史删除留下，未回收）。
   且 live 库 `auto_vacuum=INCREMENTAL`，可用 `incremental_vacuum` 在线分段回收，不必先删数据。
3. live DB 中 `issue_events` 占 676.8 MB（43.2%，dbstat 口径含溢出页、不含索引），其中 `issue.log`
   530,839 行 / inline payload 550.8 MB。按保留策略分层（SQL 推算）：
   R1 增量流量 299.8 MB（>7 天部分 295.1 MB）、R2 持久快照 245.1 MB（>30 天部分 119.0 MB）、
   R3 审计 1.2 MB、REVIEW_REQUIRED 4.7 MB。**issue.log 不能完全停存**（§5 消费链），
   但 R1 层与超期 R2 层是主要可回收候选。
4. **issue.log 不是唯一大头**：`pi_action_events` 155.2 MB、`pi_actions` 82.2 MB、
   事件摘要投影（compact + payload dictionary）约 101 MB；另有旁支
   `codex-usage-index-v1.sqlite` 317 MB 与 artifacts 目录 125 MB（均在 state 目录、DB 之外）。
5. 代码侧的写入消减（normal 模式）**已在工作**：2026-08-01 之后的新增写入只剩
   `item/completed` / 压缩后的 cost 事件 / `turn/completed` / 预算截断 marker，没有 delta 洪流；
   近 14 天净增约 44.5 MB（≈3.2 MB/天）。当前体积主要是 5–7 月的历史存量 + 未回收 freelist。
6. consumer-zero 前提已满足：事件摘要投影 **read_version=v2**（2026-08-07T02:14Z 完成 cutover），
   v2 watermark 已覆盖到最大 event id。这解锁了"删源行、留摘要"的 retention 路径。
7. 推荐路径（本文不执行）：先做**零删除的 incremental VACUUM 基线回收**与 backup/restore 演练，
   再在受控维护窗口按 §8 顺序执行 archive → verify → delete evidence → writer quiesce → delete →
   integrity check → VACUUM → readback。所有 delete 类操作的实际可删量**必须**以维护窗口内
   对 live 备份副本的 dry-run 为准，本文只给出理论上限。

## 2. 评估范围与数据源

| 数据源 | 角色 | 说明 |
|---|---|---|
| `~/Library/Application Support/xuanwu-bun-live/state/runner.db` | **live DB**（Core 进程 pid 93581 经 `--db` 显式指定，launchd label `com.xiaobei.xuanwu.core`） | 只读测量（`mode=ro`），采样时间 2026-08-07T14:01–14:17Z |
| 仓库 `data-bun/runner.db` | **离线旧快照**（数据窗口 2026-05-21 → 05-31） | 允许执行只读 CLI dry-run（events report / compact-payloads），报告写 mktemp 临时目录，已清理 |
| 仓库 `data/` | 历史遗留目录（旧库拷贝、迁移演练备份、uploads、空文件） | 只盘点，不删除（§4.2） |
| `~/Library/.../state/artifacts/`、`codex-usage-index-v1.sqlite` | live DB 的旁支存储 | 只读测量 |
| 代码 `backend-ts/src/`（HEAD `8d81271`，与线上 runtime stamp `20260807T123657Z-8d8127113200-clean` 一致） | 链路核对 | 只读 |

运行态确认方式：`scripts/status-launchd.sh`（web/core/agentic 三进程 running，core role=core，
`sqlite=shared-file-serialized-writes`）+ `ps -p <core_pid> -o command=` 取得完整启动参数。

## 3. live DB 当前基线

路径：`/Users/xiaobei/Library/Application Support/xuanwu-bun-live/state/runner.db`
采样：2026-08-07T14:01–14:17Z，`sqlite3 "file:...?mode=ro"`（只读，不产生 WAL 写入）。

### 3.1 文件与页

| 指标 | 值 |
|---|---|
| DB 文件 | 1,566,085,120 B（382,345 页 × 4,096 B） |
| WAL / SHM | 424,392 B / 32,768 B（采样时） |
| **freelist** | **106,795 页 ≈ 437.4 MB（27.9%）** |
| journal_mode / auto_vacuum | `wal` / `2`（INCREMENTAL） |

### 3.2 对象占用（dbstat，含溢出页，不含 freelist）

| 对象 | 字节 | 占文件比 |
|---|---|---|
| `issue_events` | 676,798,464 | 43.2% |
| `pi_action_events` | 155,185,152 | 9.9% |
| `pi_actions` | 82,223,104 | 5.3% |
| `event_summary_projection_payloads`（v2 摘要字典） | 58,806,272 | 3.8% |
| `event_summary_projection_compact`（v2 主表） | 42,348,544 | 2.7% |
| `pi_guardian_event_inbox` | 25,624,576 | 1.6% |
| `issue_supervisor_events` | 10,743,808 | 0.7% |
| `issue_events` 两个索引合计 | 19,464,192 | 1.2% |
| 其余对象 | 各 < 0.5% | — |

### 3.3 issue_events / issue.log

- `issue_events` 共 538,102 行；`issue.log` 530,839 行，inline payload 合计 550,798,817 B
  （`SUM(LENGTH(payload))` 口径，不含页开销），时间窗 2026-05-21T06:18:32Z → 2026-08-05T03:08:04Z。
- 非 log 类型（`issue.status_changed` / `issue.created` / evidence / verification 等）合计约 6.0 MB，可忽略。
- inline 长度分桶：≤1 KB 425,952 行 / 175.7 MB；1–8 KB 96,503 行 / 214.8 MB；
  8–64 KB 8,384 行 / 160.2 MB；>64 KB 0 行（写入端 64 KB inline 上限在起作用）。
- **artifact 外置已在部分生效**：25,707 行带 `issue_log_artifact` 引用，原始 732.5 MB →
  gzip 落盘 157.4 MB（`stored_bytes` 求和口径；`du -sh artifacts/issue-logs` 报 124 M，16,596 个文件，
  两个口径差异未解释，见 §9），inline 摘要仍占 61.9 MB（行均 ≈2.4 KB）。

### 3.4 保留策略分层（SQL 复算 `retentionPolicy.ts` 分类规则；推算口径，非 CLI report）

| 层 | 行数 | inline 字节 | >7 天 | >30 天 |
|---|---|---|---|---|
| R1_OPERATIONAL（delta/updated/tokenUsage 等增量流量） | 383,552 | 299.8 MB | 381,366 行 / 295.1 MB | 332,127 行 / 178.5 MB |
| R2_DURABLE（`item/started` + `item/completed`） | 111,864 | 245.1 MB | 109,258 / 237.4 MB | 67,774 / 119.0 MB |
| R3_AUDIT（turn 边界/状态变更/error/approval） | 2,069 | 1.2 MB | — | — |
| REVIEW_REQUIRED（无 method 行、预算 marker 等） | 33,354 | 4.7 MB | — | — |

R2 细分：`item/completed` 54,059 行 / 148.5 MB；`item/started` 57,805 行 / 96.6 MB。
（复算时修正了一处口径陷阱：策略正则大小写不敏感，`item/commandExecution/outputDelta` 属 R1；
直接用大小写敏感的 SQL GLOB 会把它错分到 REVIEW_REQUIRED。）

### 3.5 投影与 consumer-zero 状态

- `event_summary_projection_switch`：`read_version=v2`，`cutover_at=2026-08-07T02:14:06Z`，
  观察窗 2026-08-05T02:23Z → 2026-08-07T02:23Z（已结束）。
- `event_projection_watermarks`：v2 `last_event_id=538,874`，等于 `issue_events.MAX(id)=538,874` → **全覆盖**；
  v1 watermark 为 0，旧 `event_summary_projection` 表 0 行（已空）。
- v2 主表 `event_summary_projection_compact` 538,102 行（覆盖全部 issue_events，含 issue.log 530,839 行，
  `source_payload_bytes` 合计 1.23 GB，为 hydrate 后口径）；payload 字典 133,608 行 / 47.7 MB
  （125,526 行 codec=1 已压缩）。
- 结论：**consumer-zero 前提（读侧 v2 + 摘要覆盖）当前成立**，是 retention delete 的必要条件之一。

### 3.6 issue 模式与新增速率

- `issues.issue_log_mode`：818 个 issue 全部 `normal`（debug 模式运行结束自动复位，
  `providerRuntime.ts:218`；历史 debug 写入的存量无法通过当前标志识别）。
- issue 状态：`done` 734 / `cancelled` 84 → 当前**没有** active / failed / pending_verification /
  needs_user 状态的 issue（retention 的 issue 保护类 blocker 当前为零，但这会随新 issue 变化）。
- 新增速率（近 14 天，2026-07-24 → 08-05）：13,874 行 / 44.5 MB ≈ **3.2 MB/天**，
  峰值日 2026-07-20 为 5,002 行 / 18.1 MB（疑似当日有 debug 运行或重任务）。
- 2026-08-01 之后写入的 method 仅：`item/completed`（2,460 行 / 7.2 MB）、
  `thread/tokenUsage/updated`（1,670 行 / 3.6 MB，normal 模式的压缩 cost 事件）、
  `turn/completed`（37 行）、预算截断 marker（30 行）——与 normal 模式代码预期一致（§5.1）。

### 3.7 旁支存储（state 目录内、runner.db 之外）

| 项 | 大小 | 说明 |
|---|---|---|
| `codex-usage-index-v1.sqlite` | 317,415,424 B（77,494 页，freelist 0） | usage 独立索引库：`events` 245 MB + `events_recent` 69 MB；**不在本评估范围内**，建议单独立项 |
| `artifacts/issue-logs/` | 124 M（du 口径）/ 157.4 MB（stored_bytes 求和） | issue.log gzip artifact，16,596 文件 |
| `artifacts/evidence-command-output/` | 208 K | 证据命令输出 |
| `uploads/`（live） | 63 行记录 | 用户上传 |

## 4. 离线旧快照对照

### 4.1 仓库 `data-bun/runner.db`（186,236,928 B；数据窗口 2026-05-21 → 05-31）

与 live 的关键差异：

| 维度 | 离线旧快照 | live DB |
|---|---|---|
| 文件大小 | 186 MB | 1.46 GiB |
| issue_events 行数 | 147,965 | 538,102 |
| issue.log inline payload | 145.8 MB | 550.8 MB |
| freelist | 35 页（≈0） | 106,795 页（437 MB） |
| artifact 引用行 | 0 | 25,707 |
| 投影 | v2 表不存在/未启用 | v2 已 cutover 且全覆盖 |
| 数据窗口 | 止于 2026-05-31 | 止于 2026-08-05 |

旧快照上**实际执行**的两个只读 CLI dry-run（`dist/xuanwu`，HEAD 与线上一致；
报告写 mktemp 目录，已清理；命令见附录 A.3）：

**(a) `maintenance events report`**（2026-08-07T14:10:55Z，扫描 147,965 行 / 147.9 MB）：

- classifications：`raw_operational` 105,103、`raw_durable` 8,704、`state_event` 791、
  `audit_event` 89、`review_required` 33,278；
- actions：`archive` 113,199、`keep` 34,766、**`delete_candidate` 0**；
- blockers（**计数互相重叠**，一行可同时有多个 blocker）：
  `archive_receipt_missing` 147,965、`destructive_gate_missing` 147,965、
  `summary_watermark_missing` 147,085、`run_state_unknown` 50,373、
  `source_deletion_disabled` 34,158、`review_required` 33,278、
  `non_successful_run` 3,527、`failed_run` 2,477、`active_issue` 615。
- 要点：即使数据全部超过 7/30 天，**"可归档"不等于"可删除"**——delete 需要逐 run 的成功态关联、
  summary watermark、archive receipt、destructive gate，当前全部为 missing；且相当比例事件
  关联不到成功 run（`run_state_unknown` / `non_successful_run` / `failed_run` 合计 56,877 行次）。

**(b) `maintenance events compact-payloads`（dry-run，未加 `--apply`）**：

- 候选 2,021 行（净节省 ≥4 KB 的 inline payload）；
- 源 inline 51,870,799 B → 压缩后 inline 摘要 13,275,692 B + 新增 artifact 5,209,673 B
  （按 4K 块对齐 9,433,088 B）；
- 估计净回收：**逻辑 33,385,434 B / 物理 29,162,019 B**（报告字段
  `estimated_net_reclaimable_bytes` / `estimated_physical_net_reclaimable_bytes`）；
- DB 文件不会因此变小：释放的是 freelist，需 VACUUM 才体现到文件大小。

### 4.2 仓库 `data/` 目录盘点（只盘点、不删除）

| 项 | 大小 | 类别与建议 |
|---|---|---|
| `data/app.db` | 173 M | 2026-05-31 的遗留库拷贝，issue_events 内容与离线旧快照完全一致（行数/字节相同）。**疑似冗余**，建议确认离线旧快照存在后归档移除 |
| `data/backups/p08-cutover/20260531T134318Z/` | 344 M | 5/31 迁移演练备份（`go-runner.db`、`bun-runner.db`、`rehearsal/runner.db` + smoke 输出）。**是备份不是垃圾**，建议整体转冷存储归档，确认前勿删 |
| `data/uploads/` | 1.7 M | 用户上传图片（2026-05），**业务数据，勿删** |
| `data/logs/` | 28 K | 旧 launchd/manual 日志 |
| `data/runner.db`、`state.db`、`xuanwu-legacy.db` | 各 0 B | 空占位文件，可随目录归档一并处理 |
| `data/auth_token` | 44 B | 旧 token 文件，随目录归档 |

整个 `data/` 合计约 519 M，但**不能**整体视为"无风险可删除"：其中包含迁移备份与用户上传。
建议动作是"分类归档 → 确认 → 清理"，本次不执行。

## 5. issue.log 写入与消费链（代码核对）

### 5.1 写入侧：normal 模式实际保留/丢弃什么

代码：`runner/issueLogPersistence.ts`（`normalModeEvent`，:220-228）、
`db/repositories/issueEvents.ts`（`recordIssueLogEvent` / artifact 外置，:154 起）。
live 2026-08-01 后的实际写入与下表一致（§3.6）。

normal 模式**保留**（每条都经紧凑化）：

- `error` / `done` / `turn/completed` / `protocol/error`；
- `item/completed`：`agentMessage` 保留终态 text + 必要快照 payload；`commandExecution` / 动态 exec
  压成 `terminal_tool_observation`（命令 ≤4 KB、输出摘要 ≤1.2 KB、cwd ≤1 KB，
  schema `xw.tool-observation.v1`）；
- 错误态 `thread/status/changed`；
- `thread/tokenUsage/updated` 只保留最终 cost 的压缩事件（剥离 text/payload，保留 `run_event`）。

normal 模式**丢弃**：所有 delta（agentMessage/commandExecution/fileChange outputDelta）、
`item/started`、`turn/diff|plan|taskProgress/updated`、常规 tokenUsage 流等协议增量。
debug 模式（按 issue 显式开启、运行结束自动复位 normal）才启用 delta 聚合分块
（64 事件/32 KB）、采样与每 method 预算（delta 64 行/2 MB；采样 64 行；生命周期快照 256 行/类型；
protected 1,024 行超限 fail-closed 抛错），>8 KB 的增量类 payload 写时即 gzip 外置到
`artifacts/issue-logs/`（64 KB inline 上限）。

### 5.2 消费侧：谁在读 issue.log，删掉会影响什么

| 消费方 | 位置 | 依赖字段 | 删除历史 issue.log 后的影响 |
|---|---|---|---|
| completionCard 命令还原 / 最终消息 | `domain/acceptance/completionCard.ts:185,334,520` | `command/status`、`terminal_tool_observation`、终态 `text` | **已建成卡的摘要仍在**（compact 投影保留 ≤1000 字符摘要）；但**从原始日志重建卡、回看完整命令输出的能力丧失** |
| runProgress / 停滞检测 | `db/repositories/runProgress.ts:177` 起 | `payload.run_event`（`NORMALIZED_RUN_EVENT_CONTRACT`） | 自述 `projection_mode="read_through_rebuild"`，source_of_truth 含 `issue_events`，**不是独立持久化投影**；但只对 `in_progress` run 重建，而 retention 对 active run 有 blocker，理论上不受影响；已完成 run 的进度回看能力丧失 |
| providerOutcome / terminal signals / projectSnapshot / sessionObserver / intentAudit / supervisor 上下文 | `providerOutcome.ts:121`、`providerTerminalSignals`、`pi/issueSupervisorContext.ts:60` 等 | `text/error`、近 N 条日志 | 均作用于进行中或刚结束的 run；历史数据删除不影响新 run，但**历史 issue 的失败诊断上下文不可回查** |
| 前端 RunDetail Execution logs / IssueDetailTimeline 终端 / Dashboard 实时流 | `pages/RunDetail.jsx:271`、`issue-detail/IssueDetailTimeline.jsx:328`、`Dashboard.jsx:193` | `text/error/status/command/raw_method` | 历史 issue 的执行日志页只剩 compact 摘要；实时流不受影响 |
| event_summary_projection（v2 compact） | `events/eventSummaryProjector.ts:94-144` | 写入时摘录 ≤16 KB，summary ≤1000 字符 | 删除源行后 v2 摘要**保留**（consumer-zero 设计） |
| cost / usage | `run_attempts.cost_json`（`runAttemptEvents.ts:16` 投影）、usage 索引库 | `runEvent.cost` | 已有独立投影，**不依赖 issue.log 存活** |

关键区分（回应"item/completed 属于哪一层"）：`item/started` 与 `item/completed` 同属
**R2_DURABLE**（`retentionPolicy.ts` `DURABLE_METHOD`），archive 30 天、source delete 30 天。
删除超期 R2 后：历史 Execution logs 的完整命令流与终态消息消失（compact 摘要仍在）；
completion card 的**重新构建**能力与 final message 全文回查能力丧失；
supervisor 恢复上下文对**历史** issue 不再可重建（对新 run 无影响）。

### 5.3 retention 删除时 v1/v2 摘要如何处理

`db/repositories/eventMaintenance.ts` `deleteIssueEventBatch`：删 `issue_events` 源行时**同步删除
v1 `event_summary_projection` 对应行**；v2（`event_summary_projection_compact` + payload 字典）
**不删**——这正是 prepare-delete-evidence 强制 `read_version=v2` + v2 watermark 覆盖的原因
（`maintenanceService.ts` `prepareEventDeleteEvidence`）。live 当前 v1 表已空、v2 全覆盖，条件满足。

### 5.4 archive_only 与 delete_enabled 的真实区别

- `archive_only`：只把到期事件写入 archive 目录（gzip chunk + manifest + receipt + restore 演练），
  **源行保留，DB 不会变小**；它不是防膨胀手段，只是 delete 的前置证据链环节。
- `delete_enabled`：要求 `execution_authorization`（含 `observation_window_ref` 与
  `restore_test_ref`），实际由 `prepare-delete-evidence` 生成 evidence 文件后，
  `delete --apply --confirm-backup-tested --confirm-no-active-writers` 才执行分批删除
  （checkpoint 可 resume）。

### 5.5 完整门禁链（代码核对 `events/maintenanceService.ts`）

1. **report**（只读）：分类与 blocker 预览。
2. **archive**：只读开库；磁盘预检；逐批评估 `action=archive` 的行写 gzip chunk；
   完成后做 **restore rehearsal**（恢复演练通过才生成 receipt）；manifest 置 immutable。
3. **verify-archive**：校验 manifest 与行 sha256。
4. **prepare-delete-evidence**：要求 backup 库是独立副本、与 archive 源快照一致、
   `quick_check=ok`、**备份 mtime ≤24 小时**；`read_version=v2`（consumer-zero）；
   v2 watermark ≥ archive 快照 max id；可附 holds 文件；输出 evidence（内含
   summary watermark、destructive gate=allow、`writer_quiesce{active_writers:0}`）。
   注意：**writer quiesce 是 actor 自证 + CLI flag 确认，不是强制互斥锁**——
   在 Core 在线写库时执行 delete 依赖人工保证无写入，这是设计上的薄弱环节。
5. **delete --apply**：双 confirm flag；快照三重断言（archive/evidence/当前库一致）；
   磁盘预检；分批删除 + checkpoint；同步清 v1 摘要行；写审计事件。
6. **db checkpoint / db vacuum**：同样双 confirm；live 库 `auto_vacuum=INCREMENTAL`，
   `incremental_vacuum` 可直接分段回收 freelist；full VACUUM 需短时排他。

## 6. compaction / retention / VACUUM 的 dry-run 证据与预测

### 6.1 已执行（离线旧快照，证据充分）

见 §4.1：events report（archive 113,199 / keep 34,766 / delete_candidate 0，blockers 重叠计数）
与 compact-payloads dry-run（2,021 候选行，物理净回收估计 29.2 MB）。

### 6.2 live DB 预测（SQL 推算，**未经维护窗口 dry-run 验证**）

| 动作 | 理论候选量（live，§3.4） | 预测性质 |
|---|---|---|
| incremental VACUUM 回收现有 freelist | ≤437 MB 文件收缩 | freelist 是实测值；零删除、最低风险 |
| payload compaction（8–64 KB 的 8,384 行 / 160.2 MB 为主要候选） | 逻辑净回收量级约 100–140 MB；新增 artifact 约 15–25 MB | **区间推算**，候选精确值需在 live 备份副本上跑 compact-payloads dry-run |
| archive R1 >7 天 | 381,366 行 / 295.1 MB inline | 分类为 SQL 复算；archive 本身不缩 DB |
| delete R1 >7 天 | 上限同上；实际 eligible 取决于 run 关联（离线快照 run 类 blocker 行次占比 ≈38%，live 未知） | **不可直接引用上限做决策** |
| archive+delete R2 >30 天 | 67,774 行 / 119.0 MB | 影响面见 §5.2（历史日志重建能力丧失） |
| R3 / REVIEW_REQUIRED | 策略上 source_delete 禁用 | 不可删 |

### 6.3 预测误差与未验证项

- live 的 compaction 候选数、artifact 压缩率未实测（离线快照 artifact 比 ≈10×，不可直接外推）；
- delete 的实际 eligible 量取决于 prepare-delete-evidence 时的 run 状态关联，live 未测；
- freelist 437 MB 的构成（哪些对象释放的页）未测，incremental VACUUM 的实际收缩量以执行为准；
- artifact 目录两个容量口径（du 124 M vs stored_bytes 157.4 MB）未对齐。

## 7. 方案对比表

| 方案 | DB 文件影响 | 磁盘净变化 | 语义影响 | 风险 | 证据强度 |
|---|---|---|---|---|---|
| A. incremental VACUUM（在线分段） | 最多 -437 MB | 同左 | 无 | 低（IO 开销） | freelist 实测 |
| B. payload compaction（历史 inline → artifact） | 释放为 freelist，需配合 A | 逻辑净省约 100–140 MB（推算） | 无（读侧自动 hydrate） | 低-中 | 离线 dry-run + live 推算 |
| C. R1 archive（不删） | 无 | archive 目录 +数十 MB（gzip） | 无 | 低 | 离线 report + live 分类推算 |
| D. R1 delete（evidence 齐全后） | 上限 295 MB inline → freelist | 删除后净省 = inline - archive 占用 | 历史增量协议流量不可回查（摘要仍在） | 中 | 上限推算，eligible 未验证 |
| E. R2 超期 archive+delete | 上限 119 MB inline → freelist | 同上 | **历史命令流/终态消息/重建能力丧失**（§5.2） | 中-高 | 上限推算 |
| F. `data/` 分类归档 | 不影响 DB | 最多约 519 M（含 344 M 备份与 1.7 M uploads） | 无（不删业务数据） | 低（需确认） | 已盘点 |
| G. usage 索引库 / pi_* 表治理 | 另行评估 | 317 MB + 263 MB 量级 | 未评估 | 未定 | 仅记录 |

推荐组合：**A → F → B → C →（证据齐全且业务确认后）D**；E 仅在明确接受历史日志不可重建后考虑；
G 另立项。

## 8. 推荐路径及安全门禁（本次不执行）

1. **live baseline**：复跑 §3 全部只读测量并留档（含 dbstat、freelist、watermark）。
2. **backup / restore rehearsal**：产出 ≤24h 的新鲜备份并验证 quick_check 与恢复
   （`docs/backup-restore.md`），这是后续一切 delete 的硬前提。
3. **compact 投影覆盖确认**：live 已满足（v2 cutover 完成、watermark 全覆盖，§3.5），
   维护窗口前复核即可。
4. **（可选）payload compaction**：先在备份副本上 dry-run 取得精确候选，再 `--apply`（双 confirm）。
5. **archive**：R1（先行）/ 超期 R2（业务确认后）；完成后 `verify-archive`。
6. **prepare-delete-evidence**：备份快照一致 + consumer-zero + holds。
7. **writer quiesce**：由于 quiesce 只是自证（§5.5-4），建议维护窗口内**停止 Core/heartbeat
   写入或等效措施**，杜绝正常写库绕过 no-active-writers 确认。
8. **delete --apply**：分批 + checkpoint，可中断 resume。
9. **完整性检查**：quick_check / integrity_check、投影 watermark 复核、前端抽查。
10. **VACUUM**：优先 incremental（在线分段）；full VACUUM 仅在可排他时。
11. **readback / smoke**：`scripts/status-launchd.sh` + 前端关键页面 + runs/sessions API 抽查。

在线自动化边界：常驻流程（Core/heartbeat）**只应**做容量采集、dry-run report 与告警；
destructive retention 与 VACUUM 永远走上述人工维护窗口，不允许自动化绕过门禁。
`archive_only` 不删源行，不能当作防膨胀机制；防膨胀依赖"写入侧 normal 模式（已生效）+
定期维护窗口"的组合。

## 9. 未验证风险

1. live 的 compaction / retention delete **未做真实 dry-run**（本次约束只允许离线旧库），
   §6.2 全部为推算；尤其 delete 的 run 关联 eligible 量未知。
2. writer quiesce 为自证机制（§5.5-4），维护窗口的"停写"措施本身未设计/未演练。
3. artifact 目录容量口径不一致（du 124 M vs stored_bytes 157.4 MB）未解释；
   artifact 的备份覆盖情况未核对。
4. `pi_action_events`（155 MB）/ `pi_actions`（82 MB）/ `pi_guardian_event_inbox`（26 MB）
   与 `codex-usage-index-v1.sqlite`（317 MB）未做同等深度评估。
5. freelist 437 MB 的来源与 incremental VACUUM 在线执行的 IO 影响未实测。
6. 2026-07-20 单日 18 MB 写入的原因未定位（疑似 debug 运行；若常态出现需复查模式复位逻辑）。
7. 前端"Advanced raw events"全文视图在 compaction 后依赖 artifact hydrate，
   retention delete 后彻底不可读；UX 影响未与产品确认。
8. 本评估基于 2026-08-07 下午的单次采样；live 库随运行持续变化。

## 附录 A. 可复查命令与 SQL

### A.1 运行态与路径确认

```bash
./scripts/status-launchd.sh
ps -p <core_pid> -o command=   # --db 参数即 live DB 路径
ls ~/Library/LaunchAgents/ | grep xuanwu
```

### A.2 live DB 只读测量（`mode=ro`，采样 2026-08-07T14:01–14:17Z）

```bash
LIVE="$HOME/Library/Application Support/xuanwu-bun-live/state/runner.db"
DB="file:${LIVE// /%20}?mode=ro"
sqlite3 "$DB" "PRAGMA page_count; PRAGMA page_size; PRAGMA freelist_count; PRAGMA journal_mode; PRAGMA auto_vacuum;"
sqlite3 "$DB" "SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 15;"
sqlite3 "$DB" "SELECT COUNT(*), SUM(LENGTH(payload)), MIN(created_at), MAX(created_at)
               FROM issue_events WHERE type='issue.log';"
sqlite3 "$DB" "SELECT COUNT(*), SUM(json_extract(payload,'$.issue_log_artifact.bytes')),
               SUM(json_extract(payload,'$.issue_log_artifact.stored_bytes'))
               FROM issue_events WHERE type='issue.log' AND payload LIKE '%issue_log_artifact%';"
sqlite3 "$DB" "SELECT * FROM event_summary_projection_switch;
               SELECT * FROM event_projection_watermarks;"
sqlite3 "$DB" "SELECT issue_log_mode, COUNT(*) FROM issues GROUP BY 1;
               SELECT status, COUNT(*) FROM issues GROUP BY 1;"
# 分层分类（注意 lower()，策略正则大小写不敏感）：
sqlite3 "$DB" <<'SQL'
WITH c AS (
  SELECT lower(COALESCE(json_extract(payload,'$.raw_method'),'')) m,
         LENGTH(payload) b, created_at
  FROM issue_events WHERE type='issue.log'
)
SELECT CASE
    WHEN m GLOB '*delta*' OR m GLOB '*updated*' OR m GLOB '*tokenusage*'
      OR m GLOB '*moderationmetadata*' OR m GLOB '*startupstatus*'
      OR m GLOB '*terminalinteraction*' OR m GLOB '*thread/goal/cleared*' THEN 'R1'
    WHEN m IN ('item/started','item/completed') THEN 'R2'
    WHEN m GLOB 'turn/started' OR m GLOB 'turn/completed' OR m GLOB 'thread/status/changed'
      OR m GLOB '*error*' OR m GLOB '*approval*' THEN 'R3'
    ELSE 'REVIEW' END tier,
  COUNT(*), SUM(b),
  SUM(created_at < '2026-07-31'), SUM(CASE WHEN created_at < '2026-07-31' THEN b ELSE 0 END),
  SUM(created_at < '2026-07-08'), SUM(CASE WHEN created_at < '2026-07-08' THEN b ELSE 0 END)
FROM c GROUP BY 1;
SQL
```

### A.3 离线旧快照 dry-run（本次已执行，临时报告已清理）

```bash
cd /Users/xiaobei/Documents/xiaobei/codex-issue-runner
TMPD=$(mktemp -d)
./dist/xuanwu maintenance events report \
  --db data-bun/runner.db --report "$TMPD/events-report.json" --json
./dist/xuanwu maintenance events compact-payloads \
  --db data-bun/runner.db --checkpoint "$TMPD/compact-checkpoint.json" \
  --report "$TMPD/compact-report.json" --json   # 无 --apply = dry-run
rm -rf "$TMPD"
```

## 附录 B. 代码观察（与存储评估弱相关，未做可删除性验证）

阅读链路时注意到、但**未验证可删除**（"没有生产引用"不等于死代码）：

- `runner/piAutoManageScheduler.ts:213` 注释称 legacy Cron/PI/delegation scheduler 不再调用，
  `cronTasks` / `cronTaskWrites` / `piAutomationCommands` 仓储未见生产引用；
- `spikes/` 仅 dev smoke 引用；`evals/` 未见生产引用；`xuanwu/issueEventsStorageAudit.ts` 未见调用方。

以上仅为线索，是否清理需单独评估，与数据库存储治理无直接关系。
