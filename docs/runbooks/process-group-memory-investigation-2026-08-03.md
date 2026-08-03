# Runner 内存告警高频触发排查报告（2026-08-03）

> 排查范围：只读排查，未修改任何代码/配置/运行态。
> 告警文案：`Runner Core 与已登记 Provider 子进程的权威内存测量连续超过当前活动阶段预算`（`runner_process_group_memory_budget`，Guardian 告警）。

## 1. 结论先行

**这不是内存泄漏导致的持续越界，而是 idle 预算阈值与正常运行水位几乎重合、加上 3 秒级告警窗口过短造成的常态高频误报。**

- 当前系统**完全空闲**（无 Issue Run、无 Agentic RPC）时，权威组物理足迹稳定在 **≈315 MiB**，已超过 idle 软预算（288 MiB），距硬预算（320 MiB）仅 **≈5 MiB（1.6%）**。
- 空闲期监控画面（实时采样）：`phase=idle, measured_group_bytes≈315705384, status=soft_exceeded`；切换到 `phase=run` 后反而 `within_budget`（run 预算 700 MiB 宽松）。
- 因此任何微小波动（scheduler/maintenance 活动、GC 时机、SQLite WAL 增长）都会把组足迹推过 320 MiB，且 hard 告警只需**连续 3 次采样（3 秒）**，告警–恢复高频循环由此产生。
- 历史记录佐证：2026-07-20 ~ 07-31 共 **1273 条**内存告警记录，其中 **idle 阶段 833 条（65%）**、run 阶段 440 条（35%）。大多数告警发生在没有任何活跃运行的空闲期，属于预算口径问题而非真实故障。

## 2. 报警机制（代码依据）

实现位于 `backend-ts/src/observability/processGroupMemory.ts`，接线在 `backend-ts/src/runtime/core.ts`。

### 2.1 采样与聚合

- 采样周期 `PROCESS_GROUP_MEMORY_SAMPLE_INTERVAL_MS = 1_000`（每秒 1 次）。
- 权威测量：macOS `proc_pid_rusage(RUSAGE_INFO_V4)` 的 `phys_footprint`（非挂起内核查询，见 `darwinProcessMemory.ts`）。RSS 仅作诊断口径，预算判定用 footprint。
- 聚合对象（`runtimeMemoryRows`）：Runner Core 自身 + Agentic Worker（其 PID/RSS 经 Agentic RPC 响应头登记）+ Provider（codex）lifecycle 已登记的进程快照。
- 活动阶段：`run`（Issue Run 进行中 / Agentic RPC 执行中 / 完成后 90 秒冷却窗 / maintenance 冷却窗）、`idle`、`usage`。

### 2.2 预算（`PROCESS_GROUP_MEMORY_BUDGETS`）

| 项 | soft | hard |
| --- | --- | --- |
| idle 组足迹（`idle_group_rss_p95_bytes`） | 288 MiB | 320 MiB |
| idle 主进程足迹（`idle_main_rss_bytes`） | 224 MiB | 256 MiB |
| run 组足迹（`active_run_group_rss_p95_bytes`） | 640 MiB | 700 MiB |
| 告警连续阈值（`consecutive`） | soft=6 次 | hard=3 次 |

即：hard 告警（urgent）只需 **3 秒**连续越界，soft 告警（high）需 6 秒。

### 2.3 告警生命周期

- 越界 → 写 canonical 告警（`run_group_id=runner-memory`）；`within_budget` → 自动 resolve（`resolveRecoveredProcessGroupMemoryAlerts`）。
- 由于越界–恢复交替发生，canonical 记录被反复 reopen/resolve，形成高频记录（数据库中 1273 条，多数为分钟级 open/resolve 循环）。

## 3. 实测数据（2026-08-03 07:52 ~ 07:56，本机 live 实例）

运行实例：`codex-issue-runner-bun-live`（launchd 三进程拆分：core 18835 / agentic 19130 / web 19194，8-2 15:50 部署）。

### 3.1 完全空闲时的权威测量（`GET /api/system/status` → `process_group_memory`）

| 指标 | 值 | 预算对照 |
| --- | --- | --- |
| `phase` | idle | — |
| `activity.status` | idle（issue_runs=0，agentic_in_flight=0） | — |
| `aggregate.footprint_bytes`（权威组足迹） | **≈315.3 MiB**（315,328,552 B） | > soft 288 MiB，距 hard 320 MiB 仅 5 MiB |
| `budget.measured_group_bytes` | 315,705,384 B | soft_pending/soft_exceeded 反复 |
| `budget.measured_main_bytes`（Core 足迹） | **≈244.9 MiB**（245,073,144 B） | > main soft 224 MiB，距 hard 256 MiB 仅 11 MiB |
| `main.process_rss_bytes`（Core RSS） | 96 MiB | — |
| `main.heap_used_bytes` | 21 MiB | — |
| `measurement_source` | footprint（权威口径就绪） | — |

进程构成（idle 时仅 2 个进程被聚合）：

| 进程 | ps RSS | 权威物理足迹 | 说明 |
| --- | --- | --- | --- |
| Runner Core（18835，运行约 24h） | 96 MiB | **≈245 MiB** | footprint 为 RSS 的 2.5 倍 |
| Agentic Worker（19130） | 18 MiB（ps / health 实测） | ≈70 MiB（组 315 − main 245 差值） | 启动峰值 129 MiB，空闲后 RSS 已回收，物理足迹仍残留 |

### 3.2 实时采样画面（每 1.2 秒一次，07:56:13~07:56:26）

```
07:56:13 phase=idle grp=315705384 main=245564664 src=footprint st=soft_pending     cs=5
07:56:15 phase=idle grp=315705384 main=245564664 src=footprint st=soft_exceeded   cs=7   ← 触发 soft 告警（high）
07:56:19 phase=run  grp=315705384 main=245564664 src=footprint st=within_budget   cs=0   ← 切到 run 预算后“正常”
07:56:26 phase=idle grp=316344360 main=246236408 src=footprint st=soft_pending    cs=1   ← 回 idle 再次逼近
```

同一份 315 MiB 物理足迹，在 idle 阶段越界告警、在 run 阶段判为正常——预算阶段差异是告警的直接放大器。

## 4. 历史告警统计（live 实例 runner.db）

- 时间跨度：2026-07-20 02:48 ~ 2026-08-03（持续发生）。
- 总量：**1273 条** `runner_process_group_memory_budget` 记录（绝大多数已自动 resolve）。
- 按恢复时阶段分布：**idle 833 条（65%）/ run 440 条（35%）**。
- 按日分布（条数）：07-20: 6，07-21: 119，07-22: 213，07-23: 155，07-24: 126，07-25: 40，07-26: 157，07-27: 31，07-28: 60，07-29: 25，07-30: 25，**07-31: 316**（峰值）。
- 单次 open 时长：绝大多数为分钟级（2~14 分钟），仅 07-20 首次记录长达约 22 小时（1337 分钟，疑似一次性事件，见 §6）。
- 8-3 当天：一条 07-31 08:18 创建的告警在 08-03 07:54 被自动 resolve，当前无 open 内存告警，但 `consecutive_soft` 持续在阈值边缘波动（实测已出现 cs=7 的 soft_exceeded）。

## 5. 根因分析

### 5.1 直接根因：空闲水位贴着 idle 预算上限（主因）

- 空闲基线组足迹 ≈315 MiB 稳定存在，由两部分构成：
  - **Core 245 MiB**：RSS 仅 96 MiB，但 macOS `phys_footprint` 口径（含 compressed/dirty 页）+ Bun 运行时 + 打开 1.4 GB `runner.db`（SQLite WAL）使其物理足迹显著高于 RSS。
  - **Agentic Worker ≈70 MiB**：启动时加载的代码/数据页（峰值 RSS 129 MiB）在空闲后被压缩，物理足迹不随 `Bun.gc(true)` 释放。
- 预算设定（soft 288 / hard 320 MiB）与真实空闲水位（315 MiB）几乎重合，余量仅 5 MiB，等于**空闲即处于预算边界**。

### 5.2 放大因素 1：告警窗口过短

- hard 告警只需连续 3 秒越界，soft 6 秒。任何瞬时波动（scheduler 每 30 秒的 maintenance、WAL 增长、GC 时机）都会先触发 hard 越界、随后 within_budget 自动 resolve，形成"告警–恢复"高频循环，这正是 1273 条记录与"总是报警"的直接观感来源。

### 5.3 放大因素 2：Agentic Worker 物理足迹计入 idle 聚合

- 即使完全空闲，agentic worker 的压缩物理页仍计入组权威足迹（实测 ≈70 MiB）。该进程是为承载 RPC 常驻的，其 footprint 在架构上属于"后台执行角色"，但 idle 预算未为其预留空间。

### 5.4 放大因素 3：run 阶段也偶发越界（35% 告警）

- 运行 Issue 时聚合加入 codex 进程组。codex CLI 为 Node 实现（`@openai/codex` 0.142.3，`/Users/xiaobei/Library/pnpm/bin/codex`）。
- 7-20 的 provider ownership 快照显示一次 app-server 会话的进程组 RSS 即达约 292 MiB（codex app-server + node_repl + dart mcp + node mcp + dart language-server + code-mode-host）。
- Core + Agentic + codex 进程组在工具宿主/大上下文场景下，物理足迹易突破 run 预算 700 MiB；RPC 后 90 秒冷却窗仍按 run 阶段计，进一步扩大窗口。

### 5.5 结论定性

- 非泄漏：Core 启动 24h+，RSS 稳定 96 MiB，footprint 两次采样间波动 <0.5%，无单调增长趋势；Agentic Worker 真实 RSS 已由峰值 129 MiB 回收至 18 MiB。
- 属**预算口径/阈值设置与正常运行水位不匹配 + 告警窗口过短**导致的常态误报；其中 idle 阶段误报占 65%，是最主要的噪音来源。

## 6. 附加发现（非根因，但影响排查判断）

1. **监控面板中 Agentic Worker RSS 为陈旧值**：`roles` 显示 worker rss_bytes=129 MiB（8-2 启动峰值），而 ps 与 agentic health 实测仅 18 MiB。原因：worker RSS 只在 **POST RPC 响应头**（`x-codex-runner-agentic-rss-bytes`）刷新，GET/health 不刷新，且 8-2 启动后无 RPC。该陈旧值让 `aggregate.rss_bytes`（231 MiB）比真实（114 MiB）虚高约 117 MiB，会误导 System Status 页面阅读；**预算判定不受影响**（预算用 footprint 实时测量）。
2. 07-20 首次告警持续约 22 小时（1337 分钟），与后续分钟级循环明显不同，可能是当时单进程模式（未拆分 agentic worker）或一次真实驻留问题；之后 8-2 部署（三进程拆分）后告警仍在，但形态为分钟级循环。
3. `codex-usage-index-v1.sqlite`（308 MiB）当前无进程打开；usage-index worker 空闲时已退出，不占监控聚合。
4. 本机另有大量 ChatGPT/Codex 应用进程（如 Codex Renderer 607 MiB）占用整机内存，但不属于 Runner 进程树、不计入监控聚合。

## 7. 建议（仅建议，本次未实施）

按"先校准口径、再收窗口"顺序：

1. **校准 idle 预算**：以当前空闲基线（组 315 MiB / main 245 MiB）为参考，idle hard 建议上调至 400~448 MiB（留 30%~40% 余量），soft 同步上调；或针对 footprint 口径（含 compressed/dirty）单独设定容忍系数。
2. **延长告警窗口**：hard 连续阈值由 3 秒提高到 ≥30 秒、soft 由 6 秒提高到 ≥60 秒，滤除瞬时波动；同时将"告警–恢复"循环的 re-arm 间隔（如 resolve 后 N 分钟内不重新告警）作为可选补充，避免高频打扰。
3. **修正监控 RSS 陈旧值**：让 GET/health 也返回 agentic worker 实时 RSS（或 Core 侧定期拉取刷新），避免 System Status 面板显示虚高 RSS。
4. **Agentic Worker 空闲驻留**：如希望降低 idle 聚合足迹，可评估 worker 空闲更激进回收或进程级释放；但注意 phys_footprint 含压缩页，JS 层 GC 无法完全释放，调整预算比强制回收更可靠。
5. **关注真实泄漏信号**：以"Core/Agentic footprint 是否随运行时间单调增长、单次 open 是否超过数小时"作为真实故障判据；当前未见该趋势。若 07-20 式长告警再现，再按泄漏/驻留问题专项处理。

## 8. 复核方法

- 在线入口：`GET /api/system/status` → `process_group_memory`（Core 127.0.0.1:3009）。
- 只认 `budget.measurement_source=footprint` 且 `soft_exceeded/hard_exceeded` 持续 ≥ 数十秒的情况才按真实物理预算事故处理（runbook 同口径）。
- 告警记录：`pi_guardian_alerts` 表，`alert_type='runner_process_group_memory_budget'`；观察 open 时长与 phase 分布即可区分"常态误报"（分钟级循环、idle 占比高）与"真实故障"（长时 open、footprint 单调增长）。
