import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piMemoryStoreMetadataMigration: SqlMigration = {
  id: "038_pi_memory_store_metadata",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    for (const [name, definition] of Object.entries(COLUMNS)) addColumn(sqlite, name, definition);
    sqlite.run(`update pi_memory_items
      set memory_type=case
        when scope='project' then 'project'
        when scope='inbox' then 'inbox'
        when scope='source' then 'source'
        when scope='skill' then 'skill'
        else memory_type
      end
      where memory_type='user'`);
    sqlite.run(`create index if not exists idx_pi_memory_type
      on pi_memory_items(memory_type, disabled, updated_at desc, id)`);
  }
};

const COLUMNS: Record<string, string> = {
  memory_type: "text not null default 'user'",
  layer: "text not null default 'working'",
  citation_type: "text not null default ''",
  citation_id: "text not null default ''",
  citation_label: "text not null default ''",
  citation_url: "text not null default ''"
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columnNames(sqlite).has(name)) return;
  sqlite.run(`alter table pi_memory_items add column ${name} ${definition}`);
}

function columnNames(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_memory_items)").all()
    .map((column) => column.name));
}
