import type { SqlMigration } from "../migrations.ts";

/** Provider-neutral IM context projection bindings, cursors, and Session rollover lineage. */
export const imContextLifecycleMigration: SqlMigration = {
  id: "082_im_context_lifecycle",
  sql: `
create table if not exists im_context_event_bindings (
  id integer primary key autoincrement,
  connector_id text not null,
  scope_key text not null,
  conversation_id text not null,
  turn_id text not null,
  direction text not null check(direction in ('inbound', 'outbound')),
  source_row_id integer not null,
  message_ref text not null default '',
  projection_hash text not null,
  status text not null check(status in ('reserved', 'presented', 'failed')),
  created_at text not null,
  presented_at text not null default '',
  error text not null default '',
  unique(connector_id, direction, source_row_id, conversation_id)
);

create index if not exists idx_im_context_bindings_turn
  on im_context_event_bindings(conversation_id, turn_id, status, id);

create index if not exists idx_im_context_bindings_scope
  on im_context_event_bindings(connector_id, scope_key, direction, source_row_id);

create table if not exists im_context_cursors (
  connector_id text not null,
  scope_key text not null,
  conversation_id text not null,
  inbound_event_id integer not null default 0,
  outbound_outbox_id integer not null default 0,
  updated_at text not null,
  primary key (connector_id, scope_key, conversation_id)
);

create table if not exists im_context_rollovers (
  id text primary key,
  connector_id text not null,
  scope_key text not null,
  parent_conversation_id text not null,
  child_conversation_id text not null,
  parent_epoch integer not null,
  child_epoch integer not null,
  trigger text not null,
  status text not null check(status in ('preparing', 'activated', 'failed')),
  capsule_json text not null,
  expected_active_conversation_id text not null,
  created_at text not null,
  activated_at text not null default '',
  error text not null default '',
  unique(connector_id, scope_key, child_epoch)
);

create index if not exists idx_im_context_rollovers_scope
  on im_context_rollovers(connector_id, scope_key, child_epoch desc);

create index if not exists idx_pi_action_events_context_lifecycle
  on pi_action_events(conversation_id, event_type, id desc)
  where event_type in (
    'runtime_context_budget_observed',
    'im_context_policy_observed',
    'im_context_rollover_activated'
  );
`
};
