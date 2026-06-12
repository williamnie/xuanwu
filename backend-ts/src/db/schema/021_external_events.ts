import type { SqlMigration } from "../migrations.ts";

export const externalEventsMigration: SqlMigration = {
  id: "021_external_events",
  sql: `
create table if not exists external_events (
  id integer primary key autoincrement,
  source text not null,
  external_id text not null default '',
  actor text not null default '',
  project_hint text not null default '',
  content text not null,
  trust_level text not null default 'untrusted',
  dedupe_key text not null,
  raw_payload_ref text not null default '',
  received_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_external_events_source_dedupe
  on external_events(source, dedupe_key, received_at desc, id desc);

create index if not exists idx_external_events_received
  on external_events(received_at desc, id desc);
`
};
