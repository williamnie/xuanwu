# Provider 事件三层存储与 Runner 内存治理方案

> 日期：2026-08-03
>
> 范围：`codex-issue-runner` 的 Provider 事件持久化、历史事件归档、事件摘要投影、SQLite 容量和进程组内存告警。
> 关联排查：[Runner 内存告警高频触发排查报告](../runbooks/process-group-memory-investigation-2026-08-03.md)

## 1. 背景与结论

live `runner.db` 当前约 1.35 GiB，814 个 Issue 均已终态，但数据库中仍有 537,792 条 `issue_events`，其中 530,584 条是 `issue.log`。主要空间并不是 Issue 本身，而是 Provider 协议流、重复摘要投影和 PI Action 历史：

| 对象 | 当前物理占用 | 主要内容 |
| --- | ---: | --- |
| `issue_events` | 约 644 MiB | 53 万条原始/半原始 Provider 事件 |
| legacy `event_summary_projection` 及索引 | 约 422 MiB | `issue_events` 的可重建派生副本 |
| `pi_actions` / `pi_action_events` 等 | 约 250 MiB | Action、结果、快照和审计历史 |

历史 `issue.log` 中最主要的事件为 234,920 条 Agent message delta、103,716 条命令输出 delta、57,805 条 item started 和 53,812 条 item completed。把每一个流式 chunk 长期作为 SQLite 行保存，对实时 UI 有短期价值，但对终态 Issue 的恢复、验收和审计没有同比例的长期价值。

仓库已经具备部分治理基础：

- `normal/debug` Issue 日志模式；`normal` 已丢弃大部分流式 delta；
- 大 payload 的 gzip artifact externalization；
- compact event summary projection v2；
- archive、restore rehearsal、retention delete evidence、checkpoint 和 vacuum 命令；
- maintenance-aware GC 和 macOS `phys_footprint` 权威内存测量。

当前缺口是这些能力没有闭成完整链路：

1. `normal` 模式仍保存每次 token usage 更新和包含完整输出的 command completed；
2. 历史事件仍停留在主库，retention 默认只报告；
3. compact projection 读取 `created_at` 时仍 join `issue_events`，源事件删除后摘要不可独立读取；
4. legacy projection 没有在 v2 consumer-zero 后安全退役；
5. idle 内存正常水位约 315 MiB，却使用 288/320 MiB 的组 soft/hard 阈值和 3/6 秒持续窗口，造成常态误报。

本方案不删除状态、Evidence、Handoff 或审计事实。目标是把 Provider 明细从“永久热数据”改成“实时流 + 归一化终态事实 + 可恢复冷归档”。

## 2. 目标与非目标

### 2.1 目标

- `normal` Issue 不再逐条持久化 Provider streaming delta。
- 每次 Tool 调用在热库最多保留一条有界终态观察：命令、cwd、状态、exit code、耗时、有限输出摘要和 Provider 引用。
- 每个 Run 的 token/cost 在热库只保留最终累计值，不保留每次 usage 更新。
- 终态历史原始 Provider 事件经 gzip archive、checksum、restore rehearsal 和 summary watermark 后退出热库。
- compact projection 不依赖已归档源事件，legacy projection 可在 consumer-zero 后删除。
- 事件治理后热数据库目标为 400–550 MiB；继续治理 PI Action 重复数据后目标为 280–400 MiB。
- 内存告警以真实常驻水位为基线，只有连续越界 3 分钟才通知。

### 2.2 非目标

- 不把 Provider transcript 变成 Runner 的 Run/Issue 状态 authority。
- 不删除 `issue.status_changed`、Run lifecycle、Evidence、Handoff、人工审核和交付审计。
- 不在在线 writer 未停止时执行历史删除、legacy projection 清理或 full vacuum。
- 不用扩大阈值掩盖单调增长的真实泄漏；仍保留 footprint、post-run delta 和 soak drift 观测。

## 3. 三层存储模型

### 3.1 L0：实时瞬态层

承载 Provider 的 message delta、command output delta、diff、plan 和 usage update。事件继续经过 runtime hook、approval、terminal detection 和 SSE/UI 发布，但 `normal` 模式不逐条写入 SQLite。

约束：

- 仅存在于当前 Provider stream、SSE 和有界内存缓冲；
- 断线重连依赖 Provider Session transcript，不依赖 Runner 重放全部 chunk；
- `debug` 模式允许单个 Issue 的下一次 Run 使用有界 chunk 聚合，Run 结束自动恢复 `normal`。

### 3.2 L1：热库终态事实层

热库继续使用 `issue_events`、`issue_runs` 和 `run_attempts` 作为既有 authority，不新建第二套 Run 状态机。`normal` 模式只写：

- `item/completed` Agent 最终消息的有界文本；
- `item/completed` Tool 终态观察；
- Run terminal、错误、审批和关键生命周期事件；
- `run_attempts.cost_json` 最终 cost/usage；
- Evidence、Handoff、Review 和 Issue/Run 状态事实。

Tool 终态观察使用 `xw.tool-observation.v1`：

```json
{
  "schema_version": "xw.tool-observation.v1",
  "representation": "terminal_tool_observation",
  "item_id": "call-id",
  "item_type": "commandExecution",
  "cwd": "/repo",
  "exit_code": 0,
  "duration_ms": 15320,
  "output_excerpt": "Tests: 42 passed",
  "raw_payload_omitted": true
}
```

外层 `issue.log` 仍保留 `command`、`status`、`provider`、`raw_method` 和 Run/Attempt correlation，使现有 Supervisor、meaningful-progress、timeline 和完成卡片可渐进兼容。

### 3.3 L2：冷归档层

超过热保留期且已终态的 raw Provider 日志，写入按批次 gzip JSONL archive：

- manifest 固定源数据库 snapshot、row checksum 和 archive checksum；
- archive 完成后做隔离 restore rehearsal；
- delete 前要求 compact summary watermark、fresh backup、writer quiesce、显式 audited authorization；
- 删除可 checkpoint/resume；恢复按原 event id 幂等回填；
- archive 按既有 retention 至少保留 1 年，durable raw archive 至少保留 7 年。

Provider 自身的 Codex rollout/Claude Session 是详细 drill-down 来源，但不单独承担 Runner 的交付证据。Runner 冷归档是 Provider Session 被清理或格式变化时的恢复保险。

## 4. 保留策略

| 数据 | 热库保留 | 冷归档 | 原因 |
| --- | ---: | ---: | --- |
| raw streaming/telemetry | 7 天 | 至少 365 天 | 只用于近期诊断 |
| raw item started/completed | 30 天 | 至少 2555 天 | 终态观察已进入 L1，raw 仅作深度审计 |
| normalized Tool/final/cost | 随 Issue/Run 长期保留 | 可随备份 | 运行和验收事实 |
| state event | 不自动删除 | 可归档 | Issue/Run authority |
| audit/delivery evidence | 不自动删除 | 长期备份 | 合规和完成门禁 |
| unknown event | 人工 review | 不自动删除 | fail closed |

raw 删除仍必须同时满足：Issue/Run 已终态、无 legal hold/pin、无未解析引用、archive receipt 完整、restore rehearsal 通过、summary watermark 覆盖和显式 destructive gate。

## 5. compact projection 与 legacy 退役

compact projection v2 增加自身 `event_created_at`，查询不再 join `issue_events`。这样 raw 源事件删除后：

- Work timeline/observability 仍可读取有界摘要；
- compact projection 继续作为 cold archive 的热摘要索引；
- restore 原始事件不会改变摘要 identity；
- source event id 仍是 archive 和摘要之间的稳定关联键。

切换顺序固定为：

1. schema migration 增加 `event_created_at` 并从现有 `issue_events` 回填；
2. shadow rebuild compact v2；
3. 验证 row coverage、payload parity、storage 不超过 128 MiB 和查询性能；
4. 完成 observation window；
5. read switch 切到 v2；
6. archive/delete raw 日志；
7. 验证 v2 在源事件缺失时仍可读；
8. 单独 audited maintenance 删除 legacy projection；
9. full vacuum 回收文件页。

legacy 删除不放进普通启动 migration，避免 1.4 GiB live DB 在启动阶段长时间锁库。

## 6. 历史迁移执行方案

### 6.1 预检

- 确认无 active Issue Run、Agentic RPC 和 Provider writer；
- `pragma quick_check=ok`；
- 记录 `page_count/page_size/freelist_count` 和 object usage；
- 创建独立数据库 backup，并在隔离路径打开验证；
- 确认归档与 vacuum 的可用磁盘空间至少为当前 DB 大小的 2 倍。

### 6.2 影子验证

所有 destructive 操作先对 live backup 副本执行：

- rebuild/verify compact projection；
- archive/verify/restore rehearsal；
- prepare delete evidence；
- delete + full vacuum；
- `quick_check`、关键 API 查询、Issue/Run/Evidence/Handoff count parity；
- 记录迁移前后 DB、archive、对象级尺寸和耗时。

### 6.3 live 执行

live 执行必须在服务停止 writer 后使用相同命令和同一版本二进制，保留 checkpoint、report、manifest、delete evidence 和 pre-migration backup。任何 blocker 非零立即停止，不允许通过手写 SQL 绕过。

### 6.4 回滚

- compact read switch 可回 v1，直到 legacy projection 正式删除；
- raw delete 可用 archive restore 按原 event id 回填；
- legacy 删除后的整体回滚使用 pre-migration backup；
- 新写入格式保持外层 `issue.log` 兼容，旧二进制可以读取公共字段，但不会恢复已省略的 raw payload。

## 7. 内存治理

### 7.1 已确认基线

无 Issue、无 Agentic RPC 时权威组 footprint 约 315 MiB，其中 Core 约 245 MiB、Agentic Worker 约 70 MiB。Core heap used 约 21 MiB，未见随时间单调增长，因此主要是 Bun/native/压缩页常驻和阈值失配，不是 JS heap 泄漏。

### 7.2 代码与容量措施

- `normal` 模式不再构造/写入大量 raw payload 和 artifact，减少短期 Buffer/gzip/JSON 压力；
- 历史 raw 和 legacy projection 退出热库，降低同步 SQLite 查询、page cache 和 hydration 压力；
- HTTP/PI 的事件列表继续默认 `hydrateArtifacts=false`；只有明确的单条 drill-down 才读取冷 payload；
- 保留 maintenance 结束后的 `Bun.gc(true)` 和 fresh footprint generation；
- Agentic health 响应继续刷新 worker RSS，避免 UI 显示启动峰值。

### 7.3 新预算与通知窗口

| 指标 | 原 soft/hard | 新 soft/hard |
| --- | --- | --- |
| idle main footprint | 224/256 MiB | 320/384 MiB |
| idle group footprint | 288/320 MiB | 384/448 MiB |
| active run group footprint | 640/700 MiB | 768/896 MiB |
| post-run delta | 24/32 MiB | 64/96 MiB |
| soak drift | 48/64 MiB | 96/128 MiB |

soft 与 hard 均要求连续 180 个 1 秒采样，即持续 3 分钟才进入 `*_exceeded` 并写 Guardian 告警。此前仅 3/6 秒的窗口废止。短暂越界仍在 System Status 显示 `soft_pending/hard_pending`，但不通知。

阈值上调不改变以下真实故障信号：

- footprint 连续 3 分钟超过 hard；
- post-run 超过 TTL 后持续不能回到 baseline + 96 MiB；
- 30 分钟 soak drift 超过 128 MiB或呈单调增长；
- 单个 Provider 子进程异常驻留或退出后仍被错误计入。

## 8. 验收标准

### 8.1 写入链

- normal Run 的 10,000 个 message/output delta 在热库为 0 行；
- 同一 Run 多次 token usage 更新最终仅保留 1 条；
- 每个 terminal Tool 调用保留 1 条 `xw.tool-observation.v1`，输出摘要不超过 1,200 bytes；
- completion card 能从新旧两种 `issue.log` 读取命令、exit code 和输出摘要；
- debug mode 仍有界聚合并在 Run 结束复位。

### 8.2 迁移链

- compact v2 coverage/parity/性能门禁通过，空间不超过 128 MiB；
- 删除 raw 源事件后，compact timeline 仍能返回相同摘要和 `created_at`；
- archive checksum、restore rehearsal、delete checkpoint 和 `quick_check` 全部通过；
- full vacuum 后热 DB 目标 400–550 MiB；若仍超过 550 MiB，报告 object usage，不自动扩大删除范围。

### 8.3 内存链

- 315 MiB idle baseline 判定为 `within_budget`；
- 449 MiB idle 组 footprint 持续不足 3 分钟只显示 pending，不产生告警；
- 连续满 3 分钟才产生单个 canonical 告警；
- 恢复后 resolve，同一 incident 不产生高频历史记录；
- 跨 maintenance cooldown、Agentic 90 秒 grace 和 post-run TTL 做 live 复核。

## 9. 发布边界

代码、migration 和 maintenance 命令可以在当前工作区完成并对数据库副本验收。正式 live 数据迁移与 redeploy 是独立发布动作：必须停 writer、备份、执行、验证、可回滚，不因本地测试通过而自动修改正在运行的数据库。

## 10. 2026-08-03 隔离副本演练结果

本次实现使用 live SQLite backup 的隔离副本完成了 compact 全量迁移链和 retention dry-run，未修改 live 数据库；raw archive/delete 的完整写入链由独立数据库集成测试覆盖，正式 live 归档仍属于发布维护窗口：

| 门禁 | 结果 |
| --- | --- |
| `quick_check` | `ok` |
| source / legacy / compact coverage | 537,792 / 537,792 / 537,792 |
| compact parity | 0 mismatch、0 representation difference |
| compact 空间 | 122,109,952 bytes，低于 128 MiB 门禁 |
| latest 50 P95 | compact/legacy = 0.826 |
| Issue latest 500 P95 | compact/legacy = 0.366 |
| Project latest 100 P95 | compact/legacy = 0.473 |
| v2 cutover | 通过 |
| legacy retirement | 537,792 行降为 0 |
| incremental vacuum | `quick_check=ok`，freelist 108,051 页降为 0 |

仅退役 legacy projection 后，副本从 1,569,955,840 bytes 降到 1,126,838,272 bytes，实际回收 443,117,568 bytes（约 422.6 MiB）。此时剩余主要对象为：

- `issue_events` 675,467,264 bytes；
- `pi_action_events` 154,923,008 bytes；
- `pi_actions` 82,165,760 bytes；
- compact projection 全部对象 122,109,952 bytes。

按新 7/30 天策略做 dry-run，537,792 条源事件中 439,289 条已进入 archive 动作、98,503 条继续保留。它们只有在冷归档、restore rehearsal、compact consumer-zero、备份和 writer quiesce 等门禁全部满足后才能从 live 热库删除。因此 422.6 MiB 是当前不触碰原始事件即可确定回收的空间；400–550 MiB 热库目标仍需正式执行 raw archive/delete/vacuum，并根据执行后 object usage 决定是否另立 PI Action 历史治理任务。
