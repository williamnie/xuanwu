---
name: xuanwu
description: Create, enqueue, inspect, retry, cancel, delete, or finish Xuanwu issues on local or remote projects from Codex or Claude Code. Use when the user asks an agent to hand work to Xuanwu, create a local runner issue, automate an issue loop, enqueue a task for autonomous execution, delete stale runner issues, or check runner issue status/logs.
---

# Xuanwu Issue Runner

Use the local `xuanwu` CLI to hand bounded work from Codex, Claude Code, or another compatible agent to the target Xuanwu hub, selecting the project by execution location.

## Preconditions

- The Bun live service should be running at `XUANWU_ADDR` or `127.0.0.1:3008`.
- The target repository should already be registered as a project. If not, register it first.
- Prefer explicit project ids, short issue titles, and full markdown bodies in a temp file.

## Runtime Target

Daily usage:

- Addr: `127.0.0.1:3008`
- Token file: configured service state dir `auth_token`
- launchd label: `com.xiaobei.xuanwu`
- CLI: `xuanwu` or repo-local `./dist/xuanwu`

Use the configured token file via env or `--token-file`; never paste or print actual token values.

## CLI and Authentication

Before running CLI commands, set the bearer token when the service is auth-protected. Do not paste, hard-code, print, or commit the token value.

```bash
if [ -z "${XUANWU_AUTH_TOKEN:-}" ]; then
  if [ -n "${XUANWU_AUTH_TOKEN_FILE:-}" ] && [ -f "$XUANWU_AUTH_TOKEN_FILE" ]; then
    export XUANWU_AUTH_TOKEN="$(cat "$XUANWU_AUTH_TOKEN_FILE")"
  fi
fi
```

Token lookup rules:

- Prefer `XUANWU_AUTH_TOKEN` when it is already set.
- Prefer `XUANWU_AUTH_TOKEN_FILE` when it is set.
- For release installs or other projects, the token file lives under that runner's configured state/data directory; do not assume every runner uses the current repo path.
- If the CLI returns `401 Unauthorized: unauthorized`, retry only after setting `XUANWU_AUTH_TOKEN` or passing `--token-file <token-file>`.
- When working inside this repo and `xuanwu` on `PATH` is older, prefer `./dist/xuanwu` or reinstall the release/skill before retrying.
- Current subcommands do not implement `--help`; `project --help` is parsed as an unknown project command. Use this skill, repo docs, or source/tests as the CLI reference instead of probing subcommand help.
- `--json` prints a complete JSON document and may be pretty-printed across multiple lines. Parse the whole stdout; do not treat it as newline-delimited JSON.

## Smoke Checks

```bash
curl -fsS http://127.0.0.1:3008/health
xuanwu system status --addr 127.0.0.1:3008 --token-file "$XUANWU_AUTH_TOKEN_FILE" --json
./scripts/status-launchd.sh
```

## Create a Project

```bash
xuanwu project create \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --id <project-id> \
  --cwd /absolute/path/to/repo \
  --provider <code-agent-id> \
  --default-agent-profile <agent-profile-id> \
  --json
```

注册 Project 即表示交给玄武接管；服务会自动绑定 Supervisor 并启用 Issue Loop，不提供 inert Project 或 `--auto-run` 选择。

`--provider` is the Project fallback Code Agent. `--default-agent-profile` is the preferred durable execution profile and may also define model, sandbox, approval policy, reasoning effort, and service tier. Keep the profile's provider aligned with the Project fallback unless an intentional cross-provider default is required.

## 远程节点与远程项目

所有任务都在中心创建；运行 CLI 的机器不决定任务执行位置，所选 Project 才决定。

### 从节点机器连接中心

从节点机器调用中心 API 时，`--addr` 使用 `~/.xuanwu/node.json` 的 `hub`，不要沿用本机 `127.0.0.1:3008`。只读取 `hub` 字段，不要输出整个配置文件（其中可能含节点密钥）：

```bash
export XUANWU_ADDR="$(jq -er '.hub | select(type == "string" and length > 0)' "$HOME/.xuanwu/node.json")"
xuanwu project list --addr "$XUANWU_ADDR" --token-file "$XUANWU_AUTH_TOKEN_FILE" --json
```

`XUANWU_AUTH_TOKEN_FILE` 应指向当前机器上安全提供的**中心 `auth_token`** 文件。中心 API 令牌与节点连接用的 `xwn_` 密钥不同，不能混用；不要把 `node.json` 的 `token` 当成 API 令牌，不要打印、粘贴或提交任何令牌。缺少中心 API 凭据时需由管理员提供，不能用节点密钥替代。在中心本机调用时，使用该中心实际监听地址和其配置的 `auth_token`。

### 按执行位置选择 Project

```bash
xuanwu project list --addr "$XUANWU_ADDR" --token-file "$XUANWU_AUTH_TOKEN_FILE" --json
xuanwu node list --addr "$XUANWU_ADDR" --token-file "$XUANWU_AUTH_TOKEN_FILE" --json
```

项目列表的 `node_id` 为空表示**中心本机**项目；远程项目有 `node_id`、`node_path`，`cwd` 为 `node://<node-id>:<absolute-path>`。`location` 展示节点名称与路径。同一仓库可以同时注册为本机项目和远程项目，不能只按仓库名或路径相似度选项目。核对节点 ID、节点名称和路径后，将对应的项目 `id` 传给后文 `issue create --project <project-id>`；从节点发起任务也不会自动选中该节点的项目。

远程项目可用的编程工具由目标节点决定，不应照搬中心本机的工具列表。`xuanwu node list` 可查看节点在线状态和上报的 providers；针对已选项目，用 `/api/providers?project_id=` 查看该执行位置的工具与就绪状态：

```bash
# XUANWU_AUTH_TOKEN 按上文认证步骤从中心令牌文件载入；不要启用 shell tracing。
curl -fsS -G -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  --data-urlencode "project_id=<project-id>" \
  "${XUANWU_ADDR%/}/api/providers"
```

此 curl 示例要求 `XUANWU_ADDR` 含 `http://` 或 `https://`（节点配置的 `hub` 使用此形式）；CLI 的 `--addr` 也接受不带协议的地址。根据节点的可用 provider 选择对应 Agent Profile；节点离线或工具未就绪时，不要改选中心本机的同名项目来绕过等待。

### 注册远程项目

```bash
xuanwu project create \
  --addr "$XUANWU_ADDR" \
  --token-file "$XUANWU_AUTH_TOKEN_FILE" \
  --id <remote-project-id> \
  --node-id <node-id> \
  --cwd /absolute/path/on/node/repo \
  --provider <node-code-agent-id> \
  --default-agent-profile <agent-profile-id> \
  --json
```

`--node-id` 来自 `xuanwu node list`；`--cwd` 必须是节点上的绝对路径，不是中心本机路径，也不要手写 `node://`。CLI 会请求节点校验目录，路径须在节点 `allowedRoots` 内且节点在线；省略 `--id` 时由路径检查建议项目 ID。省略 `--node-id` 则注册中心本机项目。注册后再次用 `project list` 核对执行位置，再向该 Project 建任务。

## Discover Code Agents and Profiles

Code Agent runtime ids and Agent Profile ids are different contracts. Use a runtime id such as `codex`, `claude`, or `pi-coding-agent` for `--provider`; use a durable Agent Profile id for Issue/Work routing.

```bash
curl -fsS -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/code-agents"

curl -fsS -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/agent-profiles"
```

Fresh databases include `xuanwu-provider-codex`, `xuanwu-provider-claude`, and `xuanwu-provider-pi`. Query the API instead of assuming those profiles were not customized or removed. An unknown explicit profile is rejected; omit the option to inherit the Project default/fallback.

## Shared Issue Planning Contract

Before planning, creating, or enqueueing Issues, read and follow [the shared Issue planning contract](references/issue-planning.md). It is also embedded in Xuanwu Supervisor chat; keep decomposition, unattended eligibility, body structure, dependencies, and creation summaries in that one source. The CLI-specific steps below implement that contract.

## Batch Creation and Dependencies

For a multi-Issue plan:

1. Draft the complete numbered plan with `一句话目标`, execution lane, and dependency outline.
2. Once creation is authorized, create all Issues as `triage` first and capture their real IDs. For this first pass only, use `## 依赖` followed by `- 无` and leave structured dependencies empty, even when the draft plan has dependencies. Keep the intended graph in the numbered plan until real IDs exist. Do not put draft numbers, `Issue #<id>`, or “待创建后补充” in the dependency section: draft numbers can bind to unrelated existing Issues, and unresolved placeholders are rejected even for `triage`. Do not use `--run` while the dependency graph is incomplete.
3. Update cross-references after IDs exist. An implementation Issue that defers real acceptance must name the manual Issue in `不做什么`; the manual Issue must name the implementation Issue and require review of its Run evidence.
4. Add structured dependencies to never-started Issues with `issue update --depends-on`. In the body, write dependencies as exact `Issue #<id>` references and update the body plus structured dependency in the same command so they agree.
5. Read back every Issue and compare its body and structured dependencies with the draft plan. Replace every temporary `无` that represents a planned dependency before enqueueing anything; if creation or an update fails, leave the batch in `triage` and report the incomplete graph. Verify that dependencies stay inside the same Project, contain no self-reference or cycle, represent success prerequisites only, and never make a nighttime Issue wait on a manual Issue that remains in `triage`.
6. Run the unattended preflight. If the user explicitly asks to start the batch, enqueue only the nighttime Issues after the graph is complete. Dependency-ready roots may run immediately; downstream Issues remain queued until structured dependency readiness allows them to run.
7. Keep manual Issues in `triage`. Do not enqueue the entire mixed batch merely because the user said “全部开始”.

Example dependency update:

```bash
xuanwu issue update \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --id <dependent-issue-id> \
  --body-file /tmp/dependent-issue.md \
  --depends-on <prerequisite-id-1>,<prerequisite-id-2> \
  --json
```

Enqueue an already-created nighttime Issue only after the graph and preflight are complete:

```bash
xuanwu issue enqueue \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --id <issue-id> \
  --json
```

`depends_on_issue_ids` is a hard success dependency: the downstream Issue waits until every referenced Issue is `done`. Do not use it for cleanup, rollback verification, incident review, or a final report that must still run when an upstream Issue fails or is cancelled. Record those upstream IDs as provenance and schedule the continuation after observing the authoritative terminal state.

Only update title, body, or dependencies while an Issue is `triage` or `todo` and has never created a Run. Do not edit planning metadata after execution has started.

## Create Issues

Recommended Triage/backlog issue, not auto-run:

```bash
xuanwu issue create \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
  --agent-profile <agent-profile-id> \
  --status triage \
  --json
```

Executable issue, enqueue immediately:

```bash
xuanwu issue create \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
  --agent-profile <agent-profile-id> \
  --status todo \
  --run \
  --json
```

Use `--run` only for one already-classified standalone Issue. For a multi-Issue batch, create `triage` Issues first, finish the dependency graph and unattended preflight, then use `xuanwu issue enqueue --id <issue-id>` for the nighttime Issues.

`--agent-profile` selects the Code Agent for this Issue. Omit it to inherit `default_agent_profile_id`, then the Project `provider`. Change an unstarted Issue with `xuanwu issue update --id <issue-id> --agent-profile <agent-profile-id> --json`; pass an empty value only when intentionally clearing an explicit assignment.

## Inspect / Retry / Cancel / Delete

```bash
xuanwu issue status --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue logs --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id>
xuanwu issue retry --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue cancel --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue delete --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
```

`issue delete` physically removes the issue and cascades its issue logs/runs/comments. Running `in_progress` issues are protected: cancel them first, then delete if removal is still intended.

## Report Results and Confirm PI Acceptance

For a Xuanwu-managed executor working on its own Issue, report the verification evidence or blocker in the final response and end with exactly one matching marker:

```text
RUNNER_OUTCOME: completed
RUNNER_OUTCOME: failed | <actual execution failure>
RUNNER_OUTCOME: needs_user | <required human action and why>
```

Choose one marker, not all three. Use `completed` only after the scoped direct verification passes. The Host reconciles the Run and PI decides the Issue status. The executor must not update, retry, cancel, or otherwise control its own Issue lifecycle, or remove its managed-executor identity to bypass that boundary.

An external operator can request PI acceptance after inspecting the current Run and its evidence:

```bash
xuanwu issue update \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --id <issue-id> \
  --status done \
  --json
```

`--status done` requests PI acceptance; it does not force completion. A canonical Run is required. If the current Run is still open, the request is deferred; after the Run ends, acceptance can be requested while the Issue remains `in_progress`. An Issue with no Run cannot be completed through this command.

Read back the authoritative status and logs after the request:

```bash
xuanwu issue status --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue logs --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id>
```

Report completion only after the authoritative Issue status is `done`. If PI acceptance is still pending, report that pending state without changing the Issue to a made-up status. `pending_verification` is not a valid Issue status, and direct API writes of `failed` or `needs_user` are rejected because those decisions belong to PI. For an external operator observing a failure or human blocker, report the current status and evidence; do not force a lifecycle transition. Never substitute failure for a human requirement or success for missing verification.
