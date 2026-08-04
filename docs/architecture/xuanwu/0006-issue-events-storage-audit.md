# XW P01.01：`issue_events` / `issue.log` 存储审计

状态：accepted（2026-07-16）

依赖：XW P00.05（issue 635，`done`）

## 1. 结论

本次在正式 launchd 数据库的在线备份副本上复现了膨胀：当前数据库为 **960,643,072 bytes（960.64 MB / 916.14 MiB）**，共有 **461,228** 条 `issue_events`，payload 合计 **832,201,445 bytes（832.20 MB）**。其中 `issue.log` 占 458,071 行（99.32%）和 832,051,627 payload bytes（99.98%）。issue 描述中的约 949 MB / 45.7 万行 / 772 MB 是更早的观测，不是统计口径冲突。

根因是当前 provider runtime 对每个 provider notification 都落一条 `issue.log`：provider normalization 先把完整通知序列化到 `event.raw.payload`，`recordIssueLogEvent()` 又把该 raw envelope 与抽取后的 `text` / `command` / `payload` / `status` 等字段一起写入同一 JSON payload。高频 delta 与重复的全量 diff 因而同时放大行数和单行大小。

当前 source HEAD 与 deployed runtime `16fee2e2a0e0` 在以下写入链上无 diff，因此这不是 stale source 推断：

- `backend-ts/src/providers/codex/events.ts`
- `backend-ts/src/providers/claude/stream.ts`
- `backend-ts/src/runner/providerRuntime.ts`
- `backend-ts/src/db/repositories/issueEvents.ts`

本 issue 只增加只读审计工具、测试和 canonical 报告；不修改 schema、provider adapter、runtime 写入或保留策略。

## 2. 审计边界与只读审计命令

当前样本：2026-07-16 00:02（Asia/Shanghai）对正式库执行 SQLite online backup 后得到的 `/tmp/xuanwu-issue637/runner-20260716T0002.db`。增长基线是已有备份 `runner.db.before-issue-project-move-20260713T145510Z`。工具始终用 `readonly: true` 打开输入库并设置 `pragma query_only=on`，不输出 payload、issue title 或 payload preview；重复样本只输出 SHA-256 指纹和大小。

先创建一致性备份：

```bash
LIVE_DB="$HOME/Library/Application Support/xuanwu-bun-live/state/runner.db"
SNAP_DB="/tmp/runner-audit-$(date +%Y%m%dT%H%M%S).db"
LIVE_DB="$LIVE_DB" SNAP_DB="$SNAP_DB" python3 - <<'PY'
import os, sqlite3
source = sqlite3.connect(f"file:{os.environ['LIVE_DB']}?mode=ro", uri=True)
target = sqlite3.connect(os.environ["SNAP_DB"])
try:
    source.backup(target, pages=4096, sleep=0.01)
finally:
    target.close()
    source.close()
PY
```

执行审计并把敏感度受控的 JSON 保存在仓库外：

```bash
cd backend-ts
bun run scripts/audit-issue-events.ts \
  --db /tmp/runner-current.db \
  --baseline /tmp/runner-baseline.db \
  --top 20 > /tmp/issue-events-audit.json
```

可独立复现主要分布的 SQL（必须在备份副本或 `mode=ro` / immutable 连接上执行）：

```sql
-- 总量与 payload bytes；BLOB length 按 UTF-8 bytes 而非字符计数
select type, count(*) as rows,
       sum(length(cast(payload as blob))) as payload_bytes
from issue_events group by type order by payload_bytes desc;

-- 项目 / issue 分布；不读取 title
select i.project_id, e.issue_id, count(*) as rows,
       sum(length(cast(e.payload as blob))) as payload_bytes
from issue_events e join issues i on i.id=e.issue_id
group by i.project_id, e.issue_id order by payload_bytes desc;

-- provider / raw method 分布；不返回 raw payload
select coalesce(json_extract(payload, '$.provider'), 'unknown') as provider,
       coalesce(json_extract(payload, '$.raw_method'), 'unknown') as raw_method,
       count(*) as rows, sum(length(cast(payload as blob))) as payload_bytes
from issue_events
where type='issue.log' and json_valid(payload)
group by provider, raw_method order by payload_bytes desc;

-- 日增长序列
select substr(created_at, 1, 10) as day, count(*) as rows,
       sum(length(cast(payload as blob))) as payload_bytes
from issue_events group by day order by day;
```

## 3. 分布证据

### 3.1 物理占用与 payload 组成

| 指标 | bytes | 占比 |
| --- | ---: | ---: |
| 数据库文件 | 960,643,072 | 100% |
| `issue_events` table pages | 920,850,432 | 95.86% |
| `idx_issue_events_issue_type` | 10,563,584 | 1.10% |
| 全部 event payload | 832,201,445 | 86.63% of DB file |
| `issue.log` payload | 832,051,627 | 99.98% of event payload |
| `issue.log.$.raw_payload` 解码后文本 | 610,141,527 | 73.3% of `issue.log` payload |
| `issue.log.$.text` | 58,908,967 | 字段可与 raw envelope 重叠 |
| `issue.log.$.payload` | 65,320,034 | 字段可与 raw envelope 重叠 |
| `issue.log.$.command` | 14,713,227 | 字段可与 raw envelope 重叠 |

字段 bytes 是 JSON 解码后的字段长度，只用于归因，字段之间可能包含同一内容，不能相加当作可直接回收空间。

### 3.2 raw method / provider

| provider / raw method | 行数 | payload bytes | 全部 payload 占比 | 保留价值 |
| --- | ---: | ---: | ---: | --- |
| codex / `turn/diff/updated` | 12,328 | 291,378,637 | 35.01% | R1 operational |
| codex / `item/completed` | 33,107 | 231,285,797 | 27.79% | R2 durable |
| codex / `item/commandExecution/outputDelta` | 93,380 | 131,503,471 | 15.80% | R1 operational |
| codex / `item/started` | 39,538 | 81,780,172 | 9.83% | R2 durable |
| codex / `item/agentMessage/delta` | 226,214 | 79,812,311 | 9.59% | R1 operational |
| codex / `thread/tokenUsage/updated` | 16,583 | 6,699,532 | 0.81% | R1 operational |
| unknown / unknown | 33,140 | 4,716,140 | 0.57% | review required |
| codex / `turn/moderationMetadata` | 66 | 3,061,041 | 0.37% | R1 operational |

provider 汇总为：`codex` 424,931 行 / 827,335,487 bytes；无 provider 的 legacy normalized rows 33,140 行 / 4,716,140 bytes。本快照没有 Claude provider 数据，因此只能审计其代码路径，不能用这份 live 样本量化 Claude 占用。

### 3.3 项目与 issue

| project | 行数 | payload bytes | bytes 占比 |
| --- | ---: | ---: | ---: |
| `xuanwu` | 370,192 | 633,128,628 | 76.08% |
| `movo-mobile` | 54,850 | 115,055,961 | 13.83% |
| `movo-web` | 35,651 | 83,962,336 | 10.09% |
| `xiecheng` | 462 | 52,863 | <0.01% |
| `tprcardagent` | 71 | 1,640 | <0.01% |
| `asr` | 2 | 17 | <0.01% |

按 payload bytes 排名前十的 issue（不输出标题或 payload）：

| issue | project | 行数 | payload bytes |
| ---: | --- | ---: | ---: |
| 392 | `xuanwu` | 2,451 | 19,168,908 |
| 475 | `xuanwu` | 3,781 | 18,088,349 |
| 299 | `movo-web` | 2,062 | 16,224,727 |
| 61 | `xuanwu` | 8,169 | 12,781,609 |
| 62 | `xuanwu` | 11,304 | 10,162,052 |
| 78 | `xuanwu` | 1,348 | 9,791,685 |
| 602 | `xuanwu` | 3,666 | 8,894,573 |
| 626 | `xuanwu` | 905 | 8,525,394 |
| 511 | `movo-mobile` | 2,134 | 7,804,031 |
| 310 | `xuanwu` | 1,072 | 7,120,842 |

## 4. 增长率

基线最后 event 为 `2026-07-13T14:50:29Z`，当前最后 event 为 `2026-07-15T16:02:03Z`，间隔 177,094 秒（2.05 天）：

| 指标 | 增量 | 每日速率 |
| --- | ---: | ---: |
| `issue_events` 行数 | +9,276 | +4,525.5 rows/day |
| payload | +32,973,735 bytes | +16,087,110 bytes/day（16.09 MB/day） |
| raw payload 字段 | +21,688,807 bytes | +10,581,459 bytes/day（10.58 MB/day） |
| database file | +39,747,584 bytes | +19,391,912 bytes/day（19.39 MB/day） |

若该 2.05 天 workload 线性持续，数据库文件约增加 581.8 MB / 30 天；这只是短窗实测速率，不是容量承诺。按日序列存在明显 burst（例如 2026-07-06 为 33,514 行 / 64.54 MB），容量规划必须保留峰值余量。

## 5. 重复样本

工具按 `sha256(type + NUL + payload)` 流式扫描，不保存或输出 payload。当前得到：

- 313,496 个唯一 type+payload；
- 34,781 个重复组；
- 147,732 个重复行（32.03% of rows）；
- 理论重复 payload bytes 286,660,680（286.66 MB，34.4% of payload）。

最大重复组示例：

| fingerprint（前 12 位） | raw method | occurrences | bytes/row | redundant bytes |
| --- | --- | ---: | ---: | ---: |
| `bf867670d3bd` | `turn/diff/updated` | 51 | 68,692 | 3,434,600 |
| `cf4b0a6854ad` | `turn/diff/updated` | 64 | 52,701 | 3,320,163 |
| `faa60bd84d85` | `item/commandExecution/outputDelta` | 2,975 | 719 | 2,138,306 |
| `baa843b0a8fb` | `turn/diff/updated` | 24 | 91,842 | 2,112,366 |
| `0d01e758d99e` | `turn/diff/updated` | 36 | 54,347 | 1,902,145 |

“payload 相同”不等于“event 可直接删除”：不同 event ID、issue、时间与顺序仍可能是执行 timeline、Guardian source reference 或 terminal detection 的证据。286.66 MB 只是 payload-level 优化上限，不是 SQLite 可立即回收值。

## 6. 保留价值分类

本工具做保守的审计分类，不执行 retention：

| 分类 | 当前 rows / payload bytes | 判定 |
| --- | --- | --- |
| R3_AUDIT | 4,306 / 559,866 | issue lifecycle、turn terminal/error、status；保持不可变审计 |
| R2_DURABLE | 72,645 / 313,065,969 | `item/started` / `item/completed` 完整证据；迁移前长期保留 |
| R1_OPERATIONAL | 350,750 / 513,834,702 | delta、diff、token/plan/status update；最有压缩/外置价值，但仍有 live consumer |
| REVIEW_REQUIRED | 33,527 / 4,740,908 | unknown / legacy 形态；先补 consumer 与 provenance 映射 |

R1 不是删除许可。完整 `issue_events` 表仍沿用 P00.05 的 R3_AUDIT 表级策略，直到 row-level 迁移和回滚门禁另行通过。

## 7. 风险报告

| 风险 | 证据 | 影响 | 当前处置 |
| --- | --- | --- | --- |
| 容量持续增长 | DB +19.39 MB/day；`issue_events` pages 占 95.86% | 备份、启动、查询和磁盘余量继续恶化 | P01.01 只量化；后续先设计可回滚压缩/外置 |
| raw envelope 与 normalized 字段重叠 | `raw_payload` 610.14 MB；另有 text/payload/command 138.94 MB | 同一 provider 内容多形态落盘 | 不提前删 raw；先固定 normalized parity 与 artifact ref |
| exact duplicate 不能按 payload 直接删 | 147,732 duplicate rows；event ID 仍可被引用 | 破坏 timeline、Guardian/source refs、重放顺序 | 未来迁移必须保留 event identity/ordering 或提供映射 |
| live consumer 仍读取 raw | `meaningfulProgress.ts`、`providerErrorParser.ts`、`providerTerminalSignals.ts`、session/Issue UI | 删除 raw 会改变恢复、错误诊断和 UI | 本期不改 runtime；建立 consumer matrix 后再 shadow read |
| 部分内部读无界 | 多个 `listIssueEvents(db, issueID)` 调用不传 limit；top issue 已达 11,304 rows / 19.17 MB | 单 issue 上下文构建的内存/延迟风险 | 单独 issue 做分页/聚合，不在本期改公共读合同 |
| provider 覆盖不完整 | live 样本只有 Codex；Claude normalizer 同样保留 full raw | 无法外推 Claude 大小分布 | 上线 Claude workload 后复跑同一工具 |

## 8. 兼容、迁移与最终删除门禁

- `issue_events` 仍是唯一 source of truth；本期不建第二套 Evidence 表。
- 不引入双写或双读，现有 Issue / Session / Guardian / PI 消费路径完全不变。
- 回滚：本 issue 没有 runtime/schema 状态变更；移除审计脚本和文档即可，备份副本位于仓库外。
- 任何未来 compact/blob-ref 模型只能先 shadow read compare，旧 `issue_events.payload` 继续唯一写 authority；双写必须有显式期限、逐 event parity 指标和失败回退。
- **最终删除门禁**：完成所有 raw/normalized consumer matrix；证明 Issue terminal、Session transcript、meaningful progress、provider error、Guardian source refs 与 PI context parity；保存 event ID/issue/time/order/provenance 映射；完成备份恢复演练与 checksum；经过至少一个 release observation window；有审计记录的迁移批准与可执行 rollback 后，才可删除旧 payload。

因此，P01.01 的结论是“膨胀已量化且主因明确”，不是“可立即清理 286.66 MB”。后续治理应优先处理 `turn/diff/updated`、`item/completed` 与 command/message delta 的表示方式，同时保持当前 authority 和行为。
