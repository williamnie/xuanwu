import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piDelegationMcpAllowlistMigration: SqlMigration = {
  id: "016_pi_delegation_mcp_allowlist",
  sql: "",
  apply(sqlite) {
    addDelegationColumn(sqlite, "allowed_mcp_capabilities_json", "'[]'");
  }
};

function addDelegationColumn(sqlite: SQLiteDatabase, name: string, fallback: string): void {
  if (delegationColumns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_delegations add column ${name} text not null default ${fallback}`);
}

function delegationColumns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_delegations)").all().map((row) => row.name));
}
