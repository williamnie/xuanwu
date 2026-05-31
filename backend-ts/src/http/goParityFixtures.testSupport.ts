import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openDatabase } from "../db/database.ts";

export type FixtureDatabase = Awaited<ReturnType<typeof openDatabase>>;

export async function openGoDatabase(dbPath: string, stateDir: string): Promise<FixtureDatabase> {
  const previous = Bun.env.CODEX_RUNNER_BUN_ALLOW_GO_STABLE_DB;
  Bun.env.CODEX_RUNNER_BUN_ALLOW_GO_STABLE_DB = "1";
  try {
    return await openDatabase({ dbPath, stateDir });
  } finally {
    if (previous === undefined) delete Bun.env.CODEX_RUNNER_BUN_ALLOW_GO_STABLE_DB;
    else Bun.env.CODEX_RUNNER_BUN_ALLOW_GO_STABLE_DB = previous;
  }
}

export async function writeFrontendFixture(webDir: string): Promise<void> {
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<main>runner ui</main>");
  await writeFile(join(webDir, "assets", "app.js"), "console.log('ok')");
}

export async function createGoParityFixtureDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    for (const statement of [...schemaStatements(), ...fixtureStatements()]) db.run(statement);
  } finally {
    db.close();
  }
}

function schemaStatements(): string[] {
  return [
    projectsSchema(), projectHoldsSchema(), agentProfilesSchema(), issueTemplatesSchema(), issuesSchema(),
    issueEventsSchema(), issueRunsSchema(), cronTasksSchema(), nightlyBatchesSchema(), nightlyBatchItemsSchema(),
    appPreferencesSchema()
  ];
}

function fixtureStatements(): string[] {
  return [
    `insert into projects values ('demo', 'Demo', '/tmp/demo', 1, 'codex-default', 'never',
      'danger-full-access', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 1, 'codex', '{}', 'nightly')`,
    `insert into project_holds values ('demo', 'blocked', 'waiting', '2026-01-01T00:01:00Z',
      '', '', '', '2026-01-01T00:01:01Z')`,
    `insert into agent_profiles values ('nightly', 'Nightly', 'codex', 'codex-default', 'high',
      'never', 'workspace-write', 'Be careful', '["test"]', '["github"]',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    `insert into issue_templates values ('default', '默认模板', '{{issue.description}}', 1,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    `insert into issues values (1, 'demo', 'One', 'first', 'triage', 2, 'thread-1', 'turn-1',
      1, '', '2026-01-01T00:02:00Z', '2026-01-01T00:02:01Z', 'default', 'prompt', '', '',
      'source-session', 'source-turn', 'excerpt', 'nightly', '{"steps":[]}')`,
    `insert into issue_events values (1, 1, 'issue.comment', '{"body":"ok"}', '2026-01-01T00:03:00Z')`,
    `insert into issue_runs values ('run-1', 1, 1, 'done', 'thread-1', 'turn-1',
      '2026-01-01T00:04:00Z', '2026-01-01T00:04:01Z', 'explicit_status_update', '',
      'codex', 'thread-1', 'turn-1', 'nightly', 'issue_execution', 'default')`,
    `insert into cron_tasks values (1, 'Daily triage', 'demo', 'triage_to_todo', 'daily', '09:00',
      '2026-01-02T01:00:00Z', '2026-01-01T01:00:00Z', 'active', 3, '',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'success', 'promoted')`,
    `insert into nightly_batches values (1, 'demo', 'fail_stop', 'auto', 'active', 1, '',
      '2026-01-01T00:05:00Z', '2026-01-01T00:05:01Z')`,
    `insert into nightly_batch_items values (1, 1, 1, 'current', '2026-01-01T00:05:02Z')`,
    `insert into app_preferences values ('sessions.last_project_id', 'demo', '2026-01-01T00:06:00Z')`
  ];
}

function projectsSchema(): string {
  return `create table projects (
    id text primary key, name text not null, cwd text not null unique, auto_run integer not null default 0,
    model text not null default '', approval_policy text not null default 'never',
    sandbox text not null default 'workspace-write', created_at text not null, updated_at text not null,
    sort_order integer not null default 0, provider text not null default 'codex',
    provider_config_json text not null default '{}', default_agent_profile_id text not null default ''
  )`;
}

function projectHoldsSchema(): string {
  return `create table project_holds (
    project_id text primary key, reason text not null, message text not null, hold_since text not null,
    next_check_at text not null default '', last_check_at text not null default '',
    last_check_error text not null default '', updated_at text not null
  )`;
}

function agentProfilesSchema(): string {
  return `create table agent_profiles (
    id text primary key, name text not null, provider text not null default 'codex', model text not null default '',
    reasoning_effort text not null default '', approval_policy text not null default '', sandbox text not null default '',
    default_instructions text not null default '', skill_intents_json text not null default '[]',
    plugin_intents_json text not null default '[]', created_at text not null, updated_at text not null
  )`;
}

function issueTemplatesSchema(): string {
  return `create table issue_templates (
    id text primary key, name text not null, content text not null, is_default integer not null default 0,
    created_at text not null, updated_at text not null
  )`;
}

function issuesSchema(): string {
  return `create table issues (
    id integer primary key autoincrement, project_id text not null, title text not null,
    description text not null default '', status text not null, priority integer not null default 0,
    codex_thread_id text not null default '', codex_turn_id text not null default '',
    attempt_count integer not null default 0, error text not null default '', created_at text not null,
    updated_at text not null, template_id text not null default '', prompt_template text not null default '',
    auto_retry_next_at text not null default '', auto_retry_reason text not null default '',
    source_session_id text not null default '', source_turn_id text not null default '',
    source_excerpt text not null default '', agent_profile_id text not null default '',
    workflow_snapshot_json text not null default ''
  )`;
}

function issueEventsSchema(): string {
  return `create table issue_events (
    id integer primary key autoincrement, issue_id integer not null, type text not null,
    payload text not null default '', created_at text not null
  )`;
}

function issueRunsSchema(): string {
  return `create table issue_runs (
    id text primary key, issue_id integer not null, attempt integer not null, status text not null,
    codex_thread_id text not null default '', codex_turn_id text not null default '', started_at text not null,
    ended_at text not null default '', exit_reason text not null default '', error text not null default '',
    provider text not null default 'codex', provider_session_id text not null default '',
    provider_turn_id text not null default '', agent_profile_id text not null default '',
    capability_summary text not null default '', selection_reason text not null default ''
  )`;
}

function cronTasksSchema(): string {
  return `create table cron_tasks (
    id integer primary key autoincrement, name text not null, project_id text not null default '', action text not null,
    mode text not null, time_of_day text not null default '', next_run_at text not null default '',
    last_run_at text not null default '', status text not null, run_count integer not null default 0,
    error text not null default '', created_at text not null, updated_at text not null,
    last_status text not null default '', last_result text not null default ''
  )`;
}

function nightlyBatchesSchema(): string {
  return `create table nightly_batches (
    id integer primary key autoincrement, project_id text not null, policy text not null,
    promotion_mode text not null, status text not null, current_issue_id integer not null default 0,
    pause_reason text not null default '', created_at text not null, updated_at text not null
  )`;
}

function nightlyBatchItemsSchema(): string {
  return `create table nightly_batch_items (
    batch_id integer not null, issue_id integer not null, position integer not null,
    status text not null, updated_at text not null, primary key(batch_id, issue_id)
  )`;
}

function appPreferencesSchema(): string {
  return "create table app_preferences (key text primary key, value text not null default '', updated_at text not null)";
}

export function goAgentProfile() {
  return {
    id: "nightly", name: "Nightly", provider: "codex", model: "codex-default", reasoning_effort: "high",
    approval_policy: "never", sandbox: "workspace-write", default_instructions: "Be careful",
    skill_intents: "[\"test\"]", plugin_intents: "[\"github\"]", created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z"
  };
}

export function goProject() {
  return {
    id: "demo", name: "Demo", cwd: "/tmp/demo", provider: "codex", provider_config_json: "{}", auto_run: 1,
    model: "codex-default", approval_policy: "never", sandbox: "danger-full-access", default_agent_profile_id: "nightly",
    default_agent_profile: goAgentProfile(), sort_order: 1, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z", hold: goProjectHold(), loop_status: "stopped",
    provider_capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"]
  };
}

function goProjectHold() {
  return {
    reason: "blocked", message: "waiting", hold_since: "2026-01-01T00:01:00Z",
    next_check_at: "", last_check_at: "", last_check_error: ""
  };
}

export function goIssueTemplate() {
  return {
    id: "default", name: "默认模板", content: "{{issue.description}}", is_default: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  };
}

export function goIssueEvent() {
  return { id: 1, issue_id: 1, type: "issue.comment", payload: '{"body":"ok"}', created_at: "2026-01-01T00:03:00Z" };
}

export function goIssueRun() {
  return {
    id: "run-1", issue_id: 1, attempt: 1, status: "done", provider: "codex", provider_session_id: "thread-1",
    provider_turn_id: "turn-1", codex_thread_id: "thread-1", codex_turn_id: "turn-1",
    started_at: "2026-01-01T00:04:00Z", ended_at: "2026-01-01T00:04:01Z", exit_reason: "explicit_status_update",
    error: "", agent_profile_id: "nightly", capability_summary: "issue_execution", selection_reason: "default"
  };
}

export function goIssue() {
  return {
    id: 1, project_id: "demo", title: "One", description: "first", status: "triage", priority: 2,
    template_id: "default", prompt_template: "prompt", agent_profile_id: "nightly", source_session_id: "source-session",
    source_turn_id: "source-turn", source_excerpt: "excerpt", codex_thread_id: "thread-1", codex_turn_id: "turn-1",
    attempt_count: 1, comment_count: 1, workflow_snapshot_json: '{"steps":[]}', auto_retry_next_at: "",
    auto_retry_reason: "", error: "", created_at: "2026-01-01T00:02:00Z",
    updated_at: "2026-01-01T00:02:01Z"
  };
}

export function goIssueWithLatestRun() {
  return { ...goIssue(), latest_run: goIssueRun() };
}

export function goCronTask() {
  return {
    id: 1, name: "Daily triage", project_id: "demo", action: "triage_to_todo", mode: "daily", time_of_day: "09:00",
    next_run_at: "2026-01-02T01:00:00Z", last_run_at: "2026-01-01T01:00:00Z", last_status: "success",
    last_result: "promoted", status: "active", run_count: 3, error: "", last_error: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  };
}

export function goNightlyBatch() {
  return {
    id: 1, project_id: "demo", policy: "fail_stop", promotion_mode: "auto", status: "active", current_issue_id: 1,
    pause_reason: "", created_at: "2026-01-01T00:05:00Z", updated_at: "2026-01-01T00:05:01Z",
    items: [{ batch_id: 1, issue_id: 1, position: 1, status: "current", updated_at: "2026-01-01T00:05:02Z", issue: goIssue() }]
  };
}
