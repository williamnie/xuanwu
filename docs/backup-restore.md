# 备份、导出、导入与恢复演练

`runner.db` 是当前唯一的持久化 source of truth；state dir 中的配置、Supervisor runtime 文件和 `artifacts/`、`uploads/` 是随库恢复的 companion data。本工具不增加数据库表、HTTP API、双读/双写或第二个状态机。

## 安全边界

- 导出通过 SQLite `VACUUM ... INTO` 创建一致性数据库快照，再执行 `quick_check`；不会直接复制 WAL 中的活动数据库文件。
- snapshot manifest 包含每个 payload 的 SHA-256、schema migration 列表、导出审计 actor/reason/audit ref、保留策略的删除清单和 secret refs。
- `auth_token`、`.env`、`auth.json`、私钥文件及其他明显的 secret material **永远不导出**；manifest 只保留恢复时需要重新解析的引用，不泄漏值。显式的 `*-ref.*` 配置（例如 `secret-ref.json`）会作为普通配置导出。恢复后必须从受保护环境或 secret store 补回。
- 未加密目录备份提供意外损坏检测（SHA-256），但不提供来源认证；跨主机传输或含敏感 artifact 时必须使用 `--encrypt`。加密格式为 AES-256-GCM + scrypt，passphrase 仅从权限为 `0600` 的文件读取，不能作为命令参数、manifest 或日志输出。
- 导入只接受空的隔离 target state dir，且强制 `--apply` 和非 LLM actor；不会覆盖 live state dir。导入前自动完成 manifest、payload checksum 与 SQLite `quick_check` 校验，并在 target 写入 `restore-audit.json`。
- retention 只会删除输出同级、名称以 `xuanwu-backup-` 开头的旧备份；删除清单先写入新 backup manifest，再执行删除。`--retain` 必须至少为 `1`。

## 导出与校验

先从受保护文件加载加密 passphrase（不要用 shell history 或环境回显保存它）：

```bash
umask 077
printf '%s' 'use-a-secret-manager-value' > /secure/xuanwu-backup.passphrase

./dist/xuanwu backup export \
  --state-dir "$XUANWU_STATE_DIR" \
  --db "$XUANWU_DB" \
  --output /secure/backups/xuanwu-backup-$(date -u +%Y%m%dT%H%M%SZ).encrypted \
  --encrypt --passphrase-file /secure/xuanwu-backup.passphrase --retain 7 \
  --actor backup-operator --actor-kind system --audit-ref change:backup-20260718 \
  --reason 'scheduled encrypted backup' --json

./dist/xuanwu backup verify \
  --input /secure/backups/xuanwu-backup-20260718T000000Z.encrypted \
  --passphrase-file /secure/xuanwu-backup.passphrase --json
```

`--db` defaults to `<state-dir>/runner.db`; `--state-dir` defaults to `data-bun`. 导出结果 JSON 和 manifest 是操作审计证据，应保存在安全的备份日志位置。

## 隔离恢复演练

停止或隔离任何会写入 target 的 runner，然后使用一个不存在或为空的目录。不要把 `--target-state-dir` 指向 live state dir：

```bash
RESTORE_ROOT="$(mktemp -d /tmp/xuanwu-restore.XXXXXX)"
rm -rf "$RESTORE_ROOT" # import 要求 target 不存在或为空

./dist/xuanwu backup import \
  --input /secure/backups/xuanwu-backup-20260718T000000Z.encrypted \
  --passphrase-file /secure/xuanwu-backup.passphrase \
  --target-state-dir "$RESTORE_ROOT" --apply \
  --actor restore-operator --actor-kind user --audit-ref drill:restore-20260718 \
  --reason 'isolated restore drill' --json

# Golden Journey 读取 smoke：仅从恢复库读取权威 Issue/Session/Guardian/Supervisor 数据，不启动 writer。
bun -e 'import { openDatabase } from "./backend-ts/src/db/database.ts"; const db = await openDatabase({ readonlyImportPath: process.argv[1] + "/runner.db" }); console.log(db.sqlite.query("select count(*) as count from issues").get()); db.close()' "$RESTORE_ROOT"
```

演练通过条件：`backup import` 返回 `verified: true`、`restore-audit.json` 存在、`runner.db` 的 `quick_check` 为 `ok`，并且上面的只读 Golden Journey smoke 能读取预期 authority。随后按部署运行手册通过 secret store 补回 manifest 列出的 secret refs；本工具从不把 secret material 恢复到磁盘。

## 兼容、回滚与删除门禁

本期兼容窗口、双写和双读窗口均为 **0**；没有迁移和 source-of-truth 切换。导入只产生新的隔离目录，因此回滚是删除该隔离目录并保留原 live state 不变。任何对 live state 的替换必须在单独、受审批的运行变更中完成，并重新执行 integrity、受影响 Golden Journey 和 secret resolution。备份本身不能授权 schema/table/route 删除；P11/G7 的 fresh backup、隔离 restore、非 LLM 批准和保留 artifact 门禁仍然适用。
