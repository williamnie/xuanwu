import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piApprovalRequestsMigration: SqlMigration = {
  id: "027_pi_approval_requests",
  sql: `
create table if not exists pi_approval_requests (
  approval_id text primary key,
  project_id text not null default '',
  issue_id integer not null default 0,
  run_id text not null default '',
  provider text not null default '',
  session_id text not null default '',
  thread_id text not null default '',
  turn_id text not null default '',
  request_type text not null default '',
  summary text not null default '',
  request_summary text not null default '',
  risk text not null default 'medium',
  status text not null default 'pending',
  decision text not null default '',
  approval_source text not null default '',
  provider_approval_id text not null default '',
  delivery_state text not null default 'pending',
  delivery_channel text not null default '',
  delivered_at text not null default '',
  resolved_decision text not null default '',
  resolved_scope text not null default '',
  resolved_at text not null default '',
  resolver_status text not null default '',
  resolver_error text not null default '',
  resolver_retryable integer not null default 0,
  resolver_attempt_count integer not null default 0,
  resolver_last_attempt_at text not null default '',
  fast_decision text not null default '',
  fast_decision_reason text not null default '',
  fast_policy_rule text not null default '',
  fast_policy_latency_ms integer not null default 0,
  async_escalation_state text not null default '',
  raw_payload_json text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_approval_requests_issue
  on pi_approval_requests(issue_id, status, created_at desc);

create index if not exists idx_pi_approval_requests_project
  on pi_approval_requests(project_id, status, created_at desc);

create index if not exists idx_pi_approval_requests_session
  on pi_approval_requests(provider, thread_id, turn_id);
`,
  apply(sqlite) {
    sqlite.run(this.sql);
    addColumn(sqlite, "run_id", "text not null default ''");
    addColumn(sqlite, "session_id", "text not null default ''");
    addColumn(sqlite, "summary", "text not null default ''");
    addColumn(sqlite, "decision", "text not null default ''");
    addColumn(sqlite, "delivery_state", "text not null default 'pending'");
    addColumn(sqlite, "resolver_status", "text not null default ''");
    addColumn(sqlite, "resolver_error", "text not null default ''");
    addColumn(sqlite, "resolver_retryable", "integer not null default 0");
    addColumn(sqlite, "resolver_attempt_count", "integer not null default 0");
    addColumn(sqlite, "resolver_last_attempt_at", "text not null default ''");
    addColumn(sqlite, "fast_decision", "text not null default ''");
    addColumn(sqlite, "fast_decision_reason", "text not null default ''");
    addColumn(sqlite, "fast_policy_rule", "text not null default ''");
    addColumn(sqlite, "fast_policy_latency_ms", "integer not null default 0");
    addColumn(sqlite, "async_escalation_state", "text not null default ''");
    sqlite.run("update pi_approval_requests set session_id=thread_id where session_id=''");
    sqlite.run("update pi_approval_requests set summary=request_summary where summary=''");
    sqlite.run("update pi_approval_requests set decision=resolved_decision where decision=''");
    sqlite.run(`
create unique index if not exists ux_pi_approval_requests_provider_session_approval
  on pi_approval_requests(provider, session_id, approval_id);
`);
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_approval_requests add column ${name} ${definition}`);
}

function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_approval_requests)").all()
    .map((row) => row.name));
}
