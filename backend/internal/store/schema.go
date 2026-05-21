package store

const projectsSchema = `
create table if not exists projects (
  id text primary key,
  name text not null,
  cwd text not null unique,
  auto_run integer not null default 0,
  model text not null default '',
  approval_policy text not null default 'never',
  sandbox text not null default 'workspace-write',
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
  codex_thread_id text not null default '',
  codex_turn_id text not null default '',
  attempt_count integer not null default 0,
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
