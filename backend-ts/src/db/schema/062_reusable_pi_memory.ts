import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const reusablePiMemoryMigration: SqlMigration = {
  id: "062_reusable_pi_memory",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    addColumn(sqlite, "memory_key", "text not null default ''");
    addColumn(sqlite, "occurrence_count", "integer not null default 1");
    addColumn(sqlite, "last_seen_at", "text not null default ''");
    sqlite.run("update pi_memory_items set memory_key=id where memory_key=''");
    sqlite.run("update pi_memory_items set occurrence_count=1 where occurrence_count<1");
    sqlite.run("update pi_memory_items set last_seen_at=updated_at where last_seen_at=''");
    sqlite.run(`create unique index if not exists ux_pi_memory_scope_key
      on pi_memory_items(scope, scope_id, memory_key)
      where memory_key<>''`);
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columnNames(sqlite).has(name)) return;
  sqlite.run(`alter table pi_memory_items add column ${name} ${definition}`);
}

function columnNames(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_memory_items)").all()
    .map((column) => column.name));
}
