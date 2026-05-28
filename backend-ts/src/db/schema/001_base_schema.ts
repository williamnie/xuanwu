import type { SqlMigration } from "../migrations.ts";

export const baseSchemaMigration: SqlMigration = {
  id: "001_base_schema",
  sql: `
create table if not exists projects (
  id text primary key,
  name text not null,
  cwd text not null unique,
  provider text not null default 'codex',
  provider_config_json text not null default '{}',
  auto_run integer not null default 0,
  model text not null default '',
  approval_policy text not null default 'never',
  sandbox text not null default 'workspace-write',
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null,
  default_agent_profile_id text not null default ''
);

create table if not exists issues (
  id integer primary key autoincrement,
  project_id text not null,
  title text not null,
  description text not null default '',
  status text not null,
  priority integer not null default 0,
  template_id text not null default '',
  prompt_template text not null default '',
  agent_profile_id text not null default '',
  source_session_id text not null default '',
  source_turn_id text not null default '',
  source_excerpt text not null default '',
  codex_thread_id text not null default '',
  codex_turn_id text not null default '',
  attempt_count integer not null default 0,
  workflow_snapshot_json text not null default '',
  auto_retry_next_at text not null default '',
  auto_retry_reason text not null default '',
  error text not null default '',
  created_at text not null,
  updated_at text not null,
  foreign key(project_id) references projects(id) on delete cascade
);

create table if not exists issue_events (
  id integer primary key autoincrement,
  issue_id integer not null,
  type text not null,
  payload text not null default '',
  created_at text not null,
  foreign key(issue_id) references issues(id) on delete cascade
);

create table if not exists issue_runs (
  id text primary key,
  issue_id integer not null,
  attempt integer not null,
  status text not null,
  provider text not null default 'codex',
  provider_session_id text not null default '',
  provider_turn_id text not null default '',
  codex_thread_id text not null default '',
  codex_turn_id text not null default '',
  started_at text not null,
  ended_at text not null default '',
  exit_reason text not null default '',
  error text not null default '',
  agent_profile_id text not null default '',
  capability_summary text not null default '',
  selection_reason text not null default '',
  foreign key(issue_id) references issues(id) on delete cascade
);

create index if not exists idx_issues_queue
  on issues(project_id, status, priority, created_at);

create index if not exists idx_issue_runs_issue
  on issue_runs(issue_id, attempt);
`
};
