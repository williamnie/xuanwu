import type { SqlMigration } from "../migrations.ts";

export const piAutomationsMigration: SqlMigration = {
  id: "035_pi_automations",
  sql: `
create table if not exists pi_automations (
  id integer primary key autoincrement,
  name text not null,
  trigger_type text not null,
  trigger_config_json text not null default '{}',
  mode text not null default 'propose',
  filters_json text not null default '[]',
  source_policy_json text not null default '{}',
  max_actions_per_run integer not null default 1,
  enabled integer not null default 1,
  steps_json text not null default '[]',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_pi_automations_trigger_enabled
  on pi_automations(trigger_type, enabled, updated_at desc, id desc);
`
};
