import type { SqlMigration } from "../migrations.ts";

export const safeGoImportTablesMigration: SqlMigration = {
  id: "004_safe_go_import_tables",
  sql: `
create table if not exists agent_profiles (
  id text primary key,
  name text not null,
  provider text not null default 'codex',
  model text not null default '',
  reasoning_effort text not null default '',
  approval_policy text not null default '',
  sandbox text not null default '',
  default_instructions text not null default '',
  skill_intents_json text not null default '[]',
  plugin_intents_json text not null default '[]',
  created_at text not null,
  updated_at text not null
);

create table if not exists issue_templates (
  id text primary key,
  name text not null,
  content text not null,
  is_default integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists app_preferences (
  key text primary key,
  value text not null default '',
  updated_at text not null
);

create table if not exists session_turn_references (
  id integer primary key autoincrement,
  provider text not null default 'codex',
  provider_session_id text not null,
  provider_turn_id text not null,
  references_json text not null default '[]',
  created_at text not null
);

create table if not exists session_command_events (
  id integer primary key autoincrement,
  provider text not null default 'codex',
  provider_session_id text not null,
  command_name text not null,
  command_args_json text not null default '{}',
  prompt_summary text not null default '',
  references_summary text not null default '',
  result_summary text not null default '',
  target_issue_id integer not null default 0,
  created_issue_id integer not null default 0,
  enqueued_issue_id integer not null default 0,
  error text not null default '',
  created_at text not null
);

create table if not exists cron_tasks (
  id integer primary key autoincrement,
  name text not null,
  project_id text not null default '',
  action text not null,
  mode text not null,
  time_of_day text not null default '',
  next_run_at text not null default '',
  last_run_at text not null default '',
  status text not null,
  run_count integer not null default 0,
  error text not null default '',
  created_at text not null,
  updated_at text not null,
  last_status text not null default '',
  last_result text not null default ''
);

create table if not exists nightly_batches (
  id integer primary key autoincrement,
  project_id text not null,
  policy text not null,
  promotion_mode text not null,
  status text not null,
  current_issue_id integer not null default 0,
  pause_reason text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists nightly_batch_items (
  batch_id integer not null,
  issue_id integer not null,
  position integer not null,
  status text not null,
  updated_at text not null,
  primary key(batch_id, issue_id)
);

create table if not exists project_holds (
  project_id text primary key,
  reason text not null,
  message text not null,
  hold_since text not null,
  next_check_at text not null default '',
  last_check_at text not null default '',
  last_check_error text not null default '',
  updated_at text not null
);

create table if not exists uploads (
  id text primary key,
  original_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  storage_path text not null,
  created_at text not null
);

create index if not exists idx_agent_profiles_provider
  on agent_profiles(provider);

create index if not exists idx_cron_tasks_status_next_run
  on cron_tasks(status, next_run_at);

create index if not exists idx_nightly_batch_items_issue
  on nightly_batch_items(issue_id);
`
};
