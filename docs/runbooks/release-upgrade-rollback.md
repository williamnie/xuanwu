# 发布、升级与回滚运行手册

## 1. Authority 与兼容边界

- 发布代码的 source of truth 是发布 tag 指向的 Git commit；GitHub Release 只是该 revision 的交付投影。
- `release.json`、压缩包内后端 `--version`、前端 build version 和 tag 必须完全一致。`checksums.txt` 绑定所有平台压缩包与 `release.json`，GitHub Actions 再为这些 digest 生成 signed build provenance。
- 运行数据的唯一 source of truth 仍是 `${CODEX_RUNNER_STATE_DIR}/runner.db`。升级快照只保存 Runner-owned binary、web、Supervisor package 和运维脚本，不复制数据库、token、`.env` 或用户 artifact。
- 当前 release 文件没有双写/双读窗口。数据库 migration 仍由既有 forward-only `schema_migrations` 执行，兼容合同是 `xuanwu.storage-compat.v1`；不能以 release snapshot 替代数据库备份。

## 2. 发布人操作

1. 确认依赖 issue、focused tests、六条 Golden Journey 和容量门禁已通过，工作区只包含本次 release 内容。
2. 将 `CHANGELOG.md` 的 `Unreleased` 内容整理到新的 `## [MAJOR.MINOR.PATCH]`，并在本文件 [Migration notes](#migration-notes) 记录 schema、配置或 operator action。
3. 在不写外部系统的本地预检中执行：

   ```bash
   CODEX_RUNNER_VERSION=v0.2.0 CODEX_RUNNER_ENFORCE_RELEASE=1 \
     ./scripts/package-release.sh bun-darwin-arm64
   (cd dist/release && shasum -a 256 -c checksums.txt)
   tar -xOf dist/release/codex-issue-runner_darwin_arm64.tar.gz ./codex-issue-runner.build.stamp
   ```

4. 经非 LLM 发布审批后创建并 push `v*` tag。`.github/workflows/release.yml` 会重新执行测试/build、生成四平台资产、`release.json` 和 checksums，使用 GitHub OIDC/Sigstore 生成 signed provenance，最后写 GitHub Release。该外部写操作由 GitHub Actions run、tag 和 release event 审计；不要从 issue agent 自动 push tag。
5. 下载一个匹配平台的资产并验证：

   ```bash
   gh attestation verify codex-issue-runner_darwin_arm64.tar.gz \
     --repo williamnie/xuanwu \
     --signer-workflow williamnie/xuanwu/.github/workflows/release.yml
   shasum -a 256 -c checksums.txt
   ```

如果 changelog 没有精确版本 heading、版本不是 `vMAJOR.MINOR.PATCH`、测试失败或 provenance 无法生成，pipeline 必须失败，不发布部分资产。

## 3. 安装与更新检查

生产安装建议要求 signed provenance 验证；需要本机已有 `gh`：

```bash
export CODEX_RUNNER_VERIFY_ATTESTATION=require
curl -fsSL https://raw.githubusercontent.com/williamnie/xuanwu/main/scripts/install-release.sh | bash
codex-issue-runner --version
codex-issue-runner-daemon doctor
```

日常只读检查不会修改 service 或 state：

```bash
codex-issue-runner-update check --json
```

无人值守调度可以周期性执行 `check`；只有结果中的 `update_available=true` 才进入独立的受控 `upgrade` step。升级必须提供已验证备份引用、非 LLM actor、原因与 audit ref：

```bash
codex-issue-runner-update upgrade \
  --apply \
  --actor release-automation \
  --actor-kind system \
  --audit-ref 'change:2026-07-18-001' \
  --reason 'approved scheduled upgrade' \
  --backup-ref 'backup-manifest:sha256:<digest>' \
  --confirm-backup-tested
```

工具会发现 latest、保存旧 release-owned files、调用固定版本 installer、验证 checksum/可选 attestation、重启并等待 `/health`。失败时会尝试恢复旧 release snapshot。每个 requested/applied/failed 结果都追加到 `$CODEX_RUNNER_LOG_DIR/release-upgrade.log`；不得把 token 或 passphrase 写进 actor/reason/ref。
默认只保留最近 3 个 release snapshot；可以用 `CODEX_RUNNER_RELEASE_RETENTION` 调整。自动删除旧 snapshot 同样记录 `snapshot-prune` audit，并且永远不删除数据库、备份、token、uploads 或 artifacts。

## 4. Migration notes

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
codex-issue-runner-update rollback \
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

1. `codex-issue-runner-daemon stop`，冻结所有 writer。
2. 保留故障现场和当前 `runner.db` 的只读副本；记录 digest、incident 和审批引用。
3. 用升级前经过 restore rehearsal 的 backup 导入到**新的隔离 state dir**，验证 `quick_check=ok`、authority 计数和受影响 Golden Journey。
4. 使用 `CODEX_RUNNER_VERSION=<old-tag>` 安装旧版本，并让 service 指向隔离 restore；不要覆盖原 live state。
5. 健康、版本、Golden Journey 和 secret resolution 全部通过后，按独立 change record 切换 service。失败则切回原 state/binary，不能在两套 state 间双写。

完整 backup/import 命令见 [`docs/backup-restore.md`](../backup-restore.md)。数据库 restore 是单独的 destructive change，必须由非 LLM operator 审批；release updater 不具备这项权限。

## 6. 灾备与巡检

- 每日：`codex-issue-runner-daemon status`、`codex-issue-runner-daemon doctor`，检查 `release-upgrade.log` 和 daemon lifecycle log 的 failed 记录。
- 每周：生成加密 backup，验证 manifest/checksum，并在隔离目录执行 import + `PRAGMA quick_check`。
- 每次升级前：fresh backup copy migration rehearsal；保留 backup digest、release snapshot、GitHub Actions run、attestation verification 和 Golden Journey summary。
- 每次升级后：核对 `codex-issue-runner --version`、`/api/system/status` 的 frontend/backend/build stamp 一致，再执行相关 Golden Journey。
- 恢复演练失败、版本不一致、attestation 无法验证、没有可用 rollback snapshot 或没有 restore-tested backup 时，停止升级并升级为 Attention/incident，不得以 LLM 判断绕过门禁。
