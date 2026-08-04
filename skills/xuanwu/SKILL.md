---
name: xuanwu
description: Create, enqueue, inspect, retry, cancel, delete, or finish local Xuanwu issues from Codex or Claude Code. Use when the user asks an agent to hand work to Xuanwu, create a local runner issue, automate an issue loop, enqueue a task for autonomous execution, delete stale runner issues, or check runner issue status/logs.
---

# Xuanwu Issue Runner

Use the local `xuanwu` CLI to hand bounded work from Codex, Claude Code, or another compatible agent to the local Xuanwu service.

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
  --json
```

注册 Project 即表示交给玄武接管；服务会自动绑定 Supervisor 并启用 Issue Loop，不提供 inert Project 或 `--auto-run` 选择。

If project list is needed and CLI support is missing, query the API:

```bash
curl -fsS -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/projects"
```

## Create Issues

Recommended Triage/backlog issue, not auto-run:

```bash
xuanwu issue create \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
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
  --status todo \
  --run \
  --json
```

## Inspect / Retry / Cancel / Delete

```bash
xuanwu issue status --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue logs --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id>
xuanwu issue retry --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue cancel --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
xuanwu issue delete --addr "${XUANWU_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
```

`issue delete` physically removes the issue and cascades its issue logs/runs/comments. Running `in_progress` issues are protected: cancel them first, then delete if removal is still intended.

## Finish Work Explicitly

After direct verification passes:

```bash
xuanwu issue update \
  --addr "${XUANWU_ADDR:-127.0.0.1:3008}" \
  --id <issue-id> \
  --status done \
  --json
```

If verification is pending:

```bash
curl -fsS -X PATCH "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"pending_verification","error":"<verification evidence summary>"}'
```

Failure or blocker:

```bash
curl -fsS -X PATCH "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"failed","error":"<failure reason>"}'
```

Agents/providers must complete direct verification before writing `done`.
