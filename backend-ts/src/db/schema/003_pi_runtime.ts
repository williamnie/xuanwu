import type { SqlMigration } from "../migrations.ts";

export const piRuntimeMigration: SqlMigration = {
  id: "003_pi_runtime",
  sql: `
create table if not exists pi_agents (
  id text primary key,
  name text not null,
  provider text not null default 'pi-sdk',
  model_provider text not null default '',
  model_id text not null default '',
  thinking_level text not null default 'medium',
  cwd_policy text not null default 'project',
  tools_json text not null default '[]',
  instructions text not null default '',
  enabled integer not null default 1,
  created_at text not null,
  updated_at text not null
);

create table if not exists project_pi_settings (
  project_id text primary key,
  pi_agent_id text not null,
  auto_manage integer not null default 0,
  auto_triage integer not null default 0,
  auto_enqueue integer not null default 0,
  notify_on_needs_user integer not null default 1,
  max_actions_per_cycle integer not null default 5,
  created_at text not null,
  updated_at text not null
);

create table if not exists pi_conversations (
  id text primary key,
  project_id text not null default '',
  pi_agent_id text not null,
  title text not null default '',
  status text not null default 'active',
  session_file text not null default '',
  pi_session_id text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists pi_actions (
  id text primary key,
  project_id text not null default '',
  issue_id integer not null default 0,
  conversation_id text not null default '',
  action_type text not null,
  status text not null,
  risk_level text not null default 'low',
  requires_confirmation integer not null default 0,
  payload_json text not null default '{}',
  result_json text not null default '{}',
  rationale text not null default '',
  created_at text not null,
  updated_at text not null
);

create table if not exists pi_memory_items (
  id text primary key,
  scope text not null,
  scope_id text not null default '',
  kind text not null,
  content text not null,
  source_type text not null default '',
  source_id text not null default '',
  confidence text not null default 'medium',
  pinned integer not null default 0,
  disabled integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_conversations_project
  on pi_conversations(project_id, updated_at);

create index if not exists idx_pi_actions_project
  on pi_actions(project_id, status, created_at);

create index if not exists idx_pi_memory_scope
  on pi_memory_items(scope, scope_id, updated_at);
`
};
