# Runner 进程组内存监控

## Authority

`GET /api/system/status.process_group_memory` 是在线状态入口：

- macOS 的预算权威值是 `proc_pid_rusage(RUSAGE_INFO_V4)` 返回的 `phys_footprint`。该调用不启动 `/usr/bin/footprint`、不挂起 Core，也不阻塞 HTTP accept loop。
- `aggregate.rss_bytes`、`aggregate.rss_p95_bytes`、`main.process_rss_bytes` 与角色 RSS 保留为诊断数据。RSS 包含可回收/共享驻留页，不能在 macOS 物理测量可用时替代预算权威值。
- 非 macOS 或内核查询失败时，`budget.measurement_source=rss` 明确表示降级口径；不能把失败伪装成 `footprint_bytes=0`。
- 首次物理测量完成前，`budget.status=measurement_pending`。该状态不触发 Guardian 告警，也不把系统健康误判为内存失败。

Core 只在事件循环中读取自身 RSS 和 Provider lifecycle 已登记的进程快照。物理值通过内核按 PID 获取，不扫描完整系统进程表。这样既保留 Provider 子进程归因，也不会恢复每秒同步 `ps -axo` 的阻塞路径。

## 告警生命周期

所有 soft/hard、idle/run 的内存越界属于同一活动事故，canonical `run_group_id` 为 `runner-memory`：

1. soft 首次越界创建 `high/open`。
2. soft 升级 hard 时更新同一事故为 `urgent/open`；不会并列创建 soft/hard banner。
3. 用户确认后，同级波动保持 `acked`；只有越过已确认的最高级别才重新打开。
4. `within_budget` 会解析 canonical 与旧版 `runner-memory:<phase>:<level>` 活动记录。
5. 部署新版本后第一次越界会把旧版并列记录归档到 canonical 事故，保留 acknowledgement 的最高级别语义。

## 诊断

优先检查以下字段，不要只看 RSS：

```text
process_group_memory.measurement.physical_memory_probe
process_group_memory.budget.measurement_source
process_group_memory.budget.measured_group_bytes
process_group_memory.budget.measured_main_bytes
process_group_memory.aggregate.footprint_bytes
process_group_memory.aggregate.rss_p95_bytes
process_group_memory.roles
process_group_memory.top_by_rss
```

只有 `measurement_source=footprint` 且 `soft_exceeded`/`hard_exceeded` 持续时，才按真实物理预算事故处理。RSS P95 高但 physical footprint 在预算内属于诊断信号，不应生成用户告警。

## 验证

```bash
cd backend-ts
bun test \
  src/observability/processGroupMemory.test.ts \
  src/http/systemStatus.test.ts \
  src/mainWiring.test.ts \
  src/benchmarks/xuanwuCapacity.test.ts \
  src/benchmarks/enduranceGate.test.ts

CODEX_RUNNER_BINARY=/tmp/codex-issue-runner-memory-fixed \
  ./scripts/build-binary.sh
```

编译产物的隔离 smoke 必须证明：

- `measurement.physical_memory_probe=ready`
- `budget.measurement_source=footprint`（macOS）
- `aggregate.footprint_bytes > 0`
- 没有内存越界时 `budget.status=within_budget`
- `/health` 与 `/api/system/status` 持续可响应
