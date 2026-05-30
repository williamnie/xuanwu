import type { SqlMigration } from "../migrations.ts";

export const safeGoImportTablesMigration: SqlMigration = {
  id: "004_safe_go_import_tables",
  sql: `
create table if not exists agent_profiles (
  id text primary key,
  name text not null,
  provider text not null default 'codex',
  model text not null default '',
  reasoning_effort text not null default '',
  approval_policy text not null default '',
  sandbox text not null default '',
  default_instructions text not null default '',
  skill_intents_json text not null default '[]',
  plugin_intents_json text not null default '[]',
  created_at text not null,
  updated_at text not null
);

create table if not exists issue_templates (
  id text primary key,
  name text not null,
  content text not null,
  is_default integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_agent_profiles_provider
  on agent_profiles(provider);
`
};
