import type { SqlMigration } from "../migrations.ts";

// P08.06 keeps Automation as the definition authority and adds only the
// observation/delivery state that a Watch needs. Legacy completion watches are
// represented as shadow rows until the documented cutover gate opens.
export const automationWatchesMigration: SqlMigration = {
  id: "050_automation_watches",
  sql: `
create table if not exists automation_watches (
  automation_id text primary key references automation_definitions(id) on delete restrict,
  migration_mode text not null check (migration_mode in ('native', 'legacy_shadow')),
  legacy_watch_id text not null default '',
  condition_json text not null,
  subject_json text not null,
  notification_target_json text not null,
  dedupe_key text not null,
  expires_at text not null default '',
  status text not null check (status in ('watching', 'satisfied', 'notified', 'expired', 'cancelled', 'failed')),
  outcome text not null default '',
  matched_ref text not null default '',
  last_external_event_id integer not null default 0 check (last_external_event_id >= 0),
  satisfied_at text not null default '',
  notified_at text not null default '',
  error text not null default '',
  created_at text not null,
  updated_at text not null
);
create unique index if not exists ux_automation_watches_dedupe
  on automation_watches(dedupe_key);
create unique index if not exists ux_automation_watches_legacy
  on automation_watches(legacy_watch_id) where legacy_watch_id<>'';
create index if not exists idx_automation_watches_due
  on automation_watches(migration_mode, status, expires_at, automation_id);
`
};
