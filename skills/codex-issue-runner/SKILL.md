---
name: codex-issue-runner
description: Create, enqueue, inspect, retry, cancel, delete, or finish local Codex Issue Runner issues from Codex. Use when the user asks Codex to hand work to codex-issue-runner, create a local runner issue, automate an issue loop, enqueue a task for autonomous execution, delete stale runner issues, or check runner issue status/logs.
---

# Codex Issue Runner

Use the local `codex-issue-runner` CLI to hand bounded work from an agent/provider to the local Issue Runner service.

## Preconditions

- The Bun live service should be running at `CODEX_RUNNER_ADDR` or `127.0.0.1:3008`.
- The target repository should already be registered as a project. If not, register it first.
- Prefer explicit project ids, short issue titles, and full markdown bodies in a temp file.

## Runtime Target

Daily usage:

- Addr: `127.0.0.1:3008`
- Token file: configured service state dir `auth_token`
- launchd label: `com.xiaobei.codex-issue-runner`
- CLI: `codex-issue-runner` or repo-local `./dist/codex-issue-runner`

Use the configured token file via env or `--token-file`; never paste or print actual token values.

## CLI and Authentication

Before running CLI commands, set the bearer token when the service is auth-protected. Do not paste, hard-code, print, or commit the token value.

```bash
if [ -z "${CODEX_RUNNER_AUTH_TOKEN:-}" ]; then
  if [ -n "${CODEX_RUNNER_AUTH_TOKEN_FILE:-}" ] && [ -f "$CODEX_RUNNER_AUTH_TOKEN_FILE" ]; then
    export CODEX_RUNNER_AUTH_TOKEN="$(cat "$CODEX_RUNNER_AUTH_TOKEN_FILE")"
  fi
fi
```

Token lookup rules:

- Prefer `CODEX_RUNNER_AUTH_TOKEN` when it is already set.
- Prefer `CODEX_RUNNER_AUTH_TOKEN_FILE` when it is set.
- For release installs or other projects, the token file lives under that runner's configured state/data directory; do not assume every runner uses the current repo path.
- If the CLI returns `401 Unauthorized: unauthorized`, retry only after setting `CODEX_RUNNER_AUTH_TOKEN` or passing `--token-file <token-file>`.
- When working inside this repo and `codex-issue-runner` on `PATH` is older, prefer `./dist/codex-issue-runner` or reinstall the release/skill before retrying.
- Current subcommands do not implement `--help`; `project --help` is parsed as an unknown project command. Use this skill, repo docs, or source/tests as the CLI reference instead of probing subcommand help.
- `--json` prints a complete JSON document and may be pretty-printed across multiple lines. Parse the whole stdout; do not treat it as newline-delimited JSON.

## Smoke Checks

```bash
curl -fsS http://127.0.0.1:3008/health
codex-issue-runner system status --addr 127.0.0.1:3008 --token-file "$CODEX_RUNNER_AUTH_TOKEN_FILE" --json
./scripts/status-launchd.sh
```

## Create a Project

```bash
codex-issue-runner project create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --id <project-id> \
  --cwd /absolute/path/to/repo \
  --json
```

注册 Project 即表示交给玄武接管；服务会自动绑定 Supervisor 并启用 Issue Loop，不提供 inert Project 或 `--auto-run` 选择。

If project list is needed and CLI support is missing, query the API:

```bash
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/projects"
```

## Create Issues

Recommended Triage/backlog issue, not auto-run:

```bash
codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
  --status triage \
  --json
```

Executable issue, enqueue immediately:

```bash
codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
  --status todo \
  --run \
  --json
```

## Inspect / Retry / Cancel / Delete

```bash
codex-issue-runner issue status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
codex-issue-runner issue logs --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id>
codex-issue-runner issue retry --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
codex-issue-runner issue cancel --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
codex-issue-runner issue delete --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
```

`issue delete` physically removes the issue and cascades its issue logs/runs/comments. Running `in_progress` issues are protected: cancel them first, then delete if removal is still intended.

## Finish Work Explicitly

After direct verification passes:

```bash
codex-issue-runner issue update \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --id <issue-id> \
  --status done \
  --json
```

If verification is pending:

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"pending_verification","error":"<verification evidence summary>"}'
```

Failure or blocker:

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"failed","error":"<failure reason>"}'
```

Agents/providers must complete direct verification before writing `done`.
