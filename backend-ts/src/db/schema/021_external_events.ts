import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const externalEventsMigration: SqlMigration = {
  id: "021_external_events",
  sql: "",
  apply(sqlite) {
    sqlite.run(EVENT_TABLE_SQL);
    addColumn(sqlite, "provider", "text not null default ''");
    addColumn(sqlite, "event_type", "text not null default 'message'");
    addColumn(sqlite, "occurred_at", "text not null default ''");
    addColumn(sqlite, "raw_json", "text not null default '{}'");
    addColumn(sqlite, "attachments_json", "text not null default '[]'");
    addColumn(sqlite, "normalized_message_json", "text not null default '{}'");
    addColumn(sqlite, "project_id", "text not null default ''");
    addColumn(sqlite, "status", "text not null default 'inbox'");
    addColumn(sqlite, "summary_json", "text not null default '{}'");
  }
};

const EVENT_TABLE_SQL = `
create table if not exists external_events (
  id integer primary key autoincrement,
  source text not null,
  provider text not null default '',
  external_id text not null default '',
  event_type text not null default 'message',
  occurred_at text not null default '',
  actor text not null default '',
  project_hint text not null default '',
  content text not null,
  trust_level text not null default 'untrusted',
  dedupe_key text not null,
  raw_payload_ref text not null default '',
  raw_json text not null default '{}',
  attachments_json text not null default '[]',
  normalized_message_json text not null default '{}',
  project_id text not null default '',
  status text not null default 'inbox',
  summary_json text not null default '{}',
  received_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_external_events_source_dedupe
  on external_events(source, dedupe_key, received_at desc, id desc);

create index if not exists idx_external_events_source_external
  on external_events(source, external_id, received_at desc, id desc);

create index if not exists idx_external_events_received
  on external_events(received_at desc, id desc);
`;

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table external_events add column ${name} ${definition}`);
}

function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(external_events)").all()
    .map((row) => row.name));
}
