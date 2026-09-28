import type { SqlMigration } from "../migrations.ts";

export const piMemoryReflectionsMigration: SqlMigration = {
  id: "088_pi_memory_reflections",
  sql: `
create table pi_memory_reflection_settings (
  project_id text primary key references projects(id) on delete cascade,
  enabled integer not null default 0 check (enabled in (0, 1)),
  after_event_id integer not null,
  updated_at text not null
);
create table pi_memory_reflection_cursor (
  id integer primary key check (id=1), event_id integer not null
);
insert into pi_memory_reflection_cursor values (1, (select coalesce(max(id), 0) from issue_events));
create table pi_memory_reflections (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  issue_id integer not null references issues(id) on delete cascade,
  run_id text not null,
  fingerprint text not null,
  summary_json text not null,
  status text not null check (status in ('pending', 'running', 'completed', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 2),
  lease_token text not null default '',
  lease_until integer not null default 0,
  reason text not null default '',
  memory_id text not null default '',
  created_at text not null,
  updated_at text not null,
  unique(project_id, issue_id, run_id, fingerprint)
);
create index pi_memory_reflections_due on pi_memory_reflections(status, lease_until, created_at);
`
};
