# 玄武 (Xuanwu)

**玄武**是本地优先、验证优先的 AI Engineering Control Plane：把工程目标变成可追踪的工作，交给 Coding Agents 长时间执行，并以可审计的监督、恢复、验证和交付闭环收口。`codex-issue-runner` 仅作为当前仓库、CLI 与兼容 API 的稳定标识保留。

当前规范统一从 [canonical 架构文档索引](docs/architecture/README.md) 进入。产品定位、用户承诺、非目标和迁移原则以 [ADR-XW-0001](docs/architecture/xuanwu/0001-product-positioning.md) 为准；产品、Supervisor、Runner 与兼容标识的命名以 [玄武品牌术语合同](docs/architecture/xuanwu/0002-brand-terminology.md) 和 [用户可见命名迁移清单](docs/architecture/xuanwu/0082-user-facing-naming-migration.md) 为准；六条核心工作如何端到端验收以 [Golden Journey 合同](docs/architecture/xuanwu/0003-golden-journey-contracts.md) 为准。

当前后端已经切到 Bun/TypeScript，live 默认监听 `0.0.0.0:3008`，CLI 默认连接 `127.0.0.1:3008`。

当前已具备：

- Bun API Server（默认 `0.0.0.0:3008`，支持局域网访问）
- SQLite 持久化（默认 live state 下的 `runner.db`）
- Projects / Issues REST API
- 全局 SSE：`GET /api/events`
- 项目 auto-run / loop start-stop
- issue enqueue / retry / cancel
- Triage cron：到点批量将 Triage issue 切到 Todo 并启动运行
- 通过 `codex app-server --listen stdio://` 执行 todo issue
- Dashboard Codex token 用量统计：今日/周/月 token、最近 7 天趋势、5 小时/周限额剩余量

## Dashboard 用量统计

Dashboard 会从本机 Codex session JSONL 里的 `token_count` 事件聚合用量，展示每日、周、月 token 统计，以及最新 5 小时限额和周限额的已用/剩余百分比。

![Dashboard Codex token 用量统计](docs/assets/codex-usage-dashboard.jpg)

## 本地启动

一键启动前后端：

```bash
./dev.sh
```

后端默认监听 `0.0.0.0:3008`，前端默认监听 `0.0.0.0:3568`；本机可访问 `http://127.0.0.1:3008` / `http://127.0.0.1:3568`，局域网设备可用本机 LAN IP 访问。
`./dev.sh` 是前台开发模式：终端退出后服务会停止，不适合作为长期后台服务。

也可以分别启动。后端：

```bash
cd backend-ts
bun run src/main.ts serve --addr 0.0.0.0:3008 --state-dir ../data-bun --db ../data-bun/runner.db
```

前端：

```bash
cd frontend
npm run dev
```

前端 Vite proxy 默认指向 live API `http://127.0.0.1:3008`。如果需要临时指向其他 API，可显式指定：

```bash
cd frontend
VITE_API_TARGET=http://127.0.0.1:3999 npm run dev
```

生产/部署模式下后端直接托管已构建前端产物：

```bash
cd frontend && npm run build
cd ../backend-ts && bun run build:binary
../dist/codex-issue-runner serve \
  --addr 0.0.0.0:3008 \
  --state-dir ../data-bun \
  --db ../data-bun/runner.db \
  --web-dir ../frontend/dist
```

## 一键安装部署（推荐）

如果只是使用玄武，推荐直接安装当前仍以 `codex-issue-runner` 兼容名发布的预构建二进制；脚本会自动下载当前系统架构的 release，并注册为后台服务（macOS 使用 launchd，Linux 使用 user systemd）：

```bash
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

常用覆盖项：

```bash
export CODEX_RUNNER_ADDR=0.0.0.0:3008
export CODEX_RUNNER_CORE_ADDR=127.0.0.1:3009
export CODEX_RUNNER_STATE_DIR=$HOME/.local/state/codex-issue-runner
export CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex
export CODEX_RUNNER_CODEX_SERVER_MODE=cli  # cli 或 app；也可在 Settings 页面切换
export CODEX_RUNNER_AUTH_TOKEN=your_custom_token  # 自定义 API 访问令牌（可选）
curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash
```

默认安装位置：

```txt
二进制: ~/.local/bin/codex-issue-runner
数据:   ~/.local/state/codex-issue-runner/runner.db
访问:   http://127.0.0.1:3008/（局域网使用 http://<本机LAN-IP>:3008/）
```

安装可重复执行：新二进制会先写入临时文件再原子替换，随后由 launchd/systemd 启动同 artifact 的 Web Gateway 与 Runner Core 两个进程；公开的 `3008` 只服务静态资源和代理 `/api/*`，Core 默认仅监听 `127.0.0.1:3009` 并独占 DB、scheduler、provider 与 connector。`runner.db`、token 和日志不会被升级脚本替换。Linux 额外执行 `loginctl enable-linger "$USER"`，使 user systemd 在退出登录和重启后仍会启动。macOS 的 LaunchAgent 使用 `ProcessType=Background`，作为非 GUI daemon 运行，不依赖前台 App 的 App Nap 调度。

installer 会先验证 `checksums.txt` 和 binary/release metadata 版本一致性；生产环境可设置 `CODEX_RUNNER_VERIFY_ATTESTATION=require`，通过 GitHub CLI 验证由 release workflow 签发的 provenance。安装后可只读检查更新，升级和回滚则必须提供显式 apply、非 LLM actor、已验证 backup ref 和 audit ref：

```bash
codex-issue-runner-update check --json
codex-issue-runner-update upgrade --apply \
  --actor release-automation --actor-kind system \
  --audit-ref 'change:<id>' --reason 'approved upgrade' \
  --backup-ref 'backup-manifest:sha256:<digest>' --confirm-backup-tested
```

完整发布、migration note、灾备和 binary/data rollback 边界见 [发布、升级与回滚运行手册](docs/runbooks/release-upgrade-rollback.md)；用户备份恢复命令见 [备份、导出、导入与恢复演练](docs/backup-restore.md)。

安装后使用随 release 一起安装的 daemon CLI 统一查看和管理边界：

```bash
codex-issue-runner-daemon status
codex-issue-runner-daemon doctor
codex-issue-runner-daemon restart
codex-issue-runner-daemon uninstall  # 仅移除 launchd/systemd 注册，保留所有数据
```

每次 `start`、`stop`、`restart` 和 `uninstall` 会追加到 `${CODEX_RUNNER_LOG_DIR:-$HOME/.local/state/codex-issue-runner/logs}/daemon-lifecycle.log`；命令不会显示 token。`status` 和 `doctor` 是只读命令，其中 doctor 复用现有 `/api/system/doctor` 权限与健康检查。

## 从源码后台部署（macOS launchd）

本仓库提供 macOS LaunchAgent 源码部署脚本，会构建前端与 Bun 单文件二进制，并把服务注册为后台长期运行：

```bash
./deploy.sh
```

如果只是想把当前源码重新构建并切到 live 服务，同时做部署后验活，可以执行：

```bash
./redeploy.sh
```

常用运维命令：

```bash
# 查看 launchd / 端口 / API 状态
./scripts/status-launchd.sh

# 查看产品内 runtime doctor/status（需要 API token）
./dist/codex-issue-runner system status --token-file "$HOME/Library/Application Support/codex-issue-runner-bun-live/state/auth_token" --json

# 停止并移除后台服务
./scripts/uninstall-launchd.sh
```

源码部署同样以 `ProcessType=Background` 运行；其 state 与 release 安装 state 分离，升级和卸载都不删除 `runner.db`。

默认配置：

```txt
服务名: com.xiaobei.codex-issue-runner.web / .core
监听:   Web 0.0.0.0:3008 / Core 127.0.0.1:3009
State:  ~/Library/Application Support/codex-issue-runner-bun-live/state
DB:     ~/Library/Application Support/codex-issue-runner-bun-live/state/runner.db
Web:    state/web
二进制: dist/codex-issue-runner
日志:   ~/Library/Application Support/codex-issue-runner-bun-live/logs/launchd.web.*.log / launchd.out.log / launchd.err.log
Token:  默认在服务首次启动时自动生成并写入 state/auth_token 文件中
```

可通过环境变量覆盖：

```bash
CODEX_RUNNER_ADDR=0.0.0.0:3008 \
CODEX_RUNNER_CORE_ADDR=127.0.0.1:3009 \
CODEX_RUNNER_DB=/absolute/path/runner.db \
CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex \
CODEX_RUNNER_CODEX_SERVER_MODE=cli \
CODEX_RUNNER_AUTH_TOKEN=your_custom_token \
./deploy.sh
```

直接开发时，`serve` 未指定 role 仍保持单进程 `all` 兼容行为；也可显式使用 `--role all`。正式安装默认使用 `--role web` 与 `--role core`，不要并行启动额外的 `core`/`all`。隔离验证和回滚见 [Web/Core 双进程运行手册](docs/runbooks/web-core-split.md)。

## 首次使用启动器与 Codex Server 选择

完整的首次使用路径见 [10 分钟首次交付](docs/first-delivery.md)。Command Center 会直接展示 setup wizard、成功清单和可复制的失败恢复步骤。

Dashboard 的 Settings → Runtime 里有 “首次使用启动器” 和 “Codex server 接入方式”：

- `cli`：默认模式，Runner 独立拉起 `codex app-server --listen stdio://`，适合稳定后台自动执行。
- `app`：使用 Codex App bundled server command 和 App/Chrome 集成环境，适合需要 Codex App / Chrome 能力的任务。

选择是显式的，不做智能 fallback；如果选择 `app` 后 Codex App 或对应集成不可用，新 issue/session 会按当前配置失败。切换设置会保存到 `runner-settings.local.json`，空闲时立即重启 Codex transport；有运行中的 issue/session 时只保存配置，不迁移当前 session，等运行结束后再保存一次或重启服务即可让新任务使用新 server。

### 本地 / 远程安全建议

- 本机使用优先监听 `127.0.0.1`；需要局域网或反代时才监听 `0.0.0.0`。
- 远程访问必须启用 bearer token。默认 token 文件会自动生成在 state dir `auth_token`，权限为 `0600`；不要提交 token 文件，也不要把 token 写入日志、issue 或截图。
- 浏览器 Origin 默认只允许本机 origin（`localhost` / `127.0.0.1` / `::1`）。
- `/health` 免鉴权用于健康检查；`/api/*`、`/api/system/status`、`/api/system/doctor`、SSE `/api/events` 都会走 token / origin 检查。

## GitHub Release 发布

推送 `v*` tag 后，GitHub Actions 会自动运行 Bun 后端测试、前端 lint/build，并发布 Release 资产：

```bash
git tag v0.1.0
git push origin v0.1.0
```

本地也可以手动打包：

```bash
CODEX_RUNNER_VERSION=v0.2.0 CODEX_RUNNER_ENFORCE_RELEASE=1 ./scripts/package-release.sh
```

release pipeline 会发布 `release.json`、`checksums.txt` 和四个平台压缩包，并用 GitHub OIDC/Sigstore 生成 signed build provenance。发布前必须先在 [CHANGELOG](CHANGELOG.md) 添加与 tag 完全一致的版本 heading；具体发布和验证命令见 [运维手册](docs/runbooks/release-upgrade-rollback.md)。

## CLI 调用

同一个 Bun 二进制同时支持后端服务和短命令 CLI：

```bash
# 后台服务
./dist/codex-issue-runner serve --addr 0.0.0.0:3008 --state-dir data-bun --db data-bun/runner.db

# 创建项目并开启 auto-run
./dist/codex-issue-runner project create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --id movo-web \
  --cwd /Users/xiaobei/Documents/rcrai/movo-web \
  --auto-run \
  --json

# 创建 Triage/backlog issue；不加 --run 时不会自动执行
./dist/codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project movo-web \
  --title "修复 ChatInput Stop 按钮" \
  --body-file /tmp/issue.md \
  --status triage \
  --json

# 查询状态 / 日志 / 重试 / 取消 / 删除
./dist/codex-issue-runner issue status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42
./dist/codex-issue-runner issue logs --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42
./dist/codex-issue-runner issue update --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --status done --json
./dist/codex-issue-runner issue retry --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json
./dist/codex-issue-runner issue cancel --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json
./dist/codex-issue-runner issue delete --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id 42 --json

# 查看 runner / DB / Codex command 只读健康摘要
./dist/codex-issue-runner system status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --json
```

`issue delete` 会物理删除 issue，并级联清理其日志、运行记录和评论；运行中的 `in_progress` issue 有保护，必须先 cancel 后才能 delete。

CLI 默认连接 `CODEX_RUNNER_ADDR`，未设置时使用 `127.0.0.1:3008`；也可以对任意命令传 `--addr http://127.0.0.1:3008`。
当前 CLI 子命令不实现 `--help`，`--json` 输出是完整 JSON 文档且可能跨多行。

Dashboard、Supervisor Activity 和 Issue Activity/Work timeline 默认读取可重建的 `event_summary_projection`；完整 Logs、Session/Guardian 与 legacy event API 仍读取 `issue_events` authority。首次切读或需要校验 cursor 时，在数据库副本先执行可中断重建：

```bash
cd backend-ts
COPY_DB=/path/to/runner-copy.db
bun run src/main.ts maintenance events rebuild-projection \
  --db "$COPY_DB" \
  --actor operator-id \
  --actor-kind user \
  --reason "event summary projection rebuild rehearsal" \
  --audit-ref "pi_action_events:approved-projection-rebuild" \
  --batch-size 500 \
  --json

# 使用 --max-batches N 受控暂停后，从已提交 watermark 继续
bun run src/main.ts maintenance events rebuild-projection \
  --db "$COPY_DB" \
  --actor operator-id \
  --actor-kind user \
  --reason "event summary projection rebuild rehearsal" \
  --audit-ref "pi_action_events:approved-projection-rebuild" \
  --batch-size 500 \
  --resume \
  --json
```

重建只清理 derived projection/watermark，started/paused/completed/failed 会写入 `pi_action_events`；`actor=llm` 或未知 `actor-kind` 会拒绝。该 cursor watermark 不能作为 raw 删除授权，P01.02 的 archive/summary/hold/reference/destructive gates 仍全部适用。完整 contract 见 `docs/architecture/xuanwu/0009-event-summary-projection.md`。

MEM-06 compact V2 先在含 `artifacts/issue-logs` companion snapshot 的 fresh backup 副本上
执行 shadow rebuild/verify，再进入限时 dual-read。以下命令均不删除 V1；observe/cutover/
rollback 的 apply 还要求 non-LLM actor、backup/no-writer confirmations 和 audit provenance：

```bash
bun run src/main.ts maintenance events rebuild-compact-projection --db "$COPY_DB" \
  --actor operator-id --actor-kind user --audit-ref issue:767:rehearsal \
  --reason "compact projection shadow rebuild" --batch-size 2000 --json
bun run src/main.ts maintenance events verify-compact-projection \
  --db "$COPY_DB" --performance-samples 20 --json
bun run src/main.ts maintenance events observe-compact-projection --db "$COPY_DB" \
  --actor operator-id --actor-kind user --audit-ref issue:767:rehearsal \
  --reason "bounded dual-read" --duration-seconds 86400 \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
bun run src/main.ts maintenance events cutover-compact-projection --db "$COPY_DB" \
  --actor operator-id --actor-kind user --audit-ref issue:767:rehearsal \
  --reason "atomic compact cutover" --minimum-observation-seconds 86400 \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
bun run src/main.ts maintenance events rollback-compact-projection --db "$COPY_DB" \
  --actor operator-id --actor-kind user --audit-ref issue:767:rehearsal \
  --reason "atomic read rollback" \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
```

## 事件归档与数据库维护 runbook

维护命令直接操作指定 SQLite 文件，不经过 HTTP。`issue_events` 仍是唯一 source of truth；归档目录只是 append-only shadow archive，不参与 Issue / Session / Guardian / Supervisor 的 live read。首次演练必须使用 SQLite online backup 副本，不能直接拿正式库试验。

```bash
LIVE_DB="$HOME/Library/Application Support/codex-issue-runner-bun-live/state/runner.db"
COPY_DB="/tmp/runner-maintenance-$(date +%Y%m%dT%H%M%S).db"
LIVE_DB="$LIVE_DB" COPY_DB="$COPY_DB" python3 - <<'PY'
import os, sqlite3
source = sqlite3.connect(f"file:{os.environ['LIVE_DB']}?mode=ro", uri=True)
target = sqlite3.connect(os.environ["COPY_DB"])
try:
    source.backup(target, pages=4096, sleep=0.01)
finally:
    target.close()
    source.close()
PY
```

先只读预览候选、阻塞原因、行数、payload bytes 与空间统计：

```bash
cd backend-ts
bun run src/main.ts maintenance events report \
  --db "$COPY_DB" \
  --report /tmp/event-maintenance-report.json \
  --json
```

归档按 batch 生成 gzip JSONL chunks、manifest、SHA-256、row count、连续 watermark、provenance 和隔离恢复演练结果；完成后 manifest/chunk 收口为只读 `0400`，不会删除 source row。每个 batch 后原子更新 manifest。开始前会校验最坏双份空间；可用 `--max-batches N` 主动中断演练，或在进程中断后用完全相同的 selection/audit 参数加 `--resume` 继续：

```bash
bun run src/main.ts maintenance events archive \
  --db "$COPY_DB" \
  --archive /tmp/runner-event-archive \
  --report /tmp/event-archive-report.json \
  --actor operator-id \
  --reason "retention rehearsal on database copy" \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --batch-size 500 \
  --json

# 中断后恢复；now/before/actor/reason/audit-ref 必须与 manifest 一致
bun run src/main.ts maintenance events archive \
  --db "$COPY_DB" \
  --archive /tmp/runner-event-archive \
  --report /tmp/event-archive-resume-report.json \
  --actor operator-id \
  --reason "retention rehearsal on database copy" \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --batch-size 500 \
  --resume \
  --json
```

显式 verify 阶段会重算所有 chunk/row/manifest hash，并返回均匀抽样的 event id/hash；它同时复核完整 restore rehearsal receipt：

```bash
bun run src/main.ts maintenance events verify-archive \
  --archive /tmp/runner-event-archive \
  --report /tmp/event-archive-verify.json \
  --sample-size 20 --json
```

`delete` 默认为 dry-run，且必须读取 `xuanwu.event-maintenance-delete-evidence.v1` 证据文件。先用确定性命令生成该文件；它会核对 fresh backup 与 archive snapshot、backup `quick_check`、compact V2 consumer-zero/watermark、writer quiesce、pin/legal hold snapshot、correlation，以及每个 `(issue_id, run_id, policy_id)` 的 summary watermark、archive receipt 和 destructive gate。缺失或变化一项都会 fail closed；`actor_kind=llm` 不合法。

```bash
touch /secure/path/retention-holds.json
printf '[]\n' > /secure/path/retention-holds.json
bun run src/main.ts maintenance events prepare-delete-evidence \
  --db "$COPY_DB" --backup "$BACKUP_DB" \
  --archive /tmp/runner-event-archive \
  --holds /secure/path/retention-holds.json \
  --output /secure/path/delete-evidence.json \
  --actor operator-id --actor-kind user \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --correlation-id "event-retention:$(date -u +%Y%m%dT%H%M%SZ)" \
  --reason "verified retention delete on isolated copy" --json

# 先预览；不会创建 delete checkpoint，也不会写数据库
bun run src/main.ts maintenance events delete \
  --db "$COPY_DB" \
  --archive /tmp/runner-event-archive \
  --evidence /secure/path/delete-evidence.json \
  --checkpoint /tmp/event-delete-checkpoint.json \
  --report /tmp/event-delete-dry-run.json \
  --json

# 仅在副本完成过 backup/restore rehearsal、停止所有 writer 后执行
bun run src/main.ts maintenance events delete \
  --db "$COPY_DB" \
  --archive /tmp/runner-event-archive \
  --evidence /secure/path/delete-evidence.json \
  --checkpoint /tmp/event-delete-checkpoint.json \
  --report /tmp/event-delete-apply.json \
  --batch-size 500 \
  --apply \
  --confirm-backup-tested \
  --confirm-no-active-writers \
  --json
```

批删 checkpoint 绑定 manifest/evidence hash，并在每批事务提交后原子落盘；暂停后使用相同命令加 `--resume`。Apply 会向现有 `pi_action_events` 写 started/paused/completed 审计，并在同一事务清理对应的 R0 legacy summary row；compact V2 仍保留 hash/summary。回滚使用 archive 原 ID、issue、type、payload、timestamp 恢复，已存在但 hash 不同的行会拒绝覆盖：

```bash
bun run src/main.ts maintenance events restore \
  --db "$COPY_DB" \
  --archive /tmp/runner-event-archive \
  --checkpoint /tmp/event-restore-checkpoint.json \
  --report /tmp/event-restore-report.json \
  --actor operator-id \
  --reason "rollback rehearsal" \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --apply \
  --confirm-backup-tested \
  --confirm-no-active-writers \
  --json
```

删除 source row 后先 checkpoint，再做 VACUUM。所有 DB 命令默认也是 dry-run；full VACUUM 是首次物理回收路径。若要后续使用增量 vacuum，第一次 full VACUUM 加 `--enable-incremental`，之后才能使用 `--mode incremental --pages N`：

```bash
bun run src/main.ts maintenance db checkpoint \
  --db "$COPY_DB" --mode truncate \
  --report /tmp/db-checkpoint.json \
  --actor operator-id --reason "maintenance checkpoint" \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --apply --confirm-backup-tested --confirm-no-active-writers --json

bun run src/main.ts maintenance db vacuum \
  --db "$COPY_DB" --mode full --enable-incremental \
  --report /tmp/db-vacuum.json \
  --actor operator-id --reason "reclaim archived event pages" \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --apply --confirm-backup-tested --confirm-no-active-writers --json

bun run src/main.ts maintenance db vacuum \
  --db "$COPY_DB" --mode incremental --pages 4096 \
  --report /tmp/db-incremental-vacuum.json \
  --actor operator-id --reason "incremental page reclaim" \
  --audit-ref "pi_action_events:approved-maintenance-id" \
  --apply --confirm-backup-tested --confirm-no-active-writers --json
```

副本验收至少核对 maintenance reports 的 before/after `issue_event_count`、`payload_bytes`、`file_bytes`、`quick_check`，抽查关键 state/audit/delivery event，并完整跑一次 restore。source-row 回滚走 archive restore；VACUUM 或整个维护批次的物理回滚走维护前 online backup。副本验证通过后，正式库仍须先停止 writer、创建新备份并使用与副本相同的 manifest/evidence gate；不要复用陈旧 snapshot。

当前没有双写/双读：archive 只做 shadow copy。正式 source delete 仍需 [P01.02 最终删除门禁](docs/architecture/xuanwu/0007-event-retention-policy.md#9-最终删除门禁) 全部通过；后续 dual-read parity 若未在两个 release window 内达标，必须回到 `report_only` 并停止 delete。状态、审计、交付和 unknown event 在 v1 永远不会被批删。

### 月度计划、状态与责任边界

- 每月首个维护窗口由 owner 在现有 Automation authority 创建 cron（建议 `0 3 1 * *`、本地 IANA timezone），workflow 只运行 `report → archive → verify`；Automation API `/api/automations` 和 Automations UI 是唯一计划/状态入口，不另建 cron 或状态表。
- `delete → checkpoint → vacuum` 永远不由月度 cron 自动执行；当月 operator 必须审查告警、提供 fresh backup/restore、holds、consumer-zero 与非 LLM destructive approval。archive 不得删除当时唯一的 backup 或唯一 restore receipt。
- 默认 archive SLA 是 24 小时内完成 verify；单个随机 restore smoke 4 小时内、完整 restore rehearsal 24 小时内完成。失败时暂停 Automation、保留 manifest/checkpoint/backup，并由当班 operator 负责 rollback；产品/法务 owner 负责 legal/audit hold 的建立和显式解除。
- Vacuum 报告的目标是 `file_bytes <= 400 MiB`；未达标时报告会携带 `object_usage` 和 alert，下一决定必须基于逐对象物理占用，不能把逻辑 delete 当作物理回收。

## Codex Skill（可选）

仓库内置了一个 Codex skill，方便 Codex 在会话里创建、查询、重试、取消和显式完成 runner issue：

```bash
./scripts/install-codex-skill.sh
```

安装后 skill 会写入 `${CODEX_HOME:-$HOME/.codex}/skills/codex-issue-runner/SKILL.md`。源码位于 `skills/codex-issue-runner/SKILL.md`，可随仓库一起开源和审查。

## Triage Cron

可以在 Issues 看板右上角点「定时运行 Triage」，或在 Settings 里统一管理 cron 任务。

API 示例：

```bash
curl -X POST http://127.0.0.1:3008/api/cron-tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "12点运行所有 Triage",
    "mode": "once",
    "next_run_at": "2026-05-21T04:00:00Z"
  }'
```

## 验证

```bash
cd backend-ts && bun test
cd frontend && npm run build
```

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，仅允许非商业目的使用。
商业使用、商业部署或将本项目作为商业产品/服务的一部分使用，需要获得项目作者的单独商业授权。

项目所有者保留对本项目进行商业化、专有版本发布或闭源发行的权利。

分发本项目或其衍生版本时，请同时保留 `LICENSE` 与 `NOTICE`。
