import type { Database } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const LEGACY_AUTOMATION_DROP_MIGRATION_ID = "053_drop_legacy_automation_tables";

export const LEGACY_AUTOMATION_DROP_TABLES = [
  "cron_task_schedules",
  "cron_tasks",
  "pi_automations",
  "pi_issue_completion_watch_items",
  "pi_issue_completion_watches",
  "nightly_batch_items",
  "nightly_batches"
] as const;

const DROP_ORDER = [
  "cron_task_schedules",
  "pi_issue_completion_watch_items",
  "nightly_batch_items",
  "cron_tasks",
  "pi_automations",
  "pi_issue_completion_watches",
  "nightly_batches"
] as const;

export const dropLegacyAutomationTablesMigration: SqlMigration = {
  id: LEGACY_AUTOMATION_DROP_MIGRATION_ID,
  sql: "",
  // Physical removal always requires the audited maintenance command, even for an
  // empty database. Returning false keeps ordinary startup fail-closed and deferred.
  apply: () => false
};

export function dropLegacyAutomationTables(sqlite: Database): void {
  for (const table of DROP_ORDER) sqlite.run(`drop table if exists ${table}`);
}
