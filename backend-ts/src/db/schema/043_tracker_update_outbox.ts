import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const trackerUpdateOutboxMigration: SqlMigration = {
  id: "043_tracker_update_outbox",
  sql: "",
  apply(sqlite) {
    addColumn(sqlite, "operation_kind", "text not null default 'im_reply'");
    addColumn(sqlite, "project_id", "text not null default ''");
    addColumn(sqlite, "handoff_id", "text not null default ''");
    addColumn(sqlite, "work_id", "text not null default ''");
    addColumn(sqlite, "target_external_id", "text not null default ''");
    addColumn(sqlite, "target_external_type", "text not null default ''");
    addColumn(sqlite, "dedupe_key", "text not null default ''");
    addColumn(sqlite, "payload_json", "text not null default '{}'");
    addColumn(sqlite, "result_json", "text not null default '{}'");
    addColumn(sqlite, "correlation_id", "text not null default ''");
    addColumn(sqlite, "provider_request_ref", "text not null default ''");
    addColumn(sqlite, "attention_ref", "text not null default ''");

    // Legacy IM rows use a positive draft id. Tracker rows intentionally use 0,
    // so keep IM dedupe without making all tracker rows collide on the sentinel.
    sqlite.run("drop index if exists idx_sync_outbox_reply_draft");
    sqlite.run(`create unique index idx_sync_outbox_reply_draft
      on sync_outbox(reply_draft_id) where reply_draft_id > 0`);
    sqlite.run(`create unique index if not exists ux_sync_outbox_tracker_dedupe
      on sync_outbox(source, operation_kind, dedupe_key)
      where operation_kind='tracker_update' and dedupe_key<>''`);
    sqlite.run(`create index if not exists idx_sync_outbox_operation_dispatch
      on sync_outbox(operation_kind, status, cooldown_until, created_at, id)`);
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table sync_outbox add column ${name} ${definition}`);
}

function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(sync_outbox)").all().map((row) => row.name));
}
