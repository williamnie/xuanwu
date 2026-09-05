# ADR-XW-0078：统一运行可观测性、成本与诊断包

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P10.10 / Runner #733
- 硬依赖：XW P03.06 / #661、XW P08.03 / #709、XW P10.06 / #729（均为 `done`）
- canonical 实现：`backend-ts/src/observability/runtimeObservability.ts`
- 现有入口：`GET /api/system/status`、`GET /api/system/doctor`、Settings → Advanced → Runtime

## 决策与边界

既有运行事实已经分别存在 Issue-backed Work、`issue_runs` / `run_attempts`、Workflow ref、provider cost、
Automation 和 `event_summary_projection` 中；问题是 system status、usage、events 和前端诊断包没有把这些事实按同一个
Work trace 组合起来。P10.10 只增加只读 projection，不创建 metrics 表、raw-log index、第二套 lifecycle 或 provider adapter。

| 维度 | 唯一 source of truth | 只读 projection |
| --- | --- | --- |
| Work | `issues`（G4 前 Issue-backed Work authority） | status/count，canonical `xw:work:issues:<id>` trace id |
| Run / Attempt | `issue_runs` / `run_attempts` | status/count、关联 provider、token/cost completeness |
| Workflow | `works.workflow_ref`、Automation execution link；旧 Issue 使用 template fallback label | Work/Run 数，不参与 workflow resolve 或执行 |
| Provider cost | `run_attempts.cost_json` | token 与 provider-reported micros 聚合；未知保持 unknown，不补零为已知 |
| Automation | `automation_definitions` / `automation_runs` / `automation_execution_links` | definition/run/link count 和 Work trace 关联 |
| structured events | `event_summary_projection` | event type count 与最近 50 条脱敏 summary；不读 `issue_events.payload` |

`xuanwu.runtime-observability.v1` 通过现有 `/api/system/status.observability` 和
`/api/system/doctor.observability` 暴露。每条 trace 以 canonical Work id 为 `trace_id`，并同时携带 Run、Workflow、
Provider invocation/session、Automation run 和 cost completeness，因此一次 Work 可从控制面关联到 provider Evidence。
它是诊断 projection，不是 OpenTelemetry collector，也不会改变任何状态。

## Health reasons、structured logs 与诊断导出

`/api/system/status.health` 使用稳定 reason code 聚合 DB、security warning、provider/connector availability、event
projection lag、stalled Run、缺失 Attempt link 和过期 Automation lease。reason 只由确定性运行事实产生；LLM 文本不能将
failed/degraded 改为 healthy。

structured events 只读取 `event_summary_projection` 的有界 summary 和 summary payload，沿用 P01.05 retention/compaction
合同。前端现有 `xuanwu.runtime-diagnostics.v1` 下载包保持 schema version，additive 包含 `health` 和 `observability`；仍组合
doctor、connector diagnostics 与有界 runtime log 摘要，并再次通过 P10.06 redaction registry 和浏览器 defense-in-depth
脱敏。诊断包不包含 raw provider session、raw event payload、secret material 或绝对路径。

## 查询、兼容、回滚与删除门禁

- **指标查询不扫 raw log：** Work/Run/Workflow/Provider/Automation/cost 都直接查询 SQLite domain tables；structured
  events 只查 `event_summary_projection`。`query_contract.raw_log_scan=false` 与
  `provider_session_scan=false` 是可执行合同。
- **双写=0、双读=0：** 本期没有新存储，不写 metrics/trace/health shadow row；现有 authority 与事件 writer 不变。
- **旧诊断兼容：** `/api/system/status`、`/api/system/doctor` 和 runtime diagnostics v1 仅增加字段；旧客户端可忽略。
  `/api/usage/codex` 继续作为 Codex session 用量 UI，不是统一成本指标的 source of truth。
- **回滚：** 回滚 scoped commit 即移除 projection/status 字段和前端附加内容；没有数据迁移或外部写需要撤销。
- **最终删除门禁：** 只有所有 status/doctor/Settings consumer 已迁移、至少一条 Automation 和一条普通 Work trace
  clean-baseline 验证通过、projection lag/rebuild 与 backup/restore smoke 通过、旧 diagnostics consumer 连续一个正式
  release 为零，后续 issue 才能删除兼容字段或旧前端组合逻辑。

## 最小验证

```bash
cd backend-ts
bun test src/observability/runtimeObservability.test.ts src/http/systemStatus.test.ts

cd ../frontend
node --test src/utils/runtimeDiagnostics.test.js src/pages/settingsLayout.test.js
npm run build
```

fixture 同时在 raw `issue_events.payload` 放入不可见 sentinel/secret，并只在 summary projection 放入脱敏事件；断言统一
指标看得到 Work → Run → Workflow → Provider → Automation 和 token/cost，却看不到 raw sentinel 或 secret。

## 无人值守效果投影

`observability.delivery_effectiveness` 为 additive 只读字段，沿用 15 秒缓存和隔离 reader worker。按最后结束 Run 位于近 30 天且 Work 为 done/failed/cancelled 的最近 100 个任务取样，超过上限显式标记 truncated。没有执行记录的历史手工完成任务不进入分母。

交付率要求 done、最新 Run 被最新 Handoff 关联、交付 ready/delivered、所有关联 Evidence 已通过且必需交付操作成功。无求助记录的交付率额外排除审批请求/需要用户处理的通知，但不声称完整捕获人工介入。恢复后交付率分母为样本中具有 progress/no_progress/failed 恢复尝试的任务；多次无进展为至少两条 no_progress，不推断连续性。

完成耗时为首次 Run 开始到最后结束的中位数。成本仅聚合已完成任务的全部执行 Attempt；任何 Run 缺 Attempt、金额未知或单任务币种冲突都记为未知，不补零，不混加币种，不包含 Supervisor 成本。交付仅通过类型受限的结构化 Handoff/Evidence repository 读取，不扫描原始会话或 issue.log。
