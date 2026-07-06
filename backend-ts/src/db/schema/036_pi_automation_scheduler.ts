import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piAutomationSchedulerMigration: SqlMigration = {
  id: "036_pi_automation_scheduler",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    for (const [name, definition] of Object.entries(COLUMNS)) addColumn(sqlite, name, definition);
    sqlite.run(`create index if not exists idx_pi_automations_due
      on pi_automations(trigger_type, enabled, next_run_at, lock_token)`);
    sqlite.run(`create index if not exists idx_pi_automations_lock
      on pi_automations(lock_token, lock_expires_at)`);
  }
};

const COLUMNS: Record<string, string> = {
  error: "text not null default ''",
  failed_cursor: "text not null default ''",
  last_result: "text not null default ''",
  last_run_at: "text not null default ''",
  last_status: "text not null default ''",
  last_successful_cursor: "text not null default ''",
  lock_expires_at: "text not null default ''",
  lock_token: "text not null default ''",
  next_run_at: "text not null default ''",
  processed_watermark: "text not null default ''",
  retry_backoff_seconds: "integer not null default 60",
  retry_count: "integer not null default 0",
  run_count: "integer not null default 0",
  run_started_at: "text not null default ''",
  run_timeout_ms: "integer not null default 300000"
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columnNames(sqlite).has(name)) return;
  sqlite.run(`alter table pi_automations add column ${name} ${definition}`);
}

function columnNames(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_automations)").all()
    .map((column) => column.name));
}
