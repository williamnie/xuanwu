import type { Database as SQLiteDatabase } from "bun:sqlite";
import { migrations } from "./schema/index.ts";
import {
  dropLegacyAutomationTables,
  LEGACY_AUTOMATION_DROP_MIGRATION_ID
} from "./schema/053_drop_legacy_automation_tables.ts";

export type SqlMigration = {
  apply?: (sqlite: SQLiteDatabase) => false | void;
  id: string;
  sql: string;
};

type MigrationRow = { id: string };
const REPAIRABLE_MIGRATION_IDS = new Set([
  "001_base_schema",
  "003_pi_runtime",
  "004_safe_go_import_tables",
  "007_pi_heartbeat_orchestrator",
  "008_cron_schedule_layer",
  "011_pi_reports",
  "012_pi_delegation_envelope",
  "013_project_pi_policy",
  "014_cron_task_claims",
  "015_pi_delegation_skill_intents",
  "017_project_pi_policy_allowlists",
  "018_notifications",
  "019_execution_service_tier",
  "020_issue_supervisor_recovery",
  "021_external_events",
  "022_external_links",
  "023_im_reply_outbox",
  "024_im_reply_outbox_dispatch",
  "025_feishu_conversation_state",
  "026_feishu_project_selection",
  "027_pi_approval_requests",
  "028_pi_guardian_runtime",
  "029_pi_issue_completion_watches",
  "032_assistant_tool_registry",
  "035_pi_automations",
  "036_pi_automation_scheduler",
  "039_pi_mcp_discovery"
]);

const MIGRATIONS_TABLE_SQL = `
create table if not exists schema_migrations (
  id text primary key,
  applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`;

export function runMigrations(sqlite: SQLiteDatabase, sqlMigrations: SqlMigration[] = migrations): void {
  sqlite.run(MIGRATIONS_TABLE_SQL);
  const applied = loadAppliedMigrationIDs(sqlite);
  const applyPending = sqlite.transaction(() => {
    for (const migration of sqlMigrations) {
      if (applied.has(migration.id)) continue;
      if (!applyMigration(sqlite, migration)) continue;
      sqlite.run("insert into schema_migrations (id) values (?)", [migration.id]);
      applied.add(migration.id);
    }
    repairKnownSchemaDrift(sqlite, sqlMigrations);
    if (applied.has(LEGACY_AUTOMATION_DROP_MIGRATION_ID)) {
      // Repairable historical migrations recreate empty compatibility tables. Re-drop
      // them only after the audited maintenance command has persisted the marker.
      dropLegacyAutomationTables(sqlite);
    }
  });
  applyPending.immediate();
}

function loadAppliedMigrationIDs(sqlite: SQLiteDatabase): Set<string> {
  const rows = sqlite.query<MigrationRow, []>("select id from schema_migrations").all();
  return new Set(rows.map((row) => row.id));
}

function repairKnownSchemaDrift(sqlite: SQLiteDatabase, sqlMigrations: SqlMigration[]): void {
  for (const migration of sqlMigrations) {
    if (REPAIRABLE_MIGRATION_IDS.has(migration.id)) applyMigration(sqlite, migration);
  }
}

function applyMigration(sqlite: SQLiteDatabase, migration: SqlMigration): boolean {
  if (migration.apply) {
    return migration.apply(sqlite) !== false;
  }
  sqlite.run(migration.sql);
  return true;
}
