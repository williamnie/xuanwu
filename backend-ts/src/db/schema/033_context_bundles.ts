import type { SqlMigration } from "../migrations.ts";

export const contextBundlesMigration: SqlMigration = {
  id: "033_context_bundles",
  sql: `
create table if not exists context_bundles (
  id integer primary key autoincrement,
  source text not null,
  event_refs_json text not null default '[]',
  attachment_refs_json text not null default '[]',
  window_json text not null default '{}',
  reason text not null,
  trigger text not null,
  created_by text not null,
  source_query_json text not null default '{}',
  evidence_refs_json text not null default '[]',
  token_budget integer not null default 0,
  summary_json text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_context_bundles_source_created
  on context_bundles(source, created_at desc, id desc);
`
};
