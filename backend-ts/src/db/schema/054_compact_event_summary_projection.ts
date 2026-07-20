import type { SqlMigration } from "../migrations.ts";

export const compactEventSummaryProjectionMigration: SqlMigration = {
  id: "054_compact_event_summary_projection",
  sql: `
create table if not exists event_summary_projection_types (
  event_type_ref integer primary key,
  event_type text not null unique
);

create table if not exists event_summary_projection_runs (
  run_ref integer primary key,
  run_id text not null unique
);

create table if not exists event_summary_projection_projects (
  project_ref integer primary key,
  project_id text not null unique
);

create table if not exists event_summary_projection_payloads (
  payload_ref integer primary key,
  payload_key blob not null unique,
  summary_payload blob not null,
  payload_codec integer not null,
  check(payload_codec in (0, 1)),
  check(length(payload_key)=16)
);

create table if not exists event_summary_projection_compat_modes (
  source_event_id integer primary key,
  payload_mode text not null,
  reason text not null,
  check(payload_mode='stored_reference')
);

create table if not exists event_summary_projection_compact (
  source_event_id integer primary key,
  issue_id integer not null,
  project_ref integer not null,
  run_ref integer not null,
  event_type_ref integer not null,
  payload_ref integer not null,
  source_payload_bytes integer not null,
  source_sha256 blob not null,
  foreign key(issue_id) references issues(id) on delete cascade,
  foreign key(project_ref) references event_summary_projection_projects(project_ref),
  foreign key(run_ref) references event_summary_projection_runs(run_ref),
  foreign key(event_type_ref) references event_summary_projection_types(event_type_ref),
  foreign key(payload_ref) references event_summary_projection_payloads(payload_ref),
  check(length(source_sha256)=32)
);

create index if not exists idx_event_summary_projection_compact_issue
  on event_summary_projection_compact(issue_id, source_event_id);

create index if not exists idx_event_summary_projection_compact_project
  on event_summary_projection_compact(project_ref, source_event_id);

create table if not exists event_summary_projection_switch (
  projection_id text primary key,
  read_version text not null,
  observation_started_at text not null default '',
  observation_expires_at text not null default '',
  cutover_at text not null default '',
  updated_at text not null,
  revision integer not null default 0,
  check(read_version in ('v1', 'v2'))
);

insert or ignore into event_projection_watermarks (
  projection_id, source, projector_version, last_event_id, projected_row_count, updated_at
) values (
  'issue_events_summary_v2', 'issue_events', 'xuanwu.event-summary-projector.v2', 0, 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

insert or ignore into event_summary_projection_switch (
  projection_id, read_version, observation_started_at, observation_expires_at,
  cutover_at, updated_at, revision
) values (
  'issue_events_summary', 'v1', '', '', '',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
);
`
};
