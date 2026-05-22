---
name: codex-issue-runner
description: Create, enqueue, inspect, retry, cancel, or finish local Codex Issue Runner issues from Codex. Use when the user asks Codex to hand work to codex-issue-runner, create a local runner issue, automate an issue loop, enqueue a task for autonomous execution, or check runner issue status/logs.
---

# Codex Issue Runner

Use the local `codex-issue-runner` CLI to hand bounded work from Codex to the local Issue Runner service.

## Preconditions

- The service should be running at `CODEX_RUNNER_ADDR` or `127.0.0.1:3008`.
- The target repository should already be registered as a project. If not, register it first.
- Prefer explicit project ids, short issue titles, and full markdown bodies in a temp file.

## Register a Project

```bash
codex-issue-runner project create \
  --id <project-id> \
  --cwd <absolute-repo-path> \
  --auto-run \
  --json
```

Use `--auto-run` when newly created `todo` issues should be picked up automatically.

## Create and Enqueue an Issue

Write the complete task to a temp markdown file, then run:

```bash
codex-issue-runner issue create \
  --project <project-id> \
  --title "<short title>" \
  --body-file /tmp/codex-issue.md \
  --run \
  --json
```

- `--run` creates the issue and then calls the enqueue endpoint.
- The returned JSON contains the runner issue `id`; keep it for status/log follow-up.
- If the user only wants a backlog item, omit `--run`.

## Inspect or Control an Issue

```bash
codex-issue-runner issue status --id <issue-id> --json
codex-issue-runner issue logs --id <issue-id>
codex-issue-runner issue retry --id <issue-id> --json
codex-issue-runner issue cancel --id <issue-id> --json
```

## Finish an Issue

After completing the requested work and running the directly relevant verification, update the runner issue explicitly:

```bash
codex-issue-runner issue update --id <issue-id> --status done --json
```

If the task cannot be completed, mark it failed with a concise reason:

```bash
codex-issue-runner issue update --id <issue-id> --status failed --error "<failure reason>" --json
```

## Operating Rules

- Do not enqueue vague planning discussion; ask or summarize into a concrete task first.
- Put the full acceptance criteria and constraints in the body file, not only the title.
- Report the created issue id and status back to the user.
- Before marking an issue `done`, run the smallest verification that proves the change.
- If the CLI cannot connect, check whether `codex-issue-runner serve` is running before retrying.
