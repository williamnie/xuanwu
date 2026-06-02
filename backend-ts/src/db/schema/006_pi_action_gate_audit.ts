import type { SqlMigration } from "../migrations.ts";

export const piActionGateAuditMigration: SqlMigration = {
  id: "006_pi_action_gate_audit",
  sql: `
alter table pi_actions add column source text not null default '';
alter table pi_actions add column gate_decision text not null default '';
alter table pi_actions add column gate_reason text not null default '';
alter table pi_actions add column requested_changes text not null default '';
alter table pi_actions add column snoozed_until text not null default '';
alter table pi_actions add column decided_by text not null default '';
alter table pi_actions add column approved_by text not null default '';
alter table pi_actions add column delegation_id text not null default '';
alter table pi_actions add column heartbeat_id text not null default '';

create table if not exists pi_action_events (
  id integer primary key autoincrement,
  action_id text not null,
  project_id text not null default '',
  issue_id integer not null default 0,
  conversation_id text not null default '',
  event_type text not null,
  actor text not null default '',
  decision text not null default '',
  reason text not null default '',
  payload_json text not null default '{}',
  result_json text not null default '{}',
  error text not null default '',
  delegation_id text not null default '',
  heartbeat_id text not null default '',
  created_at text not null
);

create index if not exists idx_pi_action_events_action
  on pi_action_events(action_id, id);

create index if not exists idx_pi_action_events_project
  on pi_action_events(project_id, created_at, id);
`
};
