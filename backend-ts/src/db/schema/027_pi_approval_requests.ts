import type { SqlMigration } from "../migrations.ts";

export const piApprovalRequestsMigration: SqlMigration = {
  id: "027_pi_approval_requests",
  sql: `
create table if not exists pi_approval_requests (
  approval_id text primary key,
  project_id text not null default '',
  issue_id integer not null default 0,
  provider text not null default '',
  thread_id text not null default '',
  turn_id text not null default '',
  request_type text not null default '',
  request_summary text not null default '',
  risk text not null default 'medium',
  status text not null default 'pending',
  approval_source text not null default '',
  provider_approval_id text not null default '',
  delivery_channel text not null default '',
  delivered_at text not null default '',
  resolved_decision text not null default '',
  resolved_scope text not null default '',
  resolved_at text not null default '',
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
`
};
