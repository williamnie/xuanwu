import type { SqlMigration } from "../migrations.ts";

export const mcpRegistryEnvelopeMigration: SqlMigration = {
  id: "010_mcp_registry_envelope",
  sql: `
alter table projects add column default_mcp_policy_json text not null default '{}';
alter table issues add column required_mcp_capabilities_json text not null default '[]';
alter table issues add column recommended_mcp_capabilities_json text not null default '[]';
`
};
