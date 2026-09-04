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
  --provider <code-agent-id> \
  --default-agent-profile <agent-profile-id> \
  --json
```

注册 Project 即表示交给玄武接管；服务会自动绑定 Supervisor 并启用 Issue Loop，不提供 inert Project 或 `--auto-run` 选择。

`--provider` is the Project fallback Code Agent. `--default-agent-profile` is the preferred durable execution profile and may also define model, sandbox, approval policy, reasoning effort, and service tier. Keep the profile's provider aligned with the Project fallback unless an intentional cross-provider default is required.

If project list is needed and CLI support is missing, query the API:

```bash
curl -fsS -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/projects"
```

## Discover Code Agents and Profiles

Code Agent runtime ids and Agent Profile ids are different contracts. Use a runtime id such as `codex`, `claude`, or `pi-coding-agent` for `--provider`; use a durable Agent Profile id for Issue/Work routing.

```bash
curl -fsS -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/code-agents"

curl -fsS -H "Authorization: Bearer ${XUANWU_AUTH_TOKEN}" \
  "http://${XUANWU_ADDR:-127.0.0.1:3008}/api/agent-profiles"
```

Fresh databases include `xuanwu-provider-codex`, `xuanwu-provider-claude`, and `xuanwu-provider-pi`. Query the API instead of assuming those profiles were not customized or removed. An unknown explicit profile is rejected; omit the option to inherit the Project default/fallback.

## Plain-Language Contract

User-facing Issue titles, one-sentence goals, plans, and completion summaries must **说人话**: use short, concrete language that a product owner can understand without reading the implementation details.

- Match the language of the user's current request. If the user is speaking Chinese, write Issue titles, `一句话目标`, body headings, plans, and summaries in Simplified Chinese even when the Agent's system prompt or this Skill is written in English.
- If the user writes in more than one language, follow the main language of the current request and keep proper nouns in their original form. For a non-Chinese user, translate the body headings but preserve the same section order and meaning.
- Keep code identifiers, commands, API names, and necessary technical terms in their original form. Explain them briefly in the user's language when they are not self-explanatory.
- The language used to write `SKILL.md` is instruction language, not the required output language. Do not copy its English prose into Chinese Issue bodies.
- Every Issue must have one `一句话目标` that states the observable result, not the implementation process.
- Prefer a verb plus a concrete result. Name the user, system, or behavior that changes.
- Avoid empty abstractions and stacked jargon such as “能力闭环”, “链路拉通”, “体系建设”, “状态治理”, “机制沉淀”, or “端到端赋能” unless the user already uses the exact term and it is required for accuracy.
- Do not repeat the PRD, design document, or conversation in the user-facing summary. Link or cite the authoritative source instead.
- Keep identifiers and technical terms only when they help the executor act or the user track the result.

Bad: `打通多端协同能力闭环并完善状态治理`

Good: `用户撤销设备后，旧设备不能再连接`

Bad: `完善移动端通知链路`

Good: `App 收到审批通知后能打开对应会话`

## Plan and Decompose Work

Before creating Issues from a PRD, design, roadmap, or long conversation, read the authoritative material and identify its goals, non-goals, acceptance criteria, open questions, and required ordering.

- Split by independently useful outcomes, not by generic layers such as “frontend”, “backend”, and “tests”. A layer is an Issue only when it has one bounded, independently verifiable result.
- Each executable Issue must have one primary outcome, a bounded scope, explicit non-goals, concrete acceptance criteria, a replayable validation path, and only the dependencies required for success.
- Keep the shortest MVP delivery chain separate from later productization, polish, migration, rollout, and manual acceptance.
- Do not create separate business Issues for routine executor self-checks, normal code review, or the standard completion card. Create a separate verification Issue only when it needs a different environment, owner, device, account, or produces distinct evidence.
- Do not target a fixed Issue count. Determine the count dynamically from independently useful outcomes, implementation boundaries, risk, required environments, and dependency order. A focused change may need one Issue; a large project may need many.
- When a large project produces a long or hard-to-understand DAG, divide it into clear delivery phases. By default, create or enqueue the current phase and summarize later phases; create the full backlog only when the user asks for it.
- Prefer the smallest complete dependency DAG. Do not inflate the count to look thorough, and do not merge unrelated outcomes merely to make the list shorter.
- Recheck an Issue as too large when its one-sentence goal joins separate results with words such as “以及” or “并且”, spans changes that could be merged independently, or would rerun unrelated work when one part fails.
- After presenting the split, use at most one plain sentence to explain why these boundaries fit the project size. Recheck any Issue that is much larger or smaller than its siblings instead of forcing all Issues to the same size.
- Ask at most one question for the entire batch, and only when the answer is required to start the unattended batch safely. Move every other unresolved item to a human `triage` Issue instead of asking a series of questions or guessing.
- If the user asks to review the split first, present the complete numbered plan and dependency outline without creating or enqueueing anything.

## Unattended Eligibility Gate

Classify every planned Issue before enqueueing it:

- **夜间可执行**: can be completed with the repository, existing non-interactive credentials, and automated commands already available to the Agent.
- **需要人工**: requires a physical device, QR scan, OTP/CAPTCHA, fresh login, account authorization, user choice, subjective visual judgment, payment, external communication, production release approval, or another person/system that may not respond during the run.

Apply these rules:

- Only enqueue `夜间可执行` Issues for an unattended batch.
- Create `需要人工` Issues as `triage` and do not enqueue them. Clearly state why they require daytime handling.
- Before enqueueing, confirm from current authoritative state that the selected Agent Profile resolves to `approval=unattended`, has enough already-authorized access for the task, and will not upgrade ordinary tool use into an interactive approval prompt.
- Preflight required credentials without printing or copying secret values; required local services such as databases, containers, emulators, and development servers; upstream Issue status; and known third-party network or rate-limit availability. If a prerequisite is unavailable, keep the affected Issue in `triage`.
- When implementation and manual acceptance are distinct, split them. Scope the implementation Issue to code plus automated verification, and put device/account/manual acceptance in a separate triage Issue.
- Do not weaken or silently remove real acceptance requirements. Moving a criterion into a manual Issue is visible separation, not deletion. The project or release is not fully accepted until every required manual Issue is completed.
- Do not make unrelated implementation depend on a manual-acceptance Issue. Only a genuine release or product decision gate should wait for it.
- An Issue in the unattended queue must not depend on a manual Issue that remains in `triage`; keep a genuine release gate out of the night queue until its manual prerequisites are done.
- If the manual step must happen before any safe implementation is possible, keep the downstream Issues out of the unattended queue and surface the blocker once.
- If a genuine human requirement is discovered only at runtime, report `needs_user` truthfully. Never label it `failed` or `done` merely to release the workspace lock; false failure can also waste the night on retries that cannot succeed without a person.
- A hard-dependent downstream Issue remains blocked when its prerequisite is `failed` or `cancelled`. Report it for daytime handling and do not invent or enqueue compensation work unless the user already authorized that work.
- Before starting a night batch, report how many Issues can run unattended, which Issues were held for a person, and whether any queued Issue can still reasonably enter `needs_user`.

## Compact Issue Body

Keep the body concise and point to the authoritative PRD/design instead of copying it. When the nighttime executor can reread the source through a stable repository path or durable reference, normally stay under about 800 Chinese characters excluding commands and links. If essential context exists only in the planning conversation, include enough of it for a fresh executor to work safely even when the body becomes longer.

Every Issue requires `一句话目标`, `做什么`, `验收标准`, and `依赖`. A nighttime Issue also requires `自动验证`. A manual Issue replaces that section with `人工验收`, naming the required device, account, person, environment, and evidence. Include `不做什么` whenever work is deliberately moved to a sibling or later phase; after real IDs exist, name the related manual or deferred Issue there.

Use this structure for unattended work:

```markdown
## 一句话目标
<用一句人话说明完成后有什么变化>

## 做什么
- <必要范围，通常 1-3 条>

## 不做什么
- <明确排除发布、真机或其他阶段内容>

## 验收标准
- <3-5 条可判断的结果>

## 自动验证
- `<可直接运行的命令>`

## 依赖
- 无，或 `Issue #<id>`
```

For manual work, replace `自动验证` with:

```markdown
## 人工验收
- <设备、账号或环境>
- <要执行的动作和要保留的证据>
- <需要回看的实现 Issue Run 日志和自动验证结果>
```

Always keep the `依赖` section. Write `无` when there is no dependency; otherwise use exact `Issue #<id>` references. The body references must exactly match the structured `--depends-on` IDs.

The one-sentence goal and acceptance criteria describe different things: the goal helps the user understand the outcome; acceptance tells the executor how to prove it. Do not turn the one-sentence goal into a dense technical summary, and do not fill optional sections with meaningless text merely to satisfy the template.

## Batch Creation and Dependencies

For a multi-Issue plan:

1. Draft the complete numbered plan with `一句话目标`, execution lane, and dependency outline.
2. Once creation is authorized, create all Issues as `triage` first and capture their real IDs. Do not use `--run` while the dependency graph is incomplete.
3. Update cross-references after IDs exist. An implementation Issue that defers real acceptance must name the manual Issue in `不做什么`; the manual Issue must name the implementation Issue and require review of its Run evidence.
4. Add structured dependencies to never-started Issues with `issue update --depends-on`. In the body, write dependencies as exact `Issue #<id>` references and update the body plus structured dependency in the same command so they agree.
5. Verify that dependencies stay inside the same Project, contain no self-reference or cycle, represent success prerequisites only, and never make a nighttime Issue wait on a manual Issue that remains in `triage`.
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

## Compact Creation Summary

After planning or creating a batch, lead with the result and give the user a compact table. Do not make the user read every Issue body.

If manual acceptance remains, put this before the table: `待人工验收 N 项，完成前不算整体验收通过。`

| Issue | 一句话目标 | 类型 | 依赖 | 今晚运行 |
| --- | --- | --- | --- | --- |
| `#<id>` | `<具体结果>` | 自动 / 人工（简短原因） | `无` / `#<id>` | 是 / 否 |

Then state only:

- total Issue count and unattended count;
- which unexpected Issues were held for a person and why;
- the longest dependency chain;
- downstream Issues held by a failed or cancelled prerequisite;
- any remaining risk that could stop the night run.

Use at most one sentence to explain the split boundaries. If the table becomes hard to scan, show the current phase row by row and group later phases without hiding their goals or manual-acceptance requirements. Use short sentences. Do not restate the full PRD, narrate every CLI call, or add architectural commentary unless the user asks for it.

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
