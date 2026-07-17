# 0070 数据库迁移演练与兼容门禁（P10.02）

## 边界

P10.02 为现有 SQLite migration runner 增加**副本演练门禁**，不改变任何 API、domain command、authority 或共享状态机。

- `issues` / `issue_events` 仍是 Work 的 authority；`works`、`work_relations`、`work_events` 仅在既有 W0-W2 兼容窗口内作为 shadow/projection。
- `issue_runs` / `agent_sessions` 仍是 Run 的 authority；`run_attempts` 是既有兼容 relation/projection。
- Evidence 与 Handoff 目前由 `issue_events`、确定性 verification 与 Git/Evidence 引用承载，尚无已批准的 target storage migration。P10.02 明确报告为 deferred，不能为“补齐表”临时复制一套 storage。
- 不做 dual writer、read/write cutover、旧表/route/index 删除。它们仍须通过 P02/P03/P04/P05 对应计划、G3-G7 和 P11 delete gate。

兼容版本固定为 `xuanwu.storage-compat.v1`。任何较旧或不同版本都 fail closed，并报告 `compatibility downgrade or mismatch`；不得靠 LLM 选择 mapping 或放行。

## 可执行演练

只对正式库的**隔离副本**执行；不要把 `--db` 指向运行中的服务数据库。先用部署环境的系统 doctor 确认服务/数据库可读，再建立副本：

```bash
codex-issue-runner doctor --json
sqlite3 "$LIVE_DB" ".backup '/tmp/xw-p10-02/runner-copy.db'"

codex-issue-runner maintenance db migration-preflight \
  --db /tmp/xw-p10-02/runner-copy.db \
  --report /tmp/xw-p10-02/preflight.json --json

codex-issue-runner maintenance db migration-forward \
  --db /tmp/xw-p10-02/runner-copy.db \
  --backup /tmp/xw-p10-02/pre-forward.db \
  --report /tmp/xw-p10-02/forward.json \
  --actor release-operator --actor-kind user \
  --audit-ref change:CHG-123 --reason 'P10.02 rehearsal' \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
```

`migration-forward` 会先创建 SQLite online backup，再运行现有 forward-only `runMigrations()`，执行 quick/foreign-key health gate，生成 JSON report，并把非 LLM actor、reason、audit ref 与结果写入 `pi_action_events`。

报告明确列出 migration IDs、表计数、source of truth、deferred stream 和 P11 destructive deny；它不是 cutover 授权。Work parity/backfill 继续使用已有 `maintenance work audit|backfill|rollback`，并要求其独立 checkpoint/report。

## 回滚与失败

对同一副本回滚仅恢复这次 forward 前的 fresh backup：

```bash
codex-issue-runner maintenance db migration-rollback \
  --db /tmp/xw-p10-02/runner-copy.db \
  --backup /tmp/xw-p10-02/pre-forward.db \
  --report /tmp/xw-p10-02/rollback.json \
  --actor release-operator --actor-kind user \
  --audit-ref change:CHG-123 --reason 'P10.02 rollback rehearsal' \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
```

两条 apply 命令均要求 backup/no-writer confirmations、非 LLM actor 与 audit reference；缺少任一项即拒绝。forward 失败时仍保留 pre-forward backup 和 `outcome=failed` report，不能继续尝试 cutover。回滚后 health gate 预期回到旧 schema 的 `blocked`，这是恢复证据而非失败。

部署脚本不得隐式执行 migration 或替换 live DB：发布前由操作者先完成以上副本 preflight/forward/rollback 演练，再按既有 deploy/redeploy 和 system doctor 进行服务 health 验证。
