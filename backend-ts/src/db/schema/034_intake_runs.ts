import type { SqlMigration } from "../migrations.ts";

export const intakeRunsMigration: SqlMigration = {
  id: "034_intake_runs",
  sql: `
create table if not exists intake_runs (
  id integer primary key autoincrement,
  bundle_id integer not null,
  skill_id text not null,
  model_policy_id text not null default '',
  model text not null default '',
  input_summary_json text not null default '{}',
  schema_output_json text not null default '{}',
  ignored_groups_json text not null default '[]',
  error text not null default '',
  status text not null default 'running',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key(bundle_id) references context_bundles(id) on delete cascade
);

create index if not exists idx_intake_runs_bundle
  on intake_runs(bundle_id, created_at desc, id desc);

create index if not exists idx_intake_runs_status
  on intake_runs(status, updated_at desc, id desc);

create table if not exists attention_inbox_items (
  id integer primary key autoincrement,
  source text not null,
  bundle_id integer not null,
  intake_run_id integer not null,
  title text not null,
  summary text not null,
  kind text not null default 'attention',
  primary_intent text not null,
  secondary_intents_json text not null default '[]',
  suggested_actions_json text not null default '[]',
  confidence real not null,
  urgency text not null default '',
  evidence_refs_json text not null default '[]',
  actor_refs_json text not null default '[]',
  target_hints_json text not null default '[]',
  schema_item_json text not null default '{}',
  status text not null default 'new',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key(bundle_id) references context_bundles(id) on delete cascade,
  foreign key(intake_run_id) references intake_runs(id) on delete cascade
);

create index if not exists idx_attention_inbox_items_status
  on attention_inbox_items(status, created_at desc, id desc);

create index if not exists idx_attention_inbox_items_intake_run
  on attention_inbox_items(intake_run_id, id);

create index if not exists idx_attention_inbox_items_source
  on attention_inbox_items(source, created_at desc, id desc);
`
};
