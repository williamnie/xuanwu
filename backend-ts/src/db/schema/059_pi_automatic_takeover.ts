import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

const PROJECT_BINDING_COLUMNS = [
  "pi_agent_id",
  "auto_manage",
  "auto_triage",
  "auto_enqueue",
  "notify_on_needs_user",
  "max_actions_per_cycle"
];

const REMOVED_POLICY_COLUMNS = ["default_mode", "supervisor_mode"];

export const piAutomaticTakeoverMigration: SqlMigration = {
  id: "059_pi_automatic_takeover",
  sql: "",
  apply(sqlite) {
    sqlite.run(`update projects set auto_run=1
      where id in (select project_id from project_pi_settings)`);
    for (const column of PROJECT_BINDING_COLUMNS) dropColumnIfPresent(sqlite, "project_pi_settings", column);
    for (const column of REMOVED_POLICY_COLUMNS) dropColumnIfPresent(sqlite, "project_pi_policies", column);
  }
};

function dropColumnIfPresent(sqlite: SQLiteDatabase, table: string, column: string): void {
  if (!columnNames(sqlite, table).has(column)) return;
  sqlite.run(`alter table ${table} drop column ${column}`);
}

function columnNames(sqlite: SQLiteDatabase, table: string): Set<string> {
  const rows = sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}
