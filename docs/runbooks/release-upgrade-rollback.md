# 发布、升级与回滚运行手册

## 1. Authority 与兼容边界

- 发布代码的 source of truth 是发布 tag 指向的 Git commit；GitHub Release 只是该 revision 的交付投影。
- `release.json`、压缩包内后端 `--version`、前端 build version 和 tag 必须完全一致。`checksums.txt` 绑定所有平台压缩包与 `release.json`；仓库公开时，GitHub Actions 再为这些 digest 生成 signed build provenance。个人账户下的私有 GitHub 仓库不支持 artifact attestations，因此私有预发布只能依赖 checksum，不能冒充已签名产物。
- 运行数据的唯一 source of truth 仍是 `${XUANWU_STATE_DIR}/runner.db`。升级快照只保存 Runner-owned binary、web、Supervisor package 和运维脚本，不复制数据库、token、`.env` 或用户 artifact。
- 当前 release 文件没有双写/双读窗口。数据库 migration 仍由既有 forward-only `schema_migrations` 执行，兼容合同是 `xuanwu.storage-compat.v1`；不能以 release snapshot 替代数据库备份。

## 2. 发布人操作

1. 确认依赖 issue、focused tests、六条 Golden Journey 和容量门禁已通过，工作区只包含本次 release 内容。
2. 将 `CHANGELOG.md` 的 `Unreleased` 内容整理到新的 `## [MAJOR.MINOR.PATCH]`，并在本文件 [Migration notes](#migration-notes) 记录 schema、配置或 operator action。
3. 在不写外部系统的本地预检中执行：

   ```bash
   XUANWU_VERSION=v0.2.0 XUANWU_ENFORCE_RELEASE=1 \
     ./scripts/package-release.sh bun-darwin-arm64
   (cd dist/release && shasum -a 256 -c checksums.txt)
   tar -xOf dist/release/xuanwu_darwin_arm64.tar.gz ./xuanwu.build.stamp
   ```

4. 经非 LLM 发布审批后创建并 push `v*` tag。`.github/workflows/release.yml` 会重新执行测试/build、生成四平台资产、`release.json` 和 checksums；公开仓库使用 GitHub OIDC/Sigstore 生成 signed provenance，私有仓库明确跳过该不可用能力，最后写 GitHub Release。该外部写操作由 GitHub Actions run、tag 和 release event 审计；不要从 issue agent 自动 push tag。
5. 下载一个匹配平台的资产并验证：

   ```bash
   gh attestation verify xuanwu_darwin_arm64.tar.gz \
     --repo williamnie/xuanwu \
     --signer-workflow williamnie/xuanwu/.github/workflows/release.yml
   shasum -a 256 -c checksums.txt
   ```

如果 changelog 没有精确版本 heading、版本不是 `vMAJOR.MINOR.PATCH`、测试失败，或公开仓库的 provenance 无法生成，pipeline 必须失败，不发布部分资产。

## 3. 安装与更新检查

仓库公开并重新发布带 attestation 的资产后，生产安装建议要求 signed provenance 验证；需要本机已有 `gh`：

```bash
export XUANWU_VERIFY_ATTESTATION=require
curl -fsSL https://raw.githubusercontent.com/williamnie/xuanwu/main/scripts/install-release.sh | bash
xuanwu --version
xuanwu-daemon doctor
```

日常只读检查不会修改 service 或 state：

```bash
xuanwu-update check --json
```

Release 安装版也可以在“设置 → 项目 → 安全升级”中发起升级。该入口不会让 Core
直接替换自身：Core 只写入权限为 `0600` 的升级任务，再触发独立的
`com.xiaobei.xuanwu.updater` launchd job 或 `xuanwu-updater.service` systemd user unit。
updater 会先把备份写到默认的 `${XUANWU_STATE_DIR}-backups`（可用
`XUANWU_BACKUP_DIR` 覆盖），完成 checksum、SQLite `quick_check` 和隔离 import
恢复演练后，才调用固定目标版本的 installer。升级期间页面可以短暂断开；Core 恢复后
`GET /api/system/update` 会继续返回同一 job 的 `pending/running/succeeded/failed` 状态。
源码开发运行时不会注册或触发自身升级。

Release 安装版 Core 会在启动约 30 秒后执行首次检查，之后每 6 小时检查一次；网页认证完成后
也会立即读取同一检查结果。发现新版本时，网页显示可直接启动安全升级的全局对话框，并向已配置
且能解析唯一默认目标的 Feishu、Telegram 通道分别投递一次。IM 幂等键按
`release_update:<version>` 与 channel 隔离，同一版本的重复检查不会重复发送；投递继续使用
既有 `sync_outbox`、connector allowlist、receipt 与重试机制。网页“稍后提醒”只暂缓当前浏览器
6 小时，不会关闭服务端 IM 通知。

无人值守调度可以周期性执行 `check`；只有结果中的 `update_available=true` 才进入独立的受控 `upgrade` step。升级必须提供已验证备份引用、非 LLM actor、原因与 audit ref：

```bash
xuanwu-update upgrade \
  --apply \
  --actor release-automation \
  --actor-kind system \
  --audit-ref 'change:2026-07-18-001' \
  --reason 'approved scheduled upgrade' \
  --backup-ref 'backup-manifest:sha256:<digest>' \
  --confirm-backup-tested
```

工具会发现 latest、保存旧 release-owned files、调用固定版本 installer、验证 checksum/可选 attestation、重启并等待 `/health`。失败时会尝试恢复旧 release snapshot。每个 requested/applied/failed 结果都追加到 `$XUANWU_LOG_DIR/release-upgrade.log`；不得把 token 或 passphrase 写进 actor/reason/ref。
默认只保留最近 3 个 release snapshot；可以用 `XUANWU_RELEASE_RETENTION` 调整。自动删除旧 snapshot 同样记录 `snapshot-prune` audit，并且永远不删除数据库、备份、token、uploads 或 artifacts。

## 4. Migration notes

### v0.2.11

- migration：none。相对 `v0.2.10` 没有新增、删除或修改数据库 schema。
- 最低可回滚 binary：`v0.2.10`；本版本持久化合同保持兼容。
- operator action：升级前仍按常规流程生成并验证 `runner.db` 备份；没有额外配置迁移或默认值切换。

### v0.2.4

- migration：新增 additive migration `081_telegram_channel_runtime` 与
  `082_im_context_lifecycle`，只增加 Telegram/通用 IM cursor、delivery audit、context binding、
  rollover 表和索引，不删除或改写既有 authority 数据。
- 最低可回滚 binary：`v0.2.3`。旧 binary 会忽略新增表；回滚不会删除已记录的 cursor、binding、
  delivery receipt 或 rollover lineage，但 Telegram 与新 IM context lifecycle 能力在旧版本中不可用。
- operator action：升级前生成并验证 `runner.db` 备份；升级后检查 migration `081`、`082` 已完成。
  Telegram 默认不会因升级自动启用，只有显式配置 connector 与凭据后才开始接收消息。

### v0.2.3

- migration：none。本版本没有新增、删除或修改数据库 schema，也不执行数据维护。
- 最低可回滚 binary：`v0.2.2`；本版本持久化合同与 `v0.2.2` 兼容。
- operator action：升级前仍应按常规流程生成并验证 `runner.db` 备份；没有额外配置迁移或默认值切换。

### 2026-08-03 development redeploy：`067_compact_event_summary_created_at`

- 新增 additive migration `067_compact_event_summary_created_at`：为 compact event summary 增加自身 `event_created_at` 并从 `issue_events.created_at` 回填，不删除或改写 authority 数据。
- 本次 redeploy 只执行 schema forward 和新写入/告警逻辑；不自动切换 compact reader、不删除 legacy projection、不归档或删除 raw events，也不执行 live vacuum。
- 最低可回滚 runtime 为当前 `v0.2.0`：在 compact v2 consumer-zero、legacy retirement 和 raw delete 尚未执行前，额外列对旧 runtime 向后兼容。未来一旦完成上述 destructive maintenance，必须使用包含 migration `067` 和独立 compact timestamp reader 的 runtime，或恢复本次部署前 backup。
- operator action：部署前在 fresh SQLite copy 完成 migration forward/rollback rehearsal；部署脚本继续创建并 `quick_check` predeploy backup。正式三层存储迁移另开停 writer 的维护窗口。

### 从 `v0.1.0` 之后的开发版本升级

- 后端启动仍通过现有 `schema_migrations` 做 forward-only migration；没有通用 down migration。
- 正式升级前必须按 [`0070-db-migration-rehearsal-gate.md`](../architecture/xuanwu/0070-db-migration-rehearsal-gate.md) 对 fresh SQLite backup copy 执行 `migration-preflight`、`migration-forward` 和 `migration-rollback` rehearsal，并按 [`backup-restore.md`](../backup-restore.md) 完成隔离 import/restore。
- `runner.db` 仍为 authority；Work/Run/Evidence/Handoff、Issue/Session/Guardian/Supervisor 沿用既有模型，不增加 release 专用状态表或第二 truth source。
- 兼容、双写和双读期限均为 **0**：本 issue 不做 storage cutover。任何未来 schema/table 删除必须单独经过 P11/G7 destructive gate，不能由 updater 或 changelog 授权。

每个后续版本必须在此追加：新增 migration ID、最低可回滚 binary、需要的 operator action、配置默认值变化以及 restore-tested backup ref 要求。没有 migration 时明确写 “none”。

## 5. 回滚

### 5.1 数据仍兼容旧 binary

先阅读目标版本 migration note 并确认没有不可逆 schema/数据变更，再执行：

```bash
xuanwu-update rollback \
  --snapshot latest \
  --apply \
  --actor oncall-operator \
  --actor-kind user \
  --audit-ref 'incident:2026-07-18-001' \
  --reason 'rollback after failed health verification' \
  --backup-ref 'backup-manifest:sha256:<digest>' \
  --confirm-data-compatible
```

该命令停止 daemon、原子恢复上一组 release-owned files、重新启动并等待 `/health`，同时为当前版本创建 roll-forward snapshot。它不修改 `runner.db`、token、logs、uploads 或 artifacts。

### 5.2 migration 后的数据不兼容旧 binary

不要直接启动旧 binary。按以下顺序处理：

1. `xuanwu-daemon stop`，冻结所有 writer。
2. 保留故障现场和当前 `runner.db` 的只读副本；记录 digest、incident 和审批引用。
3. 用升级前经过 restore rehearsal 的 backup 导入到**新的隔离 state dir**，验证 `quick_check=ok`、authority 计数和受影响 Golden Journey。
4. 使用 `XUANWU_VERSION=<old-tag>` 安装旧版本，并让 service 指向隔离 restore；不要覆盖原 live state。
5. 健康、版本、Golden Journey 和 secret resolution 全部通过后，按独立 change record 切换 service。失败则切回原 state/binary，不能在两套 state 间双写。

完整 backup/import 命令见 [`docs/backup-restore.md`](../backup-restore.md)。数据库 restore 是单独的 destructive change，必须由非 LLM operator 审批；release updater 不具备这项权限。

## 6. 灾备与巡检

- 每日：`xuanwu-daemon status`、`xuanwu-daemon doctor`，检查 `release-upgrade.log` 和 daemon lifecycle log 的 failed 记录。
- 每周：生成加密 backup，验证 manifest/checksum，并在隔离目录执行 import + `PRAGMA quick_check`。
- 每次升级前：fresh backup copy migration rehearsal；保留 backup digest、release snapshot、GitHub Actions run、attestation verification 和 Golden Journey summary。
- 每次升级后：核对 `xuanwu --version`、`/api/system/status` 的 frontend/backend/build stamp 一致，再执行相关 Golden Journey。
- 恢复演练失败、版本不一致、attestation 无法验证、没有可用 rollback snapshot 或没有 restore-tested backup 时，停止升级并升级为 Attention/incident，不得以 LLM 判断绕过门禁。
