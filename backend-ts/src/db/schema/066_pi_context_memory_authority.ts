import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piContextMemoryAuthorityMigration: SqlMigration = {
  id: "066_pi_context_memory_authority",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    addColumn(sqlite, "authority", "text not null default 'advisory'");
    addColumn(sqlite, "authorized_by", "text not null default ''");
    addColumn(sqlite, "authorized_at", "text not null default ''");
    sqlite.run(`update pi_memory_items
      set authority='user_explicit',
          authorized_by=case when source_id<>'' then source_id else 'legacy-pi-conversation' end,
          authorized_at=case when updated_at<>'' then updated_at else created_at end
      where authority='advisory'
        and source_type='pi.conversation'
        and kind in ('user_preference', 'project_preference', 'decision', 'workflow', 'constraint')`);
    sqlite.run(`update pi_memory_items
      set authority='evidence_backed',
          authorized_by=case when citation_id<>'' then citation_type || ':' || citation_id else source_id end,
          authorized_at=case when updated_at<>'' then updated_at else created_at end
      where authority='advisory'
        and source_type='pi.manager_cycle'
        and kind in ('debugging_pattern', 'resolution')`);
    sqlite.run(`create index if not exists idx_pi_memory_authority
      on pi_memory_items(authority, disabled, scope, scope_id, updated_at desc)`);
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
