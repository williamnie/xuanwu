# XW P01.02：事件保留、摘要、归档与删除策略

状态：accepted（2026-07-16），2026-08-03 按三层存储方案修订 raw 热保留期

依赖：XW P01.01（issue 637，`done`）、XW P00.04（issue 634，`done`）

## 1. 决策与边界

本策略复用现有 Issue / Session / Guardian / PI authority，不创建第二套 Event 或 Evidence 主表。**当前 source of truth** 保持如下：

- Work 与 provider timeline：`issues`、`issue_runs`、`issue_events`；
- Guardian recovery：`issue_supervisor_events`、`pi_guardian_*`；
- 权限、状态变更与外部写审计：`pi_action_events`；
- 交付结果：`issue.verification_*`、`sync_outbox`、Git 与外部系统回执。

`backend-ts/src/events/retentionPolicy.ts` 是 canonical 配置 contract 和确定性候选判定器。默认 `execution_mode=report_only`，它不写 DB、不归档、不删除；本 issue 也不改变 schema、provider adapter、公共 API 或 live runtime。P01.01 已证明 `issue_events.payload` 仍被 Issue UI、Session、terminal detection、Guardian 与 PI activity 读取，因此不能因“已生成摘要”直接删除原始记录。

## 2. 事件等级与默认保留期

天数均从 event `created_at` 起算；Run 关联的数据还必须等 Run 成功终止。`archive_after_days` 只表示可创建附加 cold copy，不表示 archive 已成为 authority。`source_delete_after_days=null` 表示默认不允许删除 source row。

| policy id | 事件等级 | 典型 carrier | 最小 source 保留 | 可开始归档 | archive 最小保留 | 默认 source 删除 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| derived projection | R0 derived/rebuildable | legacy/compact summary projection、可重建索引 | source 覆盖且 consumer-zero 前保留 | 不单独归档；随 source archive/backup 恢复 | n/a | 仅与已获准 source event 同批清理 |
| `raw_operational` | R1 operational raw log | delta、diff、token/status update | 7 天 | 7 天 | 365 天 | 7 天后仅成为候选 |
| `raw_durable` | R2 durable raw log | `item/started`、`item/completed` | 30 天 | 30 天 | 2555 天 | 30 天后仅成为候选 |
| `state_event` | R3 state event | `issue.created`、`issue.status_changed`、recovery state | 365 天 | 365 天 | indefinite | 禁止 |
| `audit_event` | R3 audit event | approval/error/interrupt、`pi_action_events`、Guardian audit | 2555 天 | 365 天 | indefinite | 禁止 |
| `delivery_evidence` | R3 delivery evidence | verification review、`sync_outbox`、Handoff Evidence refs | 2555 天 | 90 天 | indefinite | 禁止 |
| `review_required` | fail-closed | unknown/legacy shape | 人工分类前 indefinite | 禁止 | indefinite | 禁止 |

2555 天是默认七年下限，不构成外部法律承诺；更长的项目、合同或 legal hold 要求优先。状态、审计和交付证据即使超过下限，也不会被当前配置自动转成删除候选。

P01.01 的 `classifyRetentionValue()` 继续保留兼容 export，但 raw-method 规则已复用本策略的 `classifyIssueLogRetentionTier()`，避免形成两套漂移分类。

## 3. pin 与 legal hold

两种 hold 都是带 actor、reason、scope 和 `audit_event_ref` 的确定性记录；不得只靠 prompt 或 LLM 文本生效/失效。

- `pin`：operator 对 event / run / issue / project 的保留意图；可设置 `expires_at`。生效期间阻止 source 与 archive 删除，但允许只增不减的 summary/archive。
- `legal hold`：同样支持四种 scope，但**不得自动过期**；只有显式 release 状态变更及其审计事件可以解除。它还阻止 destructive redaction 或 archive 清理。
- event scope ID 为 `<source>:<event-id>`；run、issue、project 分别使用 canonical run ID、十进制 issue ID 和 project ID。
- hold 匹配在保留期、摘要或 archive 判断之前执行；多个 hold 取最严格结果。

本 issue 只定义 contract；持久化 hold 的 schema/API 必须由后续 migration issue 单独实现，并继续经过现有 PI action gate/audit，不在本期旁路加表。

## 4. summary watermark

Raw source 删除候选必须存在 `xuanwu.summary-watermark.v1` 等价记录，至少包含：

- `source`、`issue_id`、`run_id`、`policy_id` 与 `policy_version`；
- 单调递增的 `covered_through_event_id` 和 `contiguous=true`；
- `summary_ref`、`summary_sha256`；
- `actor_id`、`reason`、`audit_event_ref`；
- `verified_at`、`verifier=deterministic_retention_worker`。

watermark 的 scope 是 `(source, issue_id, run_id, policy_id)`。只覆盖 `event.id <= covered_through_event_id` 的连续前缀；跨 Run、跨 issue、存在 gap、policy version 不一致或 hash 缺失都不能用于删除。

LLM 可以生成摘要正文草稿，但不能推进 watermark。只有确定性 worker 在核对 source event ID 连续性、archive manifest、hash 与引用后才能写入/推进 watermark，并记录 actor/reason/audit ref。摘要是 derived projection，不替代状态、审计、Handoff Evidence 或原始 authority。

## 5. 归档 contract

删除候选还必须有同 scope 的 archive receipt：`first_event_id..through_event_id` 连续覆盖目标 event，携带 row count、manifest SHA-256、archive ref、policy version、actor/reason/audit ref、verified time，以及一次成功的 `restored_at` 恢复演练。只有复制成功不算可恢复归档。

在 archive read path 完成 parity 前，cold copy 只是 shadow archive：

1. 原表仍写入、读取并承担 source of truth；
2. archive writer 只能 append，不得改变 source operation 的结果；
3. checksum、row count、ID/order/provenance 和恢复结果进入现有 audit；
4. 任一 parity 或 restore 失败时停止推进 watermark，并保持原表不变。

archive storage 的访问控制、加密、物理位置和 archive 自身销毁属于后续实现 issue；本策略不选择新的 provider，也不把敏感 payload 写入仓库 fixture。

## 6. 删除安全规则

`evaluateEventRetention()` 只返回 `keep`、`archive` 或 `delete_candidate`，从不执行 SQL。即使全部 guard 通过，默认 `report_only` 下 `can_execute_delete=false`。

以下任一条件都会 fail closed，不能产生可执行删除：

1. event 类型 unknown / legacy，需要 `review_required`；
2. source policy 禁止删除或未达到默认保留期；
3. active `pin` 或 `legal hold`；
4. issue 是 active、failed 或 `pending_verification`，或 raw log 所属 Run 是 active run、failed run、cancelled/其他非成功状态，或 Run 状态未知；
5. event 是 Handoff Evidence，或仍有 Guardian、PI activity、Session/UI 等未解析引用；
6. summary watermark 缺失、跨 scope、非连续、hash/policy version/verifier 不合法；
7. archive receipt 缺失、未覆盖 event、checksum 不合法或未完成恢复演练；
8. destructive gate 不是显式 `allow`，或缺 actor、reason、policy version、timestamp、`audit_event_ref`；
9. event timestamp 无效或来自未来。

destructive gate 的 actor kind 只允许 `user`、`retention_worker`、`system`；contract 不接受 `llm` actor。LLM 输出不能直接变更 `execution_mode`、伪造 gate、释放 hold 或执行 delete。

特别保护规则：active、failed、`pending_verification` issue 不进入 archive/delete；failed run 保留完整 raw/terminal/error 证据；Handoff Evidence 在引用解除且 Handoff superseded 之前不删；pin/legal hold 优先级高于时间窗口。R0 projection 不是归档 authority，只有 compact V2 已切为唯一 reader、watermark 覆盖 source snapshot、fresh backup/restore 和 writer quiesce 同时成立时，才可与对应 source event 在同一事务删除旧 V1 projection row。

## 7. 配置 contract

Canonical JSON/TypeScript shape：

```json
{
  "schema_version": "xuanwu.event-retention-policy.v1",
  "policy_version": "2026-08-03",
  "execution_mode": "report_only",
  "execution_authorization": null,
  "policies": {
    "raw_operational": {
      "event_class": "raw_log",
      "tier": "R1_OPERATIONAL",
      "minimum_retention_days": 7,
      "archive_after_days": 7,
      "archive_minimum_days": 365,
      "source_delete_after_days": 7,
      "require_summary_watermark": true,
      "require_archive_before_delete": true
    }
  }
}
```

完整六类默认值以 `DEFAULT_EVENT_RETENTION_CONFIG` 为准。`validateEventRetentionConfig()` 要求全部 policy key 存在、policy version 受支持、天数是非负整数且不得短于 canonical 下限、archive 不晚于 source delete、source delete 不短于 minimum retention，并强制 raw 删除同时需要 archive 与 summary watermark。state/audit/delivery/unknown policy 在 v1 永远不能配置 source 删除；改变这些边界必须发布新 contract version，不能用运行时配置降级。

配置启用边界：

- `report_only`：只生成候选/阻塞原因；当前唯一默认；
- `archive_only`：后续可写 shadow archive，但不得删 source；
- `delete_enabled`：只有完成下节迁移门禁后才允许由 deterministic worker 使用，不能由 API 请求或 LLM 临时覆盖。

非 `report_only` 模式必须携带 actor/reason/time/policy version/`audit_event_ref` 的 `execution_authorization`；`delete_enabled` 还必须引用完成的 observation window 和 restore test。缺任一字段时配置校验失败。

## 8. 新旧模型并存、双写/双读期限与回滚

当前没有新旧模型并存，也没有双写/双读：legacy authority 继续唯一写、唯一读。未来 archive 实现必须按独立 issue 进入以下有界阶段：

1. **report**：至少一个 release observation window 只读产出候选与 blocker；
2. **shadow archive**：旧表唯一 authority；archive append + checksum/restore，不服务读取；
3. **dual read parity**：Issue/Session/Guardian/PI activity 对同一 ID/order/provenance 做逐类 comparison；
4. **cutover**：先切 archive read，再仅对 raw policy 开启 source 删除；state/audit/delivery 保持 source；
5. **retire**：满足最终删除门禁后才能停止旧 raw payload 读取。

**双写/双读期限**必须由实施 issue 写明开始时间、owner、指标和结束版本，默认不得超过两个 release window；未在期限内达成 parity 就回退 `report_only`，不得无限并存或复制第三条路径。

回滚顺序：停止 deletion worker → 切 `report_only` → 从已验证 manifest 恢复 source rows → 校验 event ID/issue/time/order/hash → 恢复旧读。任何恢复或 parity 失败都必须进入 `pi_action_events`/等价审计并停止后续 destructive batch。

## 9. 最终删除门禁

当前门禁未满足，因此本 issue 不删除 live 数据。后续要从 `delete_candidate` 进入真实 SQL delete，必须同时证明：

- P01.01 consumer matrix 中 Issue terminal、Session transcript、meaningful progress、provider error、Guardian refs、PI activity 全部完成 archive/summary parity；
- event ID、issue、run、timestamp、ordering、provenance 与 external refs 可恢复；
- pin/legal hold、active/failed Run、Handoff Evidence 和 unresolved refs 的 focused tests 通过；
- archive checksum 与 clean-baseline restore rehearsal 通过；
- report-only observation window 无误删候选；
- scoped migration、batch manifest、before/after row count、actor/reason/gate/outcome 全部可审计；
- 有明确 rollback，且删除 batch 能按 manifest 幂等重放/恢复；
- 用户或确定性 policy gate 显式授权，LLM 无法扩大 scope。

在以上条件完成前，策略代码只用于 classification、配置校验和候选审计；它不是提前删除 960 MB live `issue_events` 的许可。
