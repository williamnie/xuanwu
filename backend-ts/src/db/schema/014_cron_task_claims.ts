import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const cronTaskClaimsMigration: SqlMigration = {
  id: "014_cron_task_claims",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    addColumn(sqlite, "claim_token", "text not null default ''");
    addColumn(sqlite, "claim_started_at", "text not null default ''");
    sqlite.run(`create index if not exists idx_cron_tasks_due_claim
      on cron_tasks(status, next_run_at, claim_token)`);
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columnNames(sqlite).has(name)) return;
  sqlite.run(`alter table cron_tasks add column ${name} ${definition}`);
}

function columnNames(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(cron_tasks)").all()
    .map((column) => column.name));
}
