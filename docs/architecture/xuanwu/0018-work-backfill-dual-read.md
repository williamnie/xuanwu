# ADR-XW-0018：Work backfill、双读一致性审计与回滚

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.08 / Runner #654
- 依赖：[ADR-XW-0014](0014-issue-work-compatibility-adapter.md)、[ADR-XW-0015](0015-pi-work-relation-adapter.md)、[ADR-XW-0016](0016-work-http-api.md)
- 实现：`backend-ts/src/domain/work/migrationService.ts`、`backend-ts/src/cli/maintenance.ts`

## 1. authority 与兼容窗口

本期进入 W1：`issues` / `issue_events` 仍是唯一事实与写 authority，`works` 是可由 Issue 确定性重建的 shadow。双读固定返回 legacy projection，同时读取 target 做逐字段 comparison；G4 前任何冲突都由 legacy 获胜，审计只能生成 repair proposal，不能反向修改 Issue，也不能让 LLM 或请求参数选择 winner。

- W1 可选幂等 shadow write 最多一个正式 release window；backfill 只创建缺失 target，不自动覆盖漂移 row。
- W1 + W2 双读合计最多两个正式 release window。W2 只有在 G3 证据通过后才能 target-primary，并保留确定性 legacy fallback。
- G4 前仍只有 legacy writer；G4 后必须切成 target 单 writer，W2 结束前关闭所有 dual mode。
- 最终删除 Issue carrier/adapter 仍要求 P11.05/P11.09、G7、零 Issue consumer、备份/恢复演练、观察窗结束且 rollback 不再依赖旧路径。

`WORK_MIGRATION_POLICY` 会进入每份 backfill/audit/rollback report，避免运行工具与 ADR 的 authority、期限或删除门禁漂移。

## 2. backfill 与 checkpoint

`maintenance work backfill` 默认 dry-run。它先执行全量双读，输出缺失、mismatch、orphan、source/target status counts、source SHA-256 和 repair proposals，但不创建 checkpoint、不写数据库。

Apply 必须显式提供 actor、actor kind、reason、audit ref、已验证备份和无活跃 writer 两个确认。checkpoint 固定 source SHA-256、Issue ID 集、run ID、cursor 和本 run 创建的 Work ID；每批提交后以 `0600` 原子替换。`--max-batches` 可主动暂停，`--resume` 在 source 未变时继续。崩溃发生在 DB commit 与 checkpoint 写之间时，resume 会用确定性的 `work-backfill:<run>:issue:<id>:shadow:create` event 恢复 ownership，不重复创建 row。

```bash
cd backend-ts

# dry-run，不创建 checkpoint
bun run src/main.ts maintenance work backfill \
  --db "$COPY_DB" \
  --checkpoint /tmp/work-backfill-checkpoint.json \
  --report /tmp/work-backfill-dry-run.json \
  --json

# 只在 SQLite online backup 副本、无 writer 时 apply
bun run src/main.ts maintenance work backfill \
  --db "$COPY_DB" \
  --checkpoint /tmp/work-backfill-checkpoint.json \
  --report /tmp/work-backfill-report.json \
  --batch-size 100 \
  --actor operator-id --actor-kind user \
  --reason "Work backfill rehearsal on database copy" \
  --audit-ref "pi_action_events:approved-work-migration" \
  --apply --confirm-backup-tested --confirm-no-active-writers --json

# 暂停或中断后使用相同 source/checkpoint 恢复
bun run src/main.ts maintenance work backfill \
  --db "$COPY_DB" \
  --checkpoint /tmp/work-backfill-checkpoint.json \
  --report /tmp/work-backfill-resume-report.json \
  --batch-size 100 \
  --actor operator-id --actor-kind user \
  --reason "Work backfill rehearsal on database copy" \
  --audit-ref "pi_action_events:approved-work-migration" \
  --resume --apply --confirm-backup-tested --confirm-no-active-writers --json
```

## 3. consistency report 与 repair proposal

`maintenance work audit` 永远只读。报告逐个 Issue 同时读取 legacy projection 与 target row，比对 ID、owner、type、title、goal、status、acceptance、provenance 和 workflow ref；storage revision/materialization timestamp 不参与 parity。报告还识别 target orphan，并给出三类 proposal：补建缺失 target、人工复核后按 Issue 同步 target、人工复核 orphan。工具不会自动执行后两类 repair。

```bash
bun run src/main.ts maintenance work audit \
  --db "$COPY_DB" \
  --report /tmp/work-consistency-report.json \
  --json
```

迁移 gate 要求 `quick_check=ok`、missing/mismatch/orphan 全为 0、Issue 与 target status counts 一致。正式库副本验收还要抽查各状态 Work ID/标题/状态，并保留 report、checkpoint 与副本来源记录。

## 4. rollback

Rollback 只接受某个 backfill checkpoint 拥有的 Work。删除前必须证明 row 仍只有该 run 的唯一 `work.created.v1` event、当前 row 与 create audit 完全一致且没有 target relation；任一条件不符则整次 apply fail closed，不删除任何 row。删除会级联该 shadow row 的 Work event，因此 started/paused/completed/failed 审计另写入保留的 `pi_action_events`，并保留 backfill/rollback checkpoint 与 report。

```bash
# 先 dry-run 检查 blockers
bun run src/main.ts maintenance work rollback \
  --db "$COPY_DB" \
  --backfill-checkpoint /tmp/work-backfill-checkpoint.json \
  --checkpoint /tmp/work-rollback-checkpoint.json \
  --report /tmp/work-rollback-dry-run.json \
  --json

# 副本回滚演练
bun run src/main.ts maintenance work rollback \
  --db "$COPY_DB" \
  --backfill-checkpoint /tmp/work-backfill-checkpoint.json \
  --checkpoint /tmp/work-rollback-checkpoint.json \
  --report /tmp/work-rollback-report.json \
  --batch-size 100 \
  --actor operator-id --actor-kind user \
  --reason "Work backfill rollback rehearsal" \
  --audit-ref "pi_action_events:approved-work-migration" \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
```

回滚代码开关顺序仍是：停止 shadow write/target read → 恢复纯 Issue read/write → 执行本工具移除未变化的 backfill shadow。存在 target-only delta 时，本工具拒绝删除；必须在后续 G4 runbook 中先按稳定 Issue↔Work mapping 回放受审计 delta。
