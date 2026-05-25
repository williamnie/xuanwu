---
name: codex-issue-runner
description: Create, enqueue, inspect, retry, cancel, or finish local Codex Issue Runner issues from Codex. Use when the user asks Codex to hand work to codex-issue-runner, create a local runner issue, automate an issue loop, enqueue a task for autonomous execution, or check runner issue status/logs.
---

# Codex Issue Runner

Use the local `codex-issue-runner` CLI to hand bounded work from an agent/provider to the local Issue Runner service.

## Preconditions

- The service should be running at `CODEX_RUNNER_ADDR` or `127.0.0.1:3008`.
- The target repository should already be registered as a project. If not, register it first.
- Prefer explicit project ids, short issue titles, and full markdown bodies in a temp file.

## CLI and Authentication

Before running CLI commands, set the bearer token when the service is auth-protected. Do not paste, hard-code, print, or commit the token value.

```bash
if [ -z "${CODEX_RUNNER_AUTH_TOKEN:-}" ]; then
  if [ -n "${CODEX_RUNNER_AUTH_TOKEN_FILE:-}" ] && [ -f "$CODEX_RUNNER_AUTH_TOKEN_FILE" ]; then
    export CODEX_RUNNER_AUTH_TOKEN="$(cat "$CODEX_RUNNER_AUTH_TOKEN_FILE")"
  elif [ -f data/auth_token ]; then
    export CODEX_RUNNER_AUTH_TOKEN="$(cat data/auth_token)"
  fi
fi
```

Token lookup rules:

- Prefer `CODEX_RUNNER_AUTH_TOKEN` when it is already set.
- Prefer `CODEX_RUNNER_AUTH_TOKEN_FILE` when it is set.
- For this repository's source deploy, the default token file is `data/auth_token`.
- For release installs or other projects, the token file lives under that runner's configured state/data directory; do not assume every runner uses the current repo path.
- If the CLI returns `401 Unauthorized: unauthorized`, retry only after setting `CODEX_RUNNER_AUTH_TOKEN` or passing `--token "$(cat <token-file>)"`.
- When working inside this repo and `codex-issue-runner` on `PATH` is older, prefer `./dist/codex-issue-runner` or reinstall the release/skill before retrying.
- Current subcommands do not implement `--help`; `project --help` is parsed as an unknown project command. Use this skill, repo docs, or source/tests as the CLI reference instead of probing subcommand help.
- `--json` prints a complete JSON document and may be pretty-printed across multiple lines. Parse the whole stdout; do not treat it as newline-delimited JSON.

## Register a Project

```bash
codex-issue-runner project create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --id <project-id> \
  --cwd <absolute-repo-path> \
  --auto-run \
  --json
```

Use `--auto-run` when newly created `todo` issues should be picked up automatically.

If you need to confirm a registered project id, the CLI currently has no `project list` command; call the API directly:

```bash
curl -fsS -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/projects"
```

## Create an Issue

Write the complete task to a temp markdown file, then run:

```bash
codex-issue-runner issue create \
  --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
  --status triage \
  --json
```

- The default status is `triage`, but pass `--status triage` explicitly for backlog/triage creation.
- Omit `--run` when the user only wants a Triage/backlog item.
- The returned JSON contains the runner issue `id`; keep it for status/log follow-up.

To create and immediately enqueue an executable issue, add `--run`:

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

- `--run` creates the issue and then calls the enqueue endpoint; runner loops claim `todo` issues, not `triage`.

## Inspect or Control an Issue

```bash
codex-issue-runner issue status --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
codex-issue-runner issue logs --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id>
codex-issue-runner issue retry --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
codex-issue-runner issue cancel --addr "${CODEX_RUNNER_ADDR:-127.0.0.1:3008}" --id <issue-id> --json
```

## Agent Execution Contract

Every agent/provider that works on a runner issue must explicitly update the issue's final status after completing the directly relevant verification. A completed model turn, chat response, or local code change is not enough.

Preferred success path:

```bash
codex-issue-runner issue update --id <issue-id> --status done --json
```

Failure/blocker path:

```bash
codex-issue-runner issue update --id <issue-id> --status failed --error "<failure reason>" --json
```

If a provider cannot execute the CLI, it must call the Runner HTTP API with equivalent `PATCH /api/issues/<issue-id>` semantics. Use `CODEX_RUNNER_AUTH_TOKEN` or `--token`; never hard-code or expose tokens.

```bash
curl -fsS -X PATCH "http://${CODEX_RUNNER_ADDR:-127.0.0.1:3008}/api/issues/<issue-id>" \
  -H "Authorization: Bearer ${CODEX_RUNNER_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

## Operating Rules

- Run the token setup snippet once in the same shell before project/issue/status/update commands when auth may be enabled.
- Do not enqueue vague planning discussion; ask or summarize into a concrete task first.
- Put the full acceptance criteria and constraints in the body file, not only the title.
- Report the created issue id and status back to the user.
- Before marking an issue `done`, run the smallest verification that proves the change.
- If the CLI cannot connect, check whether `codex-issue-runner serve` is running before retrying.
