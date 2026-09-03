# Qoder release 与真实账号验收手册

## 1. 当前证据边界

本手册是 Qoder Q6 的人工 handoff，供 Q7 在操作者明确授权安装、登录和付费调用后执行。Q6 只完成了
离线 fixture、发布包回归和迁移演练；**没有**安装全局软件、登录 Qoder、调用真实模型、部署或修改
live Runner 数据。因此在本手册全部通过并归档证据前：

- Qoder `supportLevel` 必须保持 `preview`；
- fixture、SDK 类型检查、release package test 和本手册都不能写成 live-tested；
- Credits 只能按 Qoder 原始单位记录，不能换算或宣称为 USD/CNY 成本；
- 真实 PAT、Service Account material、登录态和 bearer token 不得写入 Issue、命令参数、日志或截图。

官方 Qoder 文档入口：

- [CLI 安装与升级](https://docs.qoder.com/cli/install)
- [Quick Start 与交互登录](https://docs.qoder.com/en/cli/quick-start)
- [SDK Authentication](https://docs.qoder.com/en/cli/sdk/authentication)
- [Model 与账号可用模型](https://docs.qoder.com/en/cli/model)

### 1.1 Q6 新鲜离线证据（2026-08-12）

以下结果来自当前分支、隔离临时目录和 fake Provider，不包含真实 Qoder 请求：

- Qoder/core/runtime/profile/API/CLI focused backend：`209 pass / 0 fail`；Q6 端到端 fixture 单独为
  `2 pass / 0 fail / 43 assertions`；
- Qoder touched frontend focused：`64 pass / 0 fail`；frontend 全测修正一条已过期的结构断言后为
  `530 pass / 0 fail`，ESLint 与 Vite production build 通过；
- 新库、旧库与 Qoder 内置 Profile migration rehearsal：`20 pass / 0 fail`；
- backend 全测：`2067 pass / 1 fail`。唯一失败是既有 Claude fixture
  `provider Run event fixture conformance > normalizes Claude fixtures...`：默认随机 Session ID 与 fixture 中
  硬编码的 `claude-session` 不一致；相关 Claude 文件相对 Qoder 分支基线无 diff，单测可稳定复现，Q6 不修改；
- backend 全量 `tsc --noEmit` 仍有 `142` 条既有诊断；本次 Q6 fixture 与 Qoder 路径命中 `0`；
- 签名 host binary、相邻 exact-pinned `xuanwu.qodercli/qodercli.mjs` (`1.1.23`) 及完整 runtime assets、release/install/daemon tests
  `22 pass / 0 fail`、package host smoke、缺失 Qoder asset fail-closed、upgrade/rollback 回归均通过；
- release tests 首次受 `XUANWU_MANAGED_EXECUTION=1` 保护门禁拦截，第二次受继承的 Claude
  platform-profile 环境拦截；清除这些任务外环境后上述 `22/22` 通过。这是隔离环境边界，不是产品回归；
- `git diff --check` 通过。真实安装、登录、模型请求、deploy、live DB 与 launchd 验收均为 `NOT RUN`。

`scripts/package-release.sh` 的实际归档生成会先执行 backend 全测，因此仍被上述既有 Claude fixture 失败挡住；
Q6 没有绕过 preflight。release package test 已覆盖 staging、manifest、host binary smoke、Qoder asset
缺失失败以及 fresh install/update/upgrade/rollback，但正式 archive 必须在该既有门禁恢复后重新生成。

## 2. 验收记录与停止条件

开始前复制下面变量并填写非敏感值。`QODER_ACCEPTANCE_MAX_PAID_TURNS` 是操作者停止条件，不是 Runner
的强制计费上限；每个真实 turn 后都要核对 Credits。达到 turn 数、账号预算或任何异常计费阈值时立即停止。

```bash
export QODER_ACCEPTANCE_VERSION='<approved-xuanwu-release-tag>'
export QODER_ACCEPTANCE_MAX_PAID_TURNS=6
export QODER_ACCEPTANCE_MAX_CREDITS='<operator-approved-credit-limit>'
export QODER_ACCEPTANCE_ADDR='127.0.0.1:3308'
export QODER_ACCEPTANCE_CORE_ADDR='127.0.0.1:3309'
export QODER_ACCEPTANCE_AGENTIC_ADDR='127.0.0.1:3310'
export QODER_ACCEPTANCE_LABEL='com.xiaobei.xuanwu-qoder-acceptance'
export QODER_ACCEPTANCE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/xuanwu-qoder-live.XXXXXX")"
export QODER_ACCEPTANCE_INSTALL_DIR="$QODER_ACCEPTANCE_ROOT/bin"
export QODER_ACCEPTANCE_STATE_DIR="$QODER_ACCEPTANCE_ROOT/state"
export QODER_ACCEPTANCE_REPO="$QODER_ACCEPTANCE_ROOT/repository"
export QODER_ACCEPTANCE_QODER_CONFIG="$QODER_ACCEPTANCE_ROOT/qoder-config"
mkdir -p "$QODER_ACCEPTANCE_REPO" "$QODER_ACCEPTANCE_QODER_CONFIG"
git -C "$QODER_ACCEPTANCE_REPO" init
git -C "$QODER_ACCEPTANCE_REPO" config user.name 'Qoder Acceptance'
git -C "$QODER_ACCEPTANCE_REPO" config user.email 'qoder-acceptance@example.invalid'
printf '# Qoder acceptance fixture\n\nDo not access files outside this repository.\n' > "$QODER_ACCEPTANCE_REPO/README.md"
git -C "$QODER_ACCEPTANCE_REPO" add README.md
git -C "$QODER_ACCEPTANCE_REPO" commit -m 'test: initialize isolated qoder fixture'
```

停止并记录 `BLOCKED` 的条件：版本不是冻结的 SDK `1.0.32` / CLI `1.1.40` / protocol `1.3.0`；
release 缺少相邻 `xuanwu.qodercli/` runtime directory 或其中任一必需 asset；provider 不 ready；仓库或 state dir 不在上述隔离根目录；出现未知
付费、凭据暴露、跨仓库写入、Session ID 漂移、interrupt 串线、孤儿进程或无法回滚。

## 3. 安装与认证（二选一）

### 3.1 安装 release 包内冻结 runtime

Q7 必须以 release 包为最终证据，不能只运行源码 checkout。下面使用独立 label、端口、安装目录和 state dir，
不会指向日常 Runner 数据：

```bash
XUANWU_VERSION="$QODER_ACCEPTANCE_VERSION" \
XUANWU_ADDR="$QODER_ACCEPTANCE_ADDR" \
XUANWU_CORE_ADDR="$QODER_ACCEPTANCE_CORE_ADDR" \
XUANWU_AGENTIC_ADDR="$QODER_ACCEPTANCE_AGENTIC_ADDR" \
XUANWU_LAUNCHD_LABEL="$QODER_ACCEPTANCE_LABEL" \
XUANWU_INSTALL_DIR="$QODER_ACCEPTANCE_INSTALL_DIR" \
XUANWU_STATE_DIR="$QODER_ACCEPTANCE_STATE_DIR" \
XUANWU_QODER_AUTH_MODE=local-cli \
XUANWU_QODER_CONFIG_DIR="$QODER_ACCEPTANCE_QODER_CONFIG" \
./scripts/install-release.sh

"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu" --version
"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu.qodercli/qodercli.mjs" --version
test "$("$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu.qodercli/qodercli.mjs" --version | awk 'NR==1 {print $1}')" = '1.1.40'
test -s "$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu.qodercli/policies/sandbox-default.toml"
```

安装器会验证 release 内 Qoder asset 存在且版本精确匹配；缺失或漂移必须失败，不能退回系统 `PATH` 或
Qoder Desktop。

### 3.2 认证方式 A：同一系统用户的 local CLI 登录

如需独立安装可交互的官方 CLI，使用冻结版本；这是 Q7 的显式全局安装动作，Q6 不执行：

```bash
npm install -g @qoder-ai/qodercli@1.1.40
QODER_CONFIG_DIR="$QODER_ACCEPTANCE_QODER_CONFIG" qodercli --version
QODER_CONFIG_DIR="$QODER_ACCEPTANCE_QODER_CONFIG" qodercli
```

在 TUI 内输入 `/login`，选择浏览器或 PAT 登录。不要把 PAT 放在命令行。登录后退出 TUI，重新运行上节
installer，保持 `XUANWU_QODER_AUTH_MODE=local-cli` 与同一个 `XUANWU_QODER_CONFIG_DIR`。local-cli 只适合
同一用户的人工机验收，不应作为无状态 CI/生产服务的默认认证。

### 3.3 认证方式 B：Runner SecretService 中的 PAT

自动化/守护进程优先使用 PAT 或 Service Account secret ref。先安装隔离 binary，再从 stdin 写入加密
SecretService；输入结束按 `Ctrl-D`，命令不会 read back secret：

```bash
"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu" secrets put \
  --state-dir "$QODER_ACCEPTANCE_STATE_DIR" \
  --db "$QODER_ACCEPTANCE_STATE_DIR/runner.db" \
  --name providers/qoder/acceptance-pat \
  --value-file - \
  --actor qoder-live-operator \
  --reason 'Qoder Q7 isolated acceptance' \
  --json
```

随后用固定 release installer 重配隔离服务：

```bash
XUANWU_VERSION="$QODER_ACCEPTANCE_VERSION" \
XUANWU_ADDR="$QODER_ACCEPTANCE_ADDR" \
XUANWU_CORE_ADDR="$QODER_ACCEPTANCE_CORE_ADDR" \
XUANWU_AGENTIC_ADDR="$QODER_ACCEPTANCE_AGENTIC_ADDR" \
XUANWU_LAUNCHD_LABEL="$QODER_ACCEPTANCE_LABEL" \
XUANWU_INSTALL_DIR="$QODER_ACCEPTANCE_INSTALL_DIR" \
XUANWU_STATE_DIR="$QODER_ACCEPTANCE_STATE_DIR" \
XUANWU_QODER_AUTH_MODE=pat-secret-ref \
XUANWU_QODER_CREDENTIAL_REF='secret://providers/qoder/acceptance-pat' \
XUANWU_QODER_CONFIG_DIR="$QODER_ACCEPTANCE_QODER_CONFIG" \
./scripts/install-release.sh
```

`pat-env` 只适用于明确受控、能继承环境变量的前台进程；launchd 不应假设继承交互 shell 环境。任何方式
都只在 status 中显示 `auth_mode/auth_source/auth_configured`，不得显示 credential material。

## 4. Readiness、Project、Profile 与首轮 Run

```bash
export XUANWU_AUTH_TOKEN_FILE="$QODER_ACCEPTANCE_STATE_DIR/auth_token"
export XUANWU_ADDR="$QODER_ACCEPTANCE_ADDR"

curl -fsS "http://$QODER_ACCEPTANCE_ADDR/health"
"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu" system status \
  --addr "$QODER_ACCEPTANCE_ADDR" --token-file "$XUANWU_AUTH_TOKEN_FILE" --json \
  | jq '.providers[] | select(.id == "qoder")'
```

预期 `support_level=preview`、`ready=true`、`submittable=true`、SDK/CLI/protocol 为冻结版本，且
`active_sessions=0`。如 Qoder 被关闭，用认证 API 显式启用并再次读取：

```bash
acceptance_token="$(<"$XUANWU_AUTH_TOKEN_FILE")"
curl -fsS -X PATCH "http://$QODER_ACCEPTANCE_ADDR/api/code-agents/qoder" \
  -H "Authorization: Bearer $acceptance_token" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' \
  | jq '.agents[] | select(.id == "qoder")'
unset acceptance_token
```

创建只指向隔离仓库的 Project，并验证内置 profile：

```bash
"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu" project create \
  --addr "$QODER_ACCEPTANCE_ADDR" --token-file "$XUANWU_AUTH_TOKEN_FILE" \
  --id qoder-live --cwd "$QODER_ACCEPTANCE_REPO" \
  --provider qoder --default-agent-profile xuanwu-provider-qoder --json

acceptance_token="$(<"$XUANWU_AUTH_TOKEN_FILE")"
curl -fsS -H "Authorization: Bearer $acceptance_token" \
  "http://$QODER_ACCEPTANCE_ADDR/api/agent-profiles" \
  | jq '.[] | select(.id == "xuanwu-provider-qoder") | {id,provider,model,approval_policy,sandbox}'
unset acceptance_token
```

把首轮 prompt 保持为只读、小输入、单一结果。创建 Issue 前将人工已用 turn 计数设为 `0`；每次真实请求后
递增并对照第 2 节上限：

```bash
acceptance_turns=0
"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu" issue create \
  --addr "$QODER_ACCEPTANCE_ADDR" --token-file "$XUANWU_AUTH_TOKEN_FILE" \
  --project qoder-live --agent-profile xuanwu-provider-qoder \
  --title 'Qoder live acceptance round 1' \
  --body 'Read README.md only. Reply with its heading and do not modify files.' \
  --status todo --run --json | tee "$QODER_ACCEPTANCE_ROOT/issue-create.json"
acceptance_turns=$((acceptance_turns + 1))
test "$acceptance_turns" -le "$QODER_ACCEPTANCE_MAX_PAID_TURNS"
export QODER_ACCEPTANCE_ISSUE_ID="$(jq -r '.issue.id // .id' "$QODER_ACCEPTANCE_ROOT/issue-create.json")"
```

轮询到 Run terminal 后，从 API 取得 authoritative refs；不要从模型文本猜 ID：

```bash
acceptance_token="$(<"$XUANWU_AUTH_TOKEN_FILE")"
curl -fsS -H "Authorization: Bearer $acceptance_token" \
  "http://$QODER_ACCEPTANCE_ADDR/api/issues/$QODER_ACCEPTANCE_ISSUE_ID/runs" \
  | tee "$QODER_ACCEPTANCE_ROOT/issue-runs.json" | jq '.[-1]'
export QODER_ACCEPTANCE_SESSION_ID="$(jq -r '.[-1].provider_session_id' "$QODER_ACCEPTANCE_ROOT/issue-runs.json")"
test -n "$QODER_ACCEPTANCE_SESSION_ID"
curl -fsS -H "Authorization: Bearer $acceptance_token" \
  "http://$QODER_ACCEPTANCE_ADDR/api/sessions/qoder:$QODER_ACCEPTANCE_SESSION_ID" \
  | tee "$QODER_ACCEPTANCE_ROOT/session-round-1.json" | jq '{id,provider,status,credits,turns}'
unset acceptance_token
git -C "$QODER_ACCEPTANCE_REPO" status --short
```

预期 Issue/Run/Attempt/Event/agent_sessions 使用同一 `provider_session_id`；首轮有独立 invocation 和
result/message ref；仓库无修改；只有主 result 关闭 Attempt；未知事件保留为 nonterminal。

## 5. 两轮 resume、Credits 对账与重启恢复

下面两次请求必须返回同一 Session ID 和不同 turn/message ref。每轮后保存完整脱敏 JSON，递增 turn 计数，
并查看 `credits.last_request`、`credits.session` 和 `credits.observed_requests`：

```bash
for round in 2 3; do
  acceptance_token="$(<"$XUANWU_AUTH_TOKEN_FILE")"
  curl -fsS -X POST \
    -H "Authorization: Bearer $acceptance_token" \
    -H 'Content-Type: application/json' \
    "http://$QODER_ACCEPTANCE_ADDR/api/sessions/qoder:$QODER_ACCEPTANCE_SESSION_ID/messages" \
    -d "{\"prompt\":\"Resume round $round: read README.md only and report the same heading; do not modify files.\"}" \
    | tee "$QODER_ACCEPTANCE_ROOT/resume-$round.json" | jq '{provider,thread_id,turn_id,status}'
  acceptance_turns=$((acceptance_turns + 1))
  test "$acceptance_turns" -le "$QODER_ACCEPTANCE_MAX_PAID_TURNS"
  curl -fsS -H "Authorization: Bearer $acceptance_token" \
    "http://$QODER_ACCEPTANCE_ADDR/api/sessions/qoder:$QODER_ACCEPTANCE_SESSION_ID" \
    | tee "$QODER_ACCEPTANCE_ROOT/session-round-$round.json" | jq '{id,credits}'
  unset acceptance_token
done
```

对账规则：

1. `thread_id` 始终等于 `$QODER_ACCEPTANCE_SESSION_ID`，两轮 `turn_id` 各不相同；
2. `last_request` 是本次 request Credits，`session` 是 Session 累计值；累计值单调不减；
3. `observed_requests.value` 等于可观察 request Credits 的和；若上游字段不完整，必须显示 partial/unavailable；
4. Session 累计 Credits 不得重复写成多个 Attempt 的 delta；`total_cost_usd=0` 不得展示为“免费”；
5. 任一累计值超过 `$QODER_ACCEPTANCE_MAX_CREDITS`，停止后续真实请求并记录 `BUDGET_STOP`。

完成前两轮后重启**隔离**服务，确认历史仍可读，再执行最多一轮恢复请求：

```bash
XUANWU_LAUNCHD_LABEL="$QODER_ACCEPTANCE_LABEL" \
XUANWU_STATE_DIR="$QODER_ACCEPTANCE_STATE_DIR" \
XUANWU_INSTALL_DIR="$QODER_ACCEPTANCE_INSTALL_DIR" \
"$QODER_ACCEPTANCE_INSTALL_DIR/xuanwu-daemon" restart

acceptance_token="$(<"$XUANWU_AUTH_TOKEN_FILE")"
curl -fsS -H "Authorization: Bearer $acceptance_token" \
  "http://$QODER_ACCEPTANCE_ADDR/api/sessions/qoder:$QODER_ACCEPTANCE_SESSION_ID" \
  | tee "$QODER_ACCEPTANCE_ROOT/session-after-restart.json" | jq '{id,status,credits}'
unset acceptance_token
```

只有重启后 Session ID、history、last turn ref 与 Credits 都连续，且恢复显式使用 `resume` 而非创建新
Session，才通过 restart recovery。

## 6. Interrupt、并发 lease 与孤儿进程

在两个不同隔离 Project 中同时启动长于人工操作窗口、但仍只读的 Qoder Issue。观察两条 Qoder process
lease 后，只对其中一个 Session 调用：

```bash
acceptance_token="$(<"$XUANWU_AUTH_TOKEN_FILE")"
curl -fsS -X POST \
  -H "Authorization: Bearer $acceptance_token" \
  "http://$QODER_ACCEPTANCE_ADDR/api/sessions/qoder:<session-to-interrupt>/interrupt" \
  | tee "$QODER_ACCEPTANCE_ROOT/interrupt.json"
unset acceptance_token
```

必须证明：目标 Attempt 只有一个 `interrupted` 终态；另一 Session 正常结束且 ref 不变；approval pending
被 deny；两条 lease 最终都消失。Run 全部终止后检查相邻 CLI 子进程：

```bash
pgrep -af 'xuanwu\.qodercli\.mjs|qodercli' || true
```

只允许操作者主动打开的 TUI；若存在 Runner 的遗留 child PID，记录 PID/PPID、Run/Session ref 后停止验收，
不要为过门禁直接 kill 与任务无关的进程。

## 7. 失败、权限与 secret redaction

依次用独立小样本验证：无效/过期认证、不可用 model、quota/budget（仅在可安全触发的测试账号）、临时网络
失败、未知事件、max turns、workspace-write symlink escape 和显式 approval deny。预期 auth/quota/model/policy
为非自动重试终态，network/timeout 只标 retryable 而不自行扩大预算，unknown 永不关闭主 Run。

只保存脱敏 API/日志样本：

```bash
rg -n 'Bearer |access[_-]?token|personal[_-]?access[_-]?token|service[_-]?account' \
  "$QODER_ACCEPTANCE_STATE_DIR/logs" "$QODER_ACCEPTANCE_ROOT" \
  --glob '!qoder-config/**' || true
```

命中项必须只有字段名、`secret://` ref、configured 状态或 `[redacted]`。不要截图登录 UI、SecretService
输入或 shell history。真实 material 不进入本检查命令，也不通过 API read back。

## 8. Release upgrade/rollback 与证据归档

在隔离 state 上执行一次 approved-version → next approved-version → rollback；升级前先备份并完成隔离 restore
演练。按 [release-upgrade-rollback.md](release-upgrade-rollback.md) 使用带 actor/reason/audit/backup ref 的
`xuanwu-update upgrade --apply` 和 `xuanwu-update rollback --apply`。每一步核对：

- binary/build stamp、SDK `1.0.32`、CLI `1.1.40`、protocol `1.3.0`；
- `xuanwu.qodercli/qodercli.mjs` 始终存在且 executable，`policies/`、worker、proto 与 sandbox profiles 随目录整体升级和回滚；缺失 asset 的安装必须 fail closed；
- Qoder config dir、secret ref、Project/Profile/Issue、Session history 和 usage readback 保持一致；
- rollback 不恢复凭据副本、不覆盖 `runner.db`，且 release-owned Qoder asset 与 binary 同版本恢复。

最终在 `$QODER_ACCEPTANCE_ROOT/report.md` 记录：时间、平台/架构、Xuanwu revision/release、SDK/CLI/protocol、
账号类型（只写 `PAT`/`Service Account`/`local-cli`）、批准的 turn/Credits 上限、每轮 refs 与 Credits、
interrupt/concurrency/restart/upgrade/rollback 结果、失败矩阵、孤儿进程检查和所有 `NOT RUN` 项。任何必需项
未执行时保持 `preview`；只有完整 live evidence review 通过后，另开独立变更评估 `preview → tested`。
