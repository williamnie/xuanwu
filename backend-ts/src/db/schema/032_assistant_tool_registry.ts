import type { SqlMigration } from "../migrations.ts";

export const assistantToolRegistryMigration: SqlMigration = {
  id: "032_assistant_tool_registry",
  sql: `
create table if not exists assistant_tool_providers (
  id text primary key,
  kind text not null,
  name text not null,
  description text not null default '',
  status text not null default 'enabled',
  version text not null default '',
  default_timeout_ms integer not null default 0,
  audit_json text not null default '{"redact":[]}',
  metadata_json text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists assistant_tools (
  provider_id text not null,
  name text not null,
  description text not null,
  input_schema_json text not null default '{}',
  output_schema_json text not null default '{}',
  permission text not null default 'read',
  timeout_ms integer not null default 0,
  audit_json text not null default '{"redact":[]}',
  metadata_json text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key(provider_id, name),
  foreign key(provider_id) references assistant_tool_providers(id) on delete cascade
);

create index if not exists idx_assistant_tools_provider
  on assistant_tools(provider_id, name);
`
};
