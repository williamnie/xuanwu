import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const dropIssueTemplatesMigration: SqlMigration = {
  id: "058_drop_issue_templates",
  sql: "",
  apply(sqlite) {
    sqlite.run("drop table if exists issue_templates");
    dropColumnIfPresent(sqlite, "issues", "template_id");
    dropColumnIfPresent(sqlite, "issues", "prompt_template");
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
