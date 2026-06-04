import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const projectPiPolicyAllowlistsMigration: SqlMigration = {
  id: "017_project_pi_policy_allowlists",
  sql: "",
  apply(sqlite) {
    addPolicyColumn(sqlite, "allowed_actions_json", "'[]'");
    addPolicyColumn(sqlite, "allowed_mcp_capabilities_json", "'[]'");
    addPolicyColumn(sqlite, "allowed_skill_intents_json", "'[]'");
  }
};

function addPolicyColumn(sqlite: SQLiteDatabase, name: string, fallback: string): void {
  if (policyColumns(sqlite).has(name)) return;
  sqlite.run(`alter table project_pi_policies add column ${name} text not null default ${fallback}`);
}

function policyColumns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>(
    "pragma table_info(project_pi_policies)"
  ).all().map((row) => row.name));
}
