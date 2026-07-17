import type { SqlMigration } from "../migrations.ts";

// P08.04 keeps the Automation run as the execution authority and records only
// durable links to the existing Issue-backed Work/Run/Evidence/Handoff stores.
export const automationExecutionLinksMigration: SqlMigration = {
  id: "049_automation_execution_links",
  sql: `
create table if not exists automation_execution_links (
  automation_run_id text primary key references automation_runs(run_id) on delete restrict,
  automation_id text not null references automation_definitions(id) on delete restrict,
  workflow_ref text not null,
  issue_id integer not null references issues(id) on delete restrict,
  work_id text not null,
  run_id text not null,
  created_at text not null,
  updated_at text not null,
  unique (automation_id, automation_run_id)
);
create index if not exists idx_automation_execution_links_work
  on automation_execution_links(work_id, run_id);
`
};
