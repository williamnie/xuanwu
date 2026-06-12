import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const imReplyOutboxDispatchMigration: SqlMigration = {
  id: "024_im_reply_outbox_dispatch",
  sql: "",
  apply(sqlite) {
    addColumn(sqlite, "attempt_count", "integer not null default 0");
    addColumn(sqlite, "cooldown_until", "text not null default ''");
    addColumn(sqlite, "feishu_message_id", "text not null default ''");
    addColumn(sqlite, "last_error", "text not null default ''");
    addColumn(sqlite, "max_attempts", "integer not null default 3");
    addColumn(sqlite, "retry_after_seconds", "integer not null default 0");
    addColumn(sqlite, "sent_at", "text not null default ''");
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table sync_outbox add column ${name} ${definition}`);
}

function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(sync_outbox)").all().map((row) => row.name));
}
