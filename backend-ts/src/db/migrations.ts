import type { Database as SQLiteDatabase } from "bun:sqlite";
import { migrations } from "./schema/index.ts";

export type SqlMigration = {
  id: string;
  sql: string;
};

type MigrationRow = { id: string };
const REPAIRABLE_MIGRATION_IDS = new Set(["001_base_schema", "003_pi_runtime", "004_safe_go_import_tables"]);

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
      sqlite.run(migration.sql);
      sqlite.run("insert into schema_migrations (id) values (?)", [migration.id]);
      applied.add(migration.id);
    }
    repairKnownSchemaDrift(sqlite, sqlMigrations);
  });
  applyPending.immediate();
}

function loadAppliedMigrationIDs(sqlite: SQLiteDatabase): Set<string> {
  const rows = sqlite.query<MigrationRow, []>("select id from schema_migrations").all();
  return new Set(rows.map((row) => row.id));
}

function repairKnownSchemaDrift(sqlite: SQLiteDatabase, sqlMigrations: SqlMigration[]): void {
  for (const migration of sqlMigrations) {
    if (REPAIRABLE_MIGRATION_IDS.has(migration.id)) sqlite.run(migration.sql);
  }
}
