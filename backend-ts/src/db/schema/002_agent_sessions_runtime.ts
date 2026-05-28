import type { SqlMigration } from "../migrations.ts";

export const agentSessionsRuntimeMigration: SqlMigration = {
  id: "002_agent_sessions_runtime",
  sql: `
create table if not exists agent_sessions (
  session_key text primary key,
  provider text not null,
  provider_session_id text not null,
  agent_role text not null default '',
  project_id text not null default '',
  issue_id integer not null default 0,
  title text not null default '',
  preview text not null default '',
  status text not null default '',
  raw_ref text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_agent_sessions_provider
  on agent_sessions(provider, provider_session_id);

create index if not exists idx_agent_sessions_project
  on agent_sessions(project_id, updated_at);

alter table issue_runs add column runtime_metadata_json text not null default '{}';
`
};
