package store

const projectsSchema = `
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
  updated_at text not null
);`

const issueTemplatesSchema = `
create table if not exists issue_templates (
  id text primary key,
  name text not null,
  content text not null,
  is_default integer not null default 0,
  created_at text not null,
  updated_at text not null
);`

const issuesSchema = `
create table if not exists issues (
  id integer primary key autoincrement,
  project_id text not null,
  title text not null,
  description text not null default '',
  status text not null,
  priority integer not null default 0,
  template_id text not null default '',
  prompt_template text not null default '',
  source_session_id text not null default '',
  source_turn_id text not null default '',
  source_excerpt text not null default '',
  codex_thread_id text not null default '',
  codex_turn_id text not null default '',
  attempt_count integer not null default 0,
  auto_retry_next_at text not null default '',
  auto_retry_reason text not null default '',
  error text not null default '',
  created_at text not null,
  updated_at text not null,
  foreign key(project_id) references projects(id) on delete cascade
);`

const issueEventsSchema = `
create table if not exists issue_events (
  id integer primary key autoincrement,
  issue_id integer not null,
  type text not null,
  payload text not null default '',
  created_at text not null,
  foreign key(issue_id) references issues(id) on delete cascade
);`

const issueRunsSchema = `
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
  foreign key(issue_id) references issues(id) on delete cascade
);`

const sessionTurnReferencesSchema = `
create table if not exists session_turn_references (
  id integer primary key autoincrement,
  provider text not null default 'codex',
  provider_session_id text not null,
  provider_turn_id text not null,
  references_json text not null default '[]',
  created_at text not null
);`

const sessionCommandEventsSchema = `
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
);`

const cronTasksSchema = `
create table if not exists cron_tasks (
  id integer primary key autoincrement,
  name text not null,
  project_id text not null default '',
  action text not null,
  mode text not null,
  time_of_day text not null default '',
  next_run_at text not null default '',
  last_run_at text not null default '',
  last_status text not null default '',
  last_result text not null default '',
  status text not null,
  run_count integer not null default 0,
  error text not null default '',
  created_at text not null,
  updated_at text not null
);`

const uploadsSchema = `
create table if not exists uploads (
  id text primary key,
  original_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  storage_path text not null,
  created_at text not null
);`

const appPreferencesSchema = `
create table if not exists app_preferences (
  key text primary key,
  value text not null,
  updated_at text not null
);`

const projectHoldsSchema = `
create table if not exists project_holds (
  project_id text primary key,
  reason text not null,
  message text not null,
  hold_since text not null,
  next_check_at text not null default '',
  last_check_at text not null default '',
  last_check_error text not null default '',
  updated_at text not null,
  foreign key(project_id) references projects(id) on delete cascade
);`
