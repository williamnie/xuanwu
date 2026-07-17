# ADR-XW-0073：统一 Secret 生命周期与脱敏注册表

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P10.06 / Runner #729
- 硬依赖：XW P00.05 / #635（`done`）
- canonical 实现：`backend-ts/src/security/secrets/`、`backend-ts/src/security/redactionRegistry.ts`
- 运维入口：`codex-issue-runner secrets ...`

## 1. Authority 与 reference

新写入的凭据只以 `secret://<name>` 引用出现在配置、审计、API 和 UI；引用不是凭据。secret backend 是 material 的唯一 source of truth，metadata 只包含 backend、ref、status、version 和时间，不包含 value。运行时内部 `SecretService.resolve()` 是唯一允许取得 material 的边界，不提供 HTTP readback，也没有 `secrets get` 命令。

当前接入点：

- PI provider `models.json`：`apiKeyRef` 替代 `apiKey`；创建 session 时只解析所选 provider，并以不落盘的 `AuthStorage` runtime override 注入。
- Feishu local settings：`appSecretRef`、`encryptKeyRef`、`verificationTokenRef` 替代 raw 字段；运行态加载后仍复用现有 `FeishuConnectorConfig`，没有第二套 connector。
- GitHub/GitLab：已有 `tokenRef` contract 继续保留；`secret://` 与 `env://` 由统一 resolver 解析，历史自定义 locator 保持兼容。
- Runner API bearer token 与 PI OAuth `auth.json` 仍沿用既有受保护 carrier；本期不改变认证 schema，也不把 OAuth refresh token 迁入 provider `models.json`。

## 2. Backend、权限与生命周期

默认 `file` backend 使用 AES-256-GCM；`<stateDir>/secrets/store.json` 只有 ciphertext/IV/tag/metadata，随机 256-bit master key 独立保存在 `<stateDir>/secrets/master.key`。目录为 `0700`，文件为 `0600`，原子 rename 更新。设置 `CODEX_RUNNER_SECRET_BACKEND=keychain` 或 CLI `--backend keychain` 时，material 进入 macOS Keychain，metadata 仍在 state dir；写入值通过 stdin 交给 `/usr/bin/security`，不出现在 argv。

`put` 只创建不存在或已撤销的 ref；已有 active ref 必须 `rotate`。轮换原地增加 version，旧 ciphertext/keychain item 不保留；撤销删除 material、保留 revoked metadata，因此无法 readback 或回滚旧 value。所有 create/rotate/revoke 通过现有 `pi_action_events` 记录 `secret.created|rotated|revoked`，只写 ref/backend/version/status、actor 和 reason。

```bash
# value 必须来自权限受控文件或 stdin，不放进命令行参数
codex-issue-runner secrets put \
  --state-dir "$CODEX_RUNNER_STATE_DIR" --db "$CODEX_RUNNER_DB" \
  --name integrations/github/token --value-file - \
  --actor operator --reason "initial connector setup" --json

codex-issue-runner secrets rotate \
  --state-dir "$CODEX_RUNNER_STATE_DIR" --db "$CODEX_RUNNER_DB" \
  --ref secret://integrations/github/token --value-file - \
  --actor operator --reason "scheduled rotation" --json

codex-issue-runner secrets revoke \
  --state-dir "$CODEX_RUNNER_STATE_DIR" --db "$CODEX_RUNNER_DB" \
  --ref secret://integrations/github/token \
  --actor operator --reason "connector retired" --json
```

## 3. Redaction registry

`redactionRegistry.ts` 统一敏感字段、assignment/Bearer/query、常见 provider key/JWT/private-key 模式，并动态注册本进程实际解析或写入的 secret value。`util/redact.ts`、audit、external event、diagnostics 和 prompt-injection egress 检查复用该 registry。`*_ref`、`*_configured`、`*_changed`、token usage count 是安全 metadata，不被误删；value 永远脱敏。

日志/API/UI 只返回 configured/status/ref metadata。provider connection probe 的临时 key 先注册再发请求；错误只返回稳定错误码。缺失或撤销分别产生 `secret_not_found` / `secret_revoked`，不得静默回退到另一个 raw value。

## 4. 迁移、兼容、回滚和删除门禁

- **source of truth：** 有 `secret_ref` 时 backend authoritative；不存在 ref 时才允许读取 legacy raw 字段。
- **双读期限：** 本 release 保留 `apiKey`、Feishu raw secret 和 remote Git raw token 的 legacy read，仅用于升级；新写入立即写 ref，不双写 raw。
- **迁移：** 先 dry-run，再 apply。apply 将 legacy value 写入 backend、原子改写配置并删除 raw 字段；每个 secret 写入有独立审计。

```bash
codex-issue-runner secrets migrate --state-dir "$CODEX_RUNNER_STATE_DIR" --json
codex-issue-runner secrets migrate --state-dir "$CODEX_RUNNER_STATE_DIR" --db "$CODEX_RUNNER_DB" \
  --apply --actor operator --reason "P10.06 secret-ref migration" --json
codex-issue-runner secrets scan --state-dir "$CODEX_RUNNER_STATE_DIR" --db "$CODEX_RUNNER_DB" --json
```

- **回滚：** apply 前可直接回滚 scoped commit；apply 后不得把 secret 通过 CLI/API readback 再写回 raw 文件。需要回到旧 binary 时，必须先从变更前受控系统快照恢复旧配置与对应凭据，再撤销迁移后 ref；没有该快照时只允许 roll-forward。这是安全门禁，不提供隐式 material export。
- **最终删除 legacy read：** 仅当 `secrets scan` 对生产 DB 和配置连续两个 release 为零、所有 provider/connector restart smoke 通过、备份恢复演练证明 refs 可重建、且没有仍依赖 raw 字段的旧 binary，才能删除 legacy reader。删除由后续 scoped issue 完成。
- **backend 回滚：** backend 切换不是复制命令；必须对每个 ref 走 audited rotate/put，并在新 backend smoke 后撤销旧 backend material。

## 5. 历史 payload 扫描与验证

`secrets scan` 只读遍历 SQLite text/JSON 列与 legacy 配置，按 table/column 或 public config path 聚合计数；报告固定 `values_included=false`，不输出命中 value。`auth.json`、encrypted store 和 master key 是既有受保护 credential carrier，不作为“历史 payload”扫描输入。

Focused contract：

```bash
cd backend-ts
bun test src/security/secrets/secrets.test.ts \
  src/cli/secrets.test.ts \
  src/http/piProviderSettingsApi.test.ts \
  src/http/feishuSettingsApi.test.ts \
  src/config/env.test.ts \
  src/http/systemLogs.test.ts \
  src/http/systemStatus.test.ts
```

验证必须证明：file material at rest 不含明文；keychain argv 不含 value；API/CLI metadata 无 readback；rotation version 增长且旧值失效；revoke 后 resolve fail closed；缺 key 错误明确；历史扫描报告不含命中 value；audit 只含 ref metadata。
