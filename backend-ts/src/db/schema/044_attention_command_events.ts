import type { SqlMigration } from "../migrations.ts";

// This is an append-only command/audit carrier, not a second Attention object.
// Legacy rows remain the source of truth for the underlying alert, approval, or inbox fact.
export const attentionCommandEventsMigration: SqlMigration = {
  id: "044_attention_command_events",
  sql: `
create table if not exists attention_command_events (
  event_id text primary key,
  attention_id text not null,
  revision integer not null,
  action text not null,
  snoozed_until text not null default '',
  audit_json text not null,
  created_at text not null
);

create unique index if not exists ux_attention_command_events_revision
  on attention_command_events(attention_id, revision);
create index if not exists idx_attention_command_events_attention
  on attention_command_events(attention_id, revision);
`
};
