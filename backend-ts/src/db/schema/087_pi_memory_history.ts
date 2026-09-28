import type { SqlMigration } from "../migrations.ts";

export const piMemoryHistoryMigration: SqlMigration = {
  id: "087_pi_memory_history",
  sql: `
alter table pi_memory_items add column revision integer not null default 1;
update pi_memory_items set authority='user_explicit'
  where authority='advisory' and source_type in ('manual', 'manual_settings', 'action_proposal');
create table pi_memory_history (
  memory_id text not null,
  revision integer not null,
  operation text not null,
  snapshot_json text not null,
  correction_json text not null default '{}',
  recorded_at text not null,
  primary key (memory_id, revision)
);
create table pi_memory_receipts (
  memory_id text not null,
  source_key text not null,
  content_hash text not null,
  revision integer not null,
  primary key (memory_id, source_key, content_hash)
);
create table pi_memory_suppressions (
  scope text not null,
  scope_id text not null,
  memory_key text not null,
  memory_id text not null,
  state text not null check (state in ('disabled', 'forgotten')),
  updated_at text not null,
  primary key (scope, scope_id, memory_key)
);
insert into pi_memory_history (memory_id, revision, operation, snapshot_json, recorded_at)
select id, revision, 'import', json_object(
  'id', id, 'scope', scope, 'scope_id', scope_id, 'memory_key', memory_key,
  'kind', kind, 'content', content, 'source_type', source_type, 'source_id', source_id,
  'citation_type', citation_type, 'citation_id', citation_id, 'citation_label', citation_label,
  'citation_url', citation_url, 'authority', authority, 'authorized_by', authorized_by,
  'authorized_at', authorized_at, 'confidence', confidence, 'pinned', pinned,
  'disabled', disabled, 'memory_type', memory_type, 'layer', layer,
  'occurrence_count', occurrence_count, 'last_seen_at', last_seen_at,
  'created_at', created_at, 'updated_at', updated_at, 'revision', revision
), updated_at from pi_memory_items;
insert into pi_memory_suppressions
select scope, scope_id, memory_key, id, 'disabled', updated_at from pi_memory_items where disabled<>0;
`
};
