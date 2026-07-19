# ADR-XW-0074：Completion、Failure 与 Thread Watch Automation

- 状态：Accepted（P08.06 / native Watch + W1 legacy shadow）
- 依赖：P08.02 / Runner #708、P08.04 / Runner #710（均为 `done`）
- 实现：`automationWatches.ts`、`watchAutomationRuntime.ts`
- 迁移工具：`bun scripts/migrate-watch-automations.mjs --db <runner.db>`（只读预览）；copy-only apply 统一走 `migrate-automation-shadow.mjs`

## 决策

Watch 不新增另一套 Automation definition：`automation_definitions` 继续拥有 scope、权限、mode、definition lifecycle 和审计 revision；`automation_watches` 只保存观察所需的 condition、subject target、通知 target、dedupe、expiry、外部事件 cursor 和 observation/delivery outcome。Watch definition 固定为 `observe`，`next_run_at=null`，因此不会被 P08.03/P08.04 scheduler 物化成 Work/Run；30 秒 schedule layer 只调用确定性 Watch evaluator。

本期支持两类闭合 condition：

- `issue_status`：对显式 Issue ID 集合做 `all/any` 终态匹配；authoritative `issues.status` 决定 completion、failure 或 cancelled outcome。
- `external_thread_event`：从 `external_events` 的 provider、`normalized_message.thread_id/root_id` 和可选 event type 匹配；创建时保存当前最大 event ID，只观察之后到达的事件。

每个 watch 的 dedupe key 永久唯一。满足或到期时，状态、Automation archive、`pi_notification_intents`、Feishu draft、`sync_outbox` 和 notification audit 在同一 SQLite transaction 内提交；重跑只扫描 `watching`，因此同一 Watch 最多产生一个 notification intent/outbox。Watch 在 outbox 仍为 queued/retry 时保持 `satisfied/expired`，只有观察到 delivery authority 的 `sync_outbox.status=sent` 才转为 `notified`。到期产生 `timeout` outcome 并通知；显式 cancel 需要 deterministic/human allow gate，只归档并审计，不发送误导性的完成通知。

所有 create、cursor advance、satisfy/expire、notification queued、cancel 与 legacy shadow refresh 都写入既有 `automation_events`。LLM 只能提议 Watch；repository mutation 必须携带 actor、correlation、reason 和非 LLM allow gate。

## Source of truth、迁移期限与回滚

**Native Watch source of truth：** `automation_definitions` + `automation_watches`；Issue、external event、notification intent 和 outbox 仍分别拥有 Work 状态、外部事实、通知意图与 delivery audit，Watch 不反向改写这些 authority。

**Legacy completion watch source of truth：** W1 期间仍是 `pi_issue_completion_watches/items`。迁移工具只创建 `migration_mode=legacy_shadow` 的幂等 projection；runtime 明确不扫描 shadow，因此不会与现有 completion evaluator/outbox 双发。W1 dual-read=0，legacy→shadow 单向 shadow write=1；不得从 shadow 回写 legacy。

W2 只能在 condition/item/status、startup sweep、expiry、cancel、external thread cursor 和 notification dedupe parity 全部通过后开启，并最多保留一个正式 release 的 legacy read fallback；W1+W2 合计不得超过两个正式 release。G4 前回滚只需停止迁移工具并移除 Watch runtime registration，native/legacy 审计行保留；legacy writer 和通知链未被修改。

最终删除 `pi_issue_completion_watches/items` 或 shadow adapter 仅允许在 P11/G7：active 或 satisfied-but-undelivered legacy row 为 0，连续一个正式 release 无 legacy-only producer/consumer，restart/delivery recovery、备份与隔离 restore 通过，并取得精确的非 LLM destructive approval。任一门禁失败必须保留 legacy authority。

## 迁移命令

```bash
# 只读计划，不应用 schema 或 shadow row
bun scripts/migrate-watch-automations.mjs --db /path/to/runner.db

# 仅对与 source legacy checksum 一致的隔离备份副本应用 shadow write
bun scripts/migrate-automation-shadow.mjs \
  --source-db /path/to/authoritative-runner.db \
  --db /path/to/isolated-backup-copy.db --apply-to-copy \
  --actor runner-operator --correlation watch-migration-20260718 \
  --reason "isolated W1 watch parity rehearsal"
```

旧 `migrate-watch-automations.mjs --apply` 已 fail closed，避免误写 live DB。copy-only apply 必须显式提供 source、非 LLM actor、correlation 和 reason；重复执行只报告 `unchanged`。工具不发送通知、不切换 read authority，也不删除旧表。
