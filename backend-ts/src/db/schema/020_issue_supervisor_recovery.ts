import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

const EVENT_TABLE_SQL = `
create table if not exists issue_supervisor_events (
  id integer primary key autoincrement,
  issue_id integer not null default 0,
  project_id text not null default '',
  run_id text not null default '',
  provider text not null default '',
  provider_session_id text not null default '',
  provider_turn_id text not null default '',
  event_type text not null,
  diagnosis_code text not null default '',
  provider_error_category text not null default '',
  retry_after_at text not null default '',
  decision text not null default '',
  confidence text not null default '',
  action_id text not null default '',
  action_type text not null default '',
  payload_json text not null default '{}',
  created_at text not null
);

create index if not exists idx_issue_supervisor_events_issue
  on issue_supervisor_events(issue_id, created_at, id);

create index if not exists idx_issue_supervisor_events_project
  on issue_supervisor_events(project_id, created_at, id);

create index if not exists idx_issue_supervisor_events_action
  on issue_supervisor_events(action_id, id);
`;

export const issueSupervisorRecoveryMigration: SqlMigration = {
  id: "020_issue_supervisor_recovery",
  sql: "",
  apply(sqlite) {
    sqlite.run(EVENT_TABLE_SQL);
    addPolicyColumn(sqlite, "allowed_supervisor_actions_json", `text not null default '${DEFAULT_SUPERVISOR_ACTIONS_JSON}'`);
    addPolicyColumn(sqlite, "supervisor_mode", "text not null default 'autonomous'");
    addPolicyColumn(sqlite, "supervisor_cooldown_seconds", "integer not null default 300");
    addPolicyColumn(sqlite, "supervisor_max_recoveries_per_issue", "integer not null default 2");
    addPolicyColumn(sqlite, "supervisor_max_recoveries_per_project_per_hour", "integer not null default 10");
    addPolicyColumn(sqlite, "supervisor_rate_limit_wait_policy", "text not null default 'respect_retry_after'");
    upgradeSupervisorDefaults(sqlite);
  }
};

const DEFAULT_SUPERVISOR_ACTIONS_JSON =
  '["session.resume_followup","issue.retry_after","issue.retry","issue.state_repair","needs_user.escalate"]';

function addPolicyColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (tableColumns(sqlite, "project_pi_policies").has(name)) return;
  sqlite.run(`alter table project_pi_policies add column ${name} ${definition}`);
}

function tableColumns(sqlite: SQLiteDatabase, table: string): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name));
}

function upgradeSupervisorDefaults(sqlite: SQLiteDatabase): void {
  sqlite.run(`update project_pi_policies
    set allowed_supervisor_actions_json=?,
      supervisor_mode='autonomous'
    where supervisor_mode in ('off', 'watchdog')
      or allowed_supervisor_actions_json in ('[]', '["session.resume_followup"]')`,
    [DEFAULT_SUPERVISOR_ACTIONS_JSON]);
}
