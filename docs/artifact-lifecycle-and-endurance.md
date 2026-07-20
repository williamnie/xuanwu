# Artifact lifecycle、恢复与 24h endurance gate

本 runbook 是 MEM-08 的运行手册。`runner.db`、当前 launchd binary、当前 web/runtime 目录和仍被 SQLite 引用的 content-addressed artifact 保持 live；迁移/验收用完整 DB 副本、旧 pre-change backup 和旧 binary 属于可恢复但非 active runtime reference 的 derived artifact。

## Policy 与 owner

| 类别 | owner | live policy | archive/restore policy |
| --- | --- | --- | --- |
| DB backup | runtime operator | 至少 1 份 30 日内、实际 restore 验证的 fresh backup；live 上限约 1.5 GB | 较旧副本转入 CAS；manifest 是恢复索引 |
| Migration rehearsal | migration operator | 仅留 report、row/hash/count、receipt | 完整 DB 默认立即转入 CAS，不把 rehearsal DB 当 authority |
| Evidence snapshot | Evidence producer | 默认只留 manifest、查询结果、hash 与必要 diff | 必须保留全量 DB 时转入 SHA-256 CAS，相同内容自动去重 |
| Binary | release operator | 只留 launchd 当前 binary、匹配 stamp 与 runtime wasm，约 96 MiB 上限 | 历史 binary 转入 CAS；回滚按 manifest 恢复 |
| Issue/runtime log | runner runtime | 当前 launchd logs；128 MiB 容量、30 日年龄门限 | rotation 转入 CAS；content-addressed issue log 仍按 SQLite ref 保持 live |

`scripts/artifact-lifecycle.ts` 的 inventory 对每个文件记录 owner、generator、active runtime reference、authority/derived、时间、restore value、hash/无法稳定 hash 的原因、size 与 retention class。secret 不计算 hash；会变动的 live DB/log 记录 `active_mutable`，不会以一个竞态 hash冒充可恢复证据。

## Dry-run、隔离演练与 live apply

Archive root 必须在 live Application Support 目录之外。Apply 先检查磁盘水位（默认保留 2 GiB；跨文件系统还要求容纳全部候选），所有 object/report/index 都先写 `.partial-*`、校验 SHA-256、原子 rename，再移除 source。超过 1 小时的孤儿 partial 会进入 report，并只在 apply 时清理。

```bash
APP="$HOME/Library/Application Support/codex-issue-runner-bun-live"
ARCHIVE="$HOME/Library/Application Support/codex-issue-runner-bun-archive"
RUN="$(date -u +%Y%m%dT%H%M%SZ)"

# 1. 先 report，不改 live
bun scripts/artifact-lifecycle.ts report \
  --root "$APP" --archive-root "$ARCHIVE" \
  --report "/tmp/artifact-$RUN-dry-run.json"

# 2. 在 APP 的隔离副本上使用同一命令 apply + restore；确认 manifest 中没有 active ref candidate
# 3. fresh backup 已完成完整 restore smoke 后，才允许 live apply
bun scripts/artifact-lifecycle.ts apply --apply \
  --root "$APP" --archive-root "$ARCHIVE" \
  --report "/tmp/artifact-$RUN-live.json" \
  --actor operator-id --audit-ref "issue:769:$RUN" \
  --reason "MEM-08 bounded lifecycle apply" \
  --confirm-consumer-zero --confirm-restore-tested
```

Apply 持续更新两份索引：archive 下 `manifests/<manifest-id>.json` 是 immutable restore authority；live 下 `artifact-lifecycle/index.json` 是轻量定位索引。最终 `application_support.target_status` 必须为 `passed`（≤ 3 GiB），否则命令以非零退出，不能进入最终验收。

## Restore smoke / rollback

永远恢复到不存在或空的隔离根，先核对 manifest/object SHA-256，再检查 SQLite：

```bash
bun scripts/artifact-lifecycle.ts restore --apply \
  --root "/tmp/mem08-restored-artifacts" \
  --manifest "$ARCHIVE/manifests/<manifest-id>.json" \
  --report "/tmp/mem08-artifact-restore.json" \
  --actor operator-id --audit-ref "issue:769:restore" \
  --reason "MEM-08 isolated restore smoke"

sqlite3 "/tmp/mem08-restored-state/runner.db" 'pragma quick_check'
```

若 apply 中断，先读 live `artifact-lifecycle/index.json`：已存在的 CAS object 必须重新 hash；source 仍存在时可安全重跑，source 已移动时按 manifest restore。不得删除唯一 fresh backup、唯一 manifest 或唯一 CAS object。

## 24 小时最终验收

清理和 live build/restart 后，以 `endurance-capture` 原子追加样本。至少每小时一次（首尾共 ≥25 点），并在每种真实操作完成后单独采一条：`usage`、`run_success`、`run_failure`、`run_cancel`、`run_retry`、`archive`、`restart`。采样读取 `/api/system/status.process_group_memory`、live DB/run/session、DB bytes、artifact bytes 和 Application Support bytes。

```bash
SAMPLES=/tmp/mem08-endurance-samples.json
DB="$APP/state/runner.db"

bun scripts/xuanwu-capacity-benchmark.ts endurance-capture \
  --addr 127.0.0.1:3008 --root "$APP" --db "$DB" \
  --operation idle --output "$SAMPLES"

# 每个场景后把 --operation 换成对应值；其余小时采 idle。
bun scripts/xuanwu-capacity-benchmark.ts endurance-run \
  --samples-file "$SAMPLES" --json-out /tmp/mem08-final-capacity.json
```

最终 gate 固定要求：真实跨度 ≥24h、≥25 samples、七种操作齐全、每点 budget 为 `within_budget`、RSS/footprint drift ≤64 MiB 且不是单调增长、无 orphan runner-child、无未关联 open Run 的 stale session、Application Support ≤3 GiB。DB 增长上限 8 MiB/completed Run，artifact 增长上限 16 MiB/completed Run；completed Run 必须 >0。任何字段失败时不得用 commit、短 soak、report-only 或单次健康检查替代。
