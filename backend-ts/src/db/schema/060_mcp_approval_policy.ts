import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const mcpApprovalPolicyMigration: SqlMigration = {
  id: "060_mcp_approval_policy",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    addColumn(sqlite, "pi_mcp_servers", "approval_mode", "text not null default 'dangerous_only'");
    addColumn(sqlite, "pi_mcp_servers", "approval_granted_at", "text not null default ''");
    sqlite.run(`
      create table if not exists pi_mcp_approval_grants (
        id text primary key,
        project_id text not null,
        capability_id text not null,
        capability_fingerprint text not null,
        granted_by text not null,
        reason text not null default '',
        revoked_at text not null default '',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        foreign key(project_id) references projects(id) on delete cascade,
        foreign key(capability_id) references pi_mcp_capabilities(id) on delete cascade
      )
    `);
    sqlite.run(`create unique index if not exists ux_pi_mcp_approval_grant_scope
      on pi_mcp_approval_grants(project_id, capability_id) where revoked_at=''`);
    sqlite.run(`create index if not exists idx_pi_mcp_approval_grants_capability
      on pi_mcp_approval_grants(capability_id, revoked_at)`);

    // Existing pending MCP approvals predate the TTL contract. Backfill them
    // so the next watchdog pass removes stale fixtures from Attention.
    sqlite.run(`
      update pi_actions
      set lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
      where action_type='mcp.tool.call' and status='pending' and trim(lease_expires_at)=''
    `);

    // Historical discovery treated every tool without readOnlyHint as high risk.
    // Installation is now the ordinary-write trust boundary; only explicit
    // destructive/open-world annotations remain high risk by default.
    sqlite.run(`
      update pi_mcp_capabilities
      set risk_level='medium', requires_confirmation=0,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      where kind='tool' and permission='write' and read_only=0
        and coalesce(json_extract(metadata_json, '$.annotations.destructiveHint'), 0)<>1
        and coalesce(json_extract(metadata_json, '$.annotations.openWorldHint'), 0)<>1
    `);
  }
};

function addColumn(sqlite: SQLiteDatabase, table: string, name: string, definition: string): void {
  const columns = new Set(sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(name)) sqlite.run(`alter table ${table} add column ${name} ${definition}`);
}
