import type { SqlMigration } from "../migrations.ts";

export const eventSummaryProjectionMigration: SqlMigration = {
  id: "040_event_summary_projection",
  sql: `
create table if not exists event_summary_projection (
  source text not null,
  source_event_id integer not null,
  issue_id integer not null,
  project_id text not null,
  run_id text not null default '',
  event_type text not null,
  raw_method text not null default '',
  policy_id text not null,
  retention_tier text not null,
  summary text not null default '',
  summary_payload text not null default '',
  source_payload_bytes integer not null default 0,
  source_sha256 text not null,
  summary_sha256 text not null,
  event_created_at text not null,
  projected_at text not null,
  primary key(source, source_event_id),
  foreign key(issue_id) references issues(id) on delete cascade
);

create index if not exists idx_event_summary_projection_issue
  on event_summary_projection(issue_id, source_event_id);

create index if not exists idx_event_summary_projection_project
  on event_summary_projection(project_id, source_event_id);

create table if not exists event_projection_watermarks (
  projection_id text primary key,
  source text not null,
  projector_version text not null,
  last_event_id integer not null default 0,
  projected_row_count integer not null default 0,
  updated_at text not null
);

insert or ignore into event_projection_watermarks (
  projection_id, source, projector_version, last_event_id, projected_row_count, updated_at
) values (
  'issue_events_summary_v1', 'issue_events', 'xuanwu.event-summary-projector.v1', 0, 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
`
};
