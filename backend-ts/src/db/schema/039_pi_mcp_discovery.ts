import type { SqlMigration } from "../migrations.ts";

export const piMcpDiscoveryMigration: SqlMigration = {
  id: "039_pi_mcp_discovery",
  sql: `
create table if not exists pi_mcp_servers (
  id text primary key,
  name text not null,
  description text not null default '',
  source text not null default 'manual',
  source_path text not null default '',
  transport_type text not null default 'stdio',
  command text not null default '',
  args_json text not null default '[]',
  cwd text not null default '',
  env_json text not null default '{}',
  url text not null default '',
  headers_json text not null default '{}',
  enabled integer not null default 0,
  status text not null default 'discovered',
  readiness text not null default 'not_introspected',
  risk_level text not null default 'medium',
  diagnostics_json text not null default '[]',
  redaction_json text not null default '{"env":[],"headers":[]}',
  metadata_json text not null default '{}',
  last_scan_at text not null default '',
  last_introspected_at text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists pi_mcp_capabilities (
  id text primary key,
  server_id text not null,
  kind text not null,
  name text not null,
  description text not null default '',
  uri text not null default '',
  input_schema_json text not null default '{}',
  output_schema_json text not null default '{}',
  permission text not null default 'read',
  risk_level text not null default 'low',
  requires_confirmation integer not null default 0,
  read_only integer not null default 1,
  enabled integer not null default 0,
  timeout_ms integer not null default 10000,
  source_path text not null default '',
  diagnostics_json text not null default '[]',
  metadata_json text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key(server_id) references pi_mcp_servers(id) on delete cascade
);

create index if not exists idx_pi_mcp_capabilities_server
  on pi_mcp_capabilities(server_id, enabled);
`
};
