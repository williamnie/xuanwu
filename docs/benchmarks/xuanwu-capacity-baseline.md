# XW P10.09：性能、容量与事件增长基准

- 路线 issue：XW P10.09 / Runner #732
- 硬依赖：P01.05 / #641、P02.07 / #653、P03.06 / #661，均已完成
- 报告 schema：`xuanwu.capacity-benchmark.v1`
- 基准环境：macOS 15.7.7、arm64、12 logical CPUs、24 GiB RAM、Bun 1.3.10

> **历史基线，不是当前 Runner 内存预算 authority。** 本文及 2026-07-18 JSON 中的 `1 GiB` 单进程 ceiling 仅保留为历史对照，不得恢复或用于放行。当前门禁以 `PROCESS_GROUP_MEMORY_BUDGETS`、`/api/system/status.process_group_memory` 和带 baseline Evidence/review 的 `memory-run` 报告为准。macOS 预算权威值由非挂起的 `proc_pid_rusage(RUSAGE_INFO_V4).phys_footprint` 提供；进程内 RSS、进程组 RSS P95、heap/external/array buffer 继续作为诊断与回归口径。只有内核物理测量不可用时才显式回退到 RSS，且 API 必须暴露 `measurement_source`，不得把不可用的 footprint 写成 `0`。

## 结论

当前正式库副本和补充合成容量集均通过预算。正式库副本的主要热路径是 Runs 首屏和长 Timeline 首屏；P95 分别为 `779.04 ms` 和 `725.05 ms`。当前事件 raw + summary projection 增长率为 `1,881.01 bytes/event`，低于 `4,096 bytes/event` 预算。

结构化回归基线：

- `docs/benchmarks/xuanwu-capacity-formal-baseline-2026-07-18.json`
- `docs/benchmarks/xuanwu-capacity-synthetic-baseline-2026-07-18.json`

## 数据集与方法

### 正式库规模副本

基准通过 `bun:sqlite` 的一致性 serialization 创建新文件，再只在副本上执行当前源码的 migration 和 projection catch-up。工具拒绝覆盖已有 DB；`run` 必须显式传 `--confirm-copy`，避免误写 live DB。

正式库基线：

| 维度 | 数量 |
| --- | ---: |
| Projects | 11 |
| Issues | 744 |
| Issue events | 507,885 |
| Summary projections | 507,885 |
| Runs / Attempts | 718 / 718 |
| Agent sessions | 566 |
| Active Runs | 1 |
| 单项目最大 Issues | 619 |
| 单 Issue 最大 events | 11,304 |
| DB allocated | 954.5 MiB |

正式运行态副本尚无 native Automation 数据。因此 Automation、多项目和 8 并发 Run 的容量证据由同一 generator 生成的补充数据集提供，不把空表结果冒充 Automation 容量证据。

### 补充合成容量集

| 维度 | 数量 |
| --- | ---: |
| Projects | 20 |
| Issues | 1,000 |
| Issue events / projections | 20,000 / 20,000 |
| Runs / Attempts | 2,000 / 2,000 |
| Agent sessions | 1,000 |
| Active Runs | 8 |
| Automations | 500 |
| Automation runs / events | 2,500 / 10,000 |

生成器写入独立新 DB，复用当前 migrations、`issue_events` summary projector、Run/Attempt trigger 和 native Automation 表；不增加 schema、第二套 projection 或 runtime authority。

## P50 / P95 结果

| Workload | 正式库 P50 / P95 | 合成集 P50 / P95 | 预算 P50 / P95 |
| --- | ---: | ---: | ---: |
| Projects frontend list | 0.04 / 0.06 ms | 0.04 / 0.06 ms | 20 / 50 ms |
| Issues frontend page 100 | 1.44 / 1.77 ms | 0.20 / 0.22 ms | 50 / 100 ms |
| Session project catalog | 0.35 / 0.40 ms | 0.06 / 0.07 ms | 100 / 250 ms |
| Runs frontend page 100 | 672.82 / 779.04 ms | 25.05 / 29.41 ms | 750 / 1,500 ms |
| Active Run projection, max 8 | 49.05 / 61.39 ms | 5.84 / 6.92 ms | 750 / 1,500 ms |
| Automations frontend list 500 | N/A（0 rows） | 15.24 / 16.99 ms | 250 / 500 ms |
| Long Timeline first 60 | 670.91 / 725.05 ms | 5.31 / 7.32 ms | 750 / 1,500 ms |

每个 workload 使用 2 次 warm-up 和 20 次计时样本；P50/P95 使用 nearest-rank。正式库和合成集均无超预算项。`event_summary_projection` Timeline 查询计划命中 `idx_event_summary_projection_issue`。Issues 和 Runs 列表命中现有过滤索引，但排序仍显示 temporary B-tree；当前延迟在预算内，故本 issue 不扩成索引/schema 改造。

## 增长和资源预算

| 指标 | 预算 | 正式库 | 合成集 |
| --- | ---: | ---: | ---: |
| Raw + projection bytes/event | <= 4,096 B | 1,881.01 B | 1,203 B |
| Projection lag | 0 | 0 | 0 |
| DB alert threshold | 10 GiB | 954.5 MiB | 32.3 MiB |
| Process peak RSS | <= 1 GiB | 699.0 MiB | 199.0 MiB |
| Process RSS growth | <= 896 MiB | 618.3 MiB | 122.3 MiB |

按正式库实测速率，新增 10,000 events 约增长 `17.9 MiB`；最坏预算为 `39.1 MiB/10,000 events`。容量规划必须同时观察 DB allocated、bytes/event 和 projection lag，不能只用 event count。

## 容量指导

- **Runtime：** 单 runner 至少分配 2 GiB 可用内存；1 GiB RSS 是基准失败门禁而非推荐机器总内存。达到 80% RSS budget 时先调查 Runs/Timeline 扫描和 SQLite page cache，再提高并发。
- **并发 Run：** 保持现有全局 `max_parallel_projects <= 8`。本基准证明 8 个 active Run projection 的读侧预算；不代表外部 provider、网络或 8 个真实 executor 的端到端吞吐。提高上限必须由独立 soak issue 提供 provider 和 runtime 证据。
- **大库：** DB 到 7 GiB 开始安排备份恢复、归档/compaction rehearsal；10 GiB 为容量 alert/fail。任何删除仍必须走现有 retention、hold/reference、backup 和 destructive approval 门禁。
- **长 Session / Timeline：** provider transcript 仍由 provider authority 持有；SQLite 基准只覆盖 `agent_sessions` catalog 和 11,304-event Work Timeline。Timeline 前端继续使用 60-row keyset page，不一次加载全历史。
- **前端列表：** Issues/Runs 维持 100-row page，Sessions provider page 维持 50，Timeline 维持 60；Automation API 当前上限 500。该基准测量后端列表投影，不替代真实浏览器 DOM/render profiling。
- **Automation：** 正式库 native rows 为 0，当前容量指导以 500 definitions、2,500 runs、10,000 events 合成集为依据；首次正式数据达到 100/500 Automation 时应各刷新一次正式基线。
- **事件增长：** projection lag 必须为 0；任意 lag、bytes/event > 4 KiB 或 P95 超预算都阻止回归报告通过。

## 回归门禁

候选报告必须同时满足绝对预算。提供 `--baseline` 时，如果某 workload 的 P95 同时增加超过 `25%` 和 `5 ms`，即使仍低于绝对预算也判定 regression。基线比较应使用同一机器、Bun 版本、样本数和相近数据副本。

```bash
# 1. 创建一致性副本；output 必须不存在
bun scripts/xuanwu-capacity-benchmark.ts snapshot \
  --source /path/to/live/runner.db \
  --output /tmp/runner-capacity-copy.db

# 2. 正式库副本基准和回归比较
bun scripts/xuanwu-capacity-benchmark.ts run \
  --db /tmp/runner-capacity-copy.db \
  --confirm-copy \
  --label formal-library-copy \
  --samples 20 --warmups 2 \
  --baseline docs/benchmarks/xuanwu-capacity-formal-baseline-2026-07-18.json \
  --json-out /tmp/capacity-candidate.json \
  --markdown-out /tmp/capacity-candidate.md

# 3. 可调规模的独立数据集
bun scripts/xuanwu-capacity-benchmark.ts generate \
  --output /tmp/capacity-synthetic.db \
  --projects 20 --issues 50 --events 20 --runs 2 --sessions 1 \
  --automations 25 --automation-runs 5 --automation-events 20
```

## Authority、兼容和回滚

- Issues：`issues`；events：`issue_events`；summary projection 可重建且不是 source of truth。
- Runs：`issue_runs + run_attempts + issue_events`；Timeline 继续复用既有 Work/Issue/Run/Supervisor authority（内部仍由 `pi_*` 兼容载体承载）。
- Sessions：`agent_sessions` 仅为 catalog；provider transcript 保持 provider-authoritative。
- Automations：`automation_definitions + automation_runs + automation_events`。
- 本交付不引入新 schema、双写、双读、公共 contract 或共享状态机，也没有新旧模型迁移期限。
- 回滚仅删除生成的 DB 副本、报告和本基准代码；live DB 与运行态从未被基准修改。
