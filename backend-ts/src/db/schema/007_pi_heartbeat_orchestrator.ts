import type { SqlMigration } from "../migrations.ts";

export const piHeartbeatOrchestratorMigration: SqlMigration = {
  id: "007_pi_heartbeat_orchestrator",
  sql: `
create table if not exists pi_heartbeat_runs (
  id text primary key,
  kind text not null,
  project_id text not null default '',
  delegation_id text not null default '',
  status text not null,
  trigger text not null default '',
  started_at text not null,
  finished_at text not null default '',
  next_tick_at text not null default '',
  error text not null default '',
  signals_json text not null default '{}',
  policy_json text not null default '{}',
  action_plan_json text not null default '[]',
  result_json text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists pi_heartbeat_events (
  id integer primary key autoincrement,
  heartbeat_id text not null,
  project_id text not null default '',
  delegation_id text not null default '',
  event_type text not null,
  message text not null default '',
  payload_json text not null default '{}',
  error text not null default '',
  created_at text not null
);

create table if not exists pi_heartbeat_controls (
  scope_type text not null,
  scope_id text not null default '',
  paused integer not null default 0,
  reason text not null default '',
  updated_at text not null,
  primary key(scope_type, scope_id)
);

create table if not exists pi_delegations (
  id text primary key,
  project_id text not null default '',
  title text not null default '',
  status text not null,
  intent_json text not null default '{}',
  authorization_json text not null default '{}',
  next_heartbeat_at text not null default '',
  last_heartbeat_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_heartbeat_runs_scope
  on pi_heartbeat_runs(kind, project_id, delegation_id, started_at);

create index if not exists idx_pi_heartbeat_events_run
  on pi_heartbeat_events(heartbeat_id, id);

create index if not exists idx_pi_delegations_active
  on pi_delegations(status, next_heartbeat_at, project_id);
`
};
