import type { SqlMigration } from "../migrations.ts";

// P08.03 keeps execution recovery data beside the immutable Automation definition.
// No legacy carrier is read or written by this migration.
export const automationSchedulerMigration: SqlMigration = {
  id: "046_automation_scheduler",
  sql: `
alter table automation_runs add column scheduled_for text;
alter table automation_runs add column next_attempt_at text;
alter table automation_runs add column attempt_count integer not null default 0;
alter table automation_runs add column max_attempts integer not null default 3;
alter table automation_runs add column lease_token text not null default '';
alter table automation_runs add column lease_expires_at text not null default '';
create table if not exists automation_run_events (
  event_id text primary key,
  automation_id text not null references automation_definitions(id) on delete restrict,
  run_id text not null references automation_runs(run_id) on delete restrict,
  event_type text not null,
  actor_id text not null,
  actor_kind text not null,
  correlation_id text not null,
  detail text not null default '',
  occurred_at text not null
);
create index if not exists idx_automation_runs_due_attempt
  on automation_runs(status, next_attempt_at, lease_expires_at, automation_id);
create index if not exists idx_automation_run_events_history
  on automation_run_events(run_id, occurred_at, event_id);
`
};
