import type { SqlMigration } from "../migrations.ts";

// P08.02 is additive and intentionally has no writer until the P08 migration gate opens.
export const automationModelMigration: SqlMigration = {
  id: "045_automation_model",
  sql: `
create table if not exists automation_definitions (
  id text primary key,
  scope_kind text not null check (scope_kind in ('project', 'control_plane')),
  scope_id text not null,
  name text not null,
  workflow_ref text not null,
  permission_policy_ref text not null,
  mode text not null check (mode in ('observe', 'propose', 'execute_allowed')),
  status text not null check (status in ('draft', 'active', 'paused', 'archived')),
  idempotency_namespace text not null,
  active_trigger_version integer not null check (active_trigger_version > 0),
  next_run_at text,
  revision integer not null default 0 check (revision >= 0),
  created_at text not null,
  updated_at text not null
);
create table if not exists automation_trigger_configs (
  automation_id text not null references automation_definitions(id) on delete restrict,
  version integer not null check (version > 0),
  trigger_type text not null check (trigger_type in ('cron', 'manual', 'webhook', 'continuous')),
  config_json text not null,
  created_by text not null,
  created_at text not null,
  primary key (automation_id, version)
);
create table if not exists automation_runs (
  run_id text primary key,
  automation_id text not null references automation_definitions(id) on delete restrict,
  trigger_version integer not null,
  idempotency_key text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  requested_at text not null,
  completed_at text,
  summary_json text not null default '{}',
  created_at text not null,
  unique (automation_id, idempotency_key)
);
create table if not exists automation_events (
  event_id text primary key,
  automation_id text not null references automation_definitions(id) on delete restrict,
  event_type text not null,
  expected_revision integer not null check (expected_revision >= 0),
  before_revision integer not null check (before_revision >= 0),
  after_revision integer not null check (after_revision >= 0),
  actor_id text not null,
  actor_kind text not null,
  correlation_id text not null,
  gate_authority text not null check (gate_authority in ('deterministic_policy', 'human_approval')),
  gate_decision text not null check (gate_decision in ('allow', 'deny', 'ask')),
  gate_policy_ref text not null,
  reason text not null,
  payload_json text not null default '{}',
  occurred_at text not null
);
create index if not exists idx_automation_definitions_scope_status_next
  on automation_definitions(scope_kind, scope_id, status, next_run_at, id);
create index if not exists idx_automation_trigger_configs_lookup
  on automation_trigger_configs(automation_id, version desc);
create index if not exists idx_automation_runs_history
  on automation_runs(automation_id, created_at desc, run_id desc);
create index if not exists idx_automation_events_history
  on automation_events(automation_id, occurred_at desc, event_id desc);
`
};
