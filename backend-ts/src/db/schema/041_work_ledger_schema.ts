import type { SqlMigration } from "../migrations.ts";

export const workLedgerSchemaMigration: SqlMigration = {
  id: "041_work_ledger_schema",
  sql: `
create table if not exists works (
  id text primary key,
  project_id text not null,
  type text not null,
  title text not null,
  goal text not null,
  status text not null,
  acceptance_json text not null,
  provenance_json text not null,
  workflow_ref text not null,
  revision integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(id, project_id),
  foreign key(project_id) references projects(id) on delete cascade,
  check(id glob 'xw:work:*:*'),
  check(type in ('objective', 'engineering_task')),
  check(length(trim(title)) > 0),
  check(length(trim(goal)) > 0),
  check(status in ('triage', 'todo', 'in_progress', 'pending_verification', 'done', 'failed', 'cancelled')),
  check(json_valid(acceptance_json)),
  check(json_valid(provenance_json)),
  check(length(trim(workflow_ref)) > 0),
  check(revision >= 0),
  check(length(trim(created_at)) > 0),
  check(length(trim(updated_at)) > 0)
);

create index if not exists idx_works_project_updated
  on works(project_id, updated_at desc, id);

create index if not exists idx_works_project_status_updated
  on works(project_id, status, updated_at desc, id);

create table if not exists work_relations (
  relation_id text primary key,
  project_id text not null,
  kind text not null,
  source_work_id text not null,
  target_work_id text not null,
  actor_json text not null,
  reason text not null,
  correlation_id text not null,
  audit_event_ref text not null,
  occurred_at text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique(kind, source_work_id, target_work_id),
  foreign key(project_id) references projects(id) on delete cascade,
  foreign key(source_work_id, project_id) references works(id, project_id) on delete cascade,
  foreign key(target_work_id, project_id) references works(id, project_id) on delete cascade,
  check(length(trim(relation_id)) > 0),
  check(kind in ('parent_child', 'depends_on')),
  check(source_work_id <> target_work_id),
  check(json_valid(actor_json)),
  check(length(trim(reason)) > 0),
  check(length(trim(correlation_id)) > 0),
  check(length(trim(audit_event_ref)) > 0),
  check(length(trim(occurred_at)) > 0),
  check(length(trim(created_at)) > 0),
  check(length(trim(updated_at)) > 0)
);

create unique index if not exists ux_work_relations_parent_child
  on work_relations(target_work_id) where kind = 'parent_child';

create index if not exists idx_work_relations_source
  on work_relations(project_id, source_work_id, kind, target_work_id);

create index if not exists idx_work_relations_target
  on work_relations(project_id, target_work_id, kind, source_work_id);

create table if not exists work_events (
  event_id text primary key,
  work_id text not null,
  project_id text not null,
  event_type text not null,
  actor_json text not null,
  reason text not null,
  correlation_id text not null,
  gate_authority text not null,
  gate_decision text not null,
  gate_policy_ref text not null,
  expected_revision integer not null,
  before_revision integer not null,
  after_revision integer not null,
  outcome text not null,
  payload_json text not null default '{}',
  occurred_at text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key(project_id) references projects(id) on delete cascade,
  foreign key(work_id, project_id) references works(id, project_id) on delete cascade,
  check(length(trim(event_id)) > 0),
  check(length(trim(event_type)) > 0),
  check(json_valid(actor_json)),
  check(length(trim(reason)) > 0),
  check(length(trim(correlation_id)) > 0),
  check(gate_authority in ('deterministic_policy', 'human_approval')),
  check(gate_decision in ('allow', 'deny', 'ask')),
  check(length(trim(gate_policy_ref)) > 0),
  check(expected_revision >= 0),
  check(before_revision >= 0),
  check(after_revision >= 0),
  check(outcome in ('applied', 'rejected')),
  check(json_valid(payload_json)),
  check(length(trim(occurred_at)) > 0),
  check(length(trim(created_at)) > 0)
);

create index if not exists idx_work_events_work_occurred
  on work_events(work_id, occurred_at, event_id);

create index if not exists idx_work_events_project_occurred
  on work_events(project_id, occurred_at, event_id);

create index if not exists idx_work_events_correlation
  on work_events(correlation_id, event_id);
`
};
