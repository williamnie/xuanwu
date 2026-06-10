import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const executionServiceTierMigration: SqlMigration = {
  id: "019_execution_service_tier",
  sql: "",
  apply(sqlite) {
    addColumn(sqlite, "projects", "default_service_tier", "text not null default ''");
    addColumn(sqlite, "agent_profiles", "service_tier", "text not null default ''");
    addColumn(sqlite, "issues", "service_tier", "text not null default ''");
  }
};

function addColumn(sqlite: SQLiteDatabase, table: string, name: string, definition: string): void {
  if (tableColumns(sqlite, table).has(name)) return;
  sqlite.run(`alter table ${table} add column ${name} ${definition}`);
}

function tableColumns(sqlite: SQLiteDatabase, table: string): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name));
}
