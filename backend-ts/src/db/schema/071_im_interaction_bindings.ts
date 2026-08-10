import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

/**
 * A3: provider-neutral IM interaction bindings and project selections (design
 * 2026-08-02-generic-im-channel-telegram-design.md §13.1–§13.3).
 *
 * `im_interaction_bindings` stores only transport bindings that resolve to the
 * authoritative business facts (`pi_actions`, `pi_approval_requests` or
 * `im_project_selections`); callback payloads never carry trusted business
 * parameters. `im_project_selections` carries the one-shot pending project
 * choice; the legacy `feishu_project_selections` table stays as a read-only
 * historical carrier until a separate destructive migration.
 */
export const imInteractionBindingsMigration: SqlMigration = {
  id: "071_im_interaction_bindings",
  sql: "",
  apply(sqlite) {
    sqlite.run(INTERACTION_TABLE_SQL);
    sqlite.run(INTERACTION_STATUS_INDEX_SQL);
    sqlite.run(SELECTION_TABLE_SQL);
    sqlite.run(SELECTION_STATUS_INDEX_SQL);
    sqlite.run(SELECTION_SCOPE_INDEX_SQL);
    backfillImProjectSelections(sqlite);
    return undefined;
  }
};

/**
 * Idempotent backfill for databases where 071 already applied but legacy
 * Feishu selection rows appeared afterwards. Preserves business semantics:
 * scope/conversation ids, the prompt, candidates, lifecycle timestamps and
 * consume-once results are copied verbatim. Never rewrites or deletes rows.
 */
export function backfillImProjectSelections(sqlite: SQLiteDatabase): number {
  if (!tableExists(sqlite, "im_project_selections")) return 0;
  if (!tableExists(sqlite, "feishu_project_selections")) return 0;
  const result = sqlite.run(
    `insert or ignore into im_project_selections
       (selection_id, connector_id, scope_key, conversation_id, chat_id,
        user_id, user_open_id, source_message_id, original_prompt,
        candidates_json, status, selected_project_id, expires_at,
        consumed_at, created_at, updated_at)
     select selection_id, 'feishu', scope_key, conversation_id, chat_id,
            user_id, user_open_id, source_message_id, original_prompt,
            candidates_json, status, selected_project_id, expires_at,
            consumed_at, created_at,
            coalesce(nullif(consumed_at, ''), created_at)
       from feishu_project_selections`
  );
  return Number(result.changes ?? 0);
}

const INTERACTION_TABLE_SQL = `
create table if not exists im_interaction_bindings (
  interaction_id text primary key,
  connector_id text not null,
  action_kind text not null,
  action_ref text not null,
  actions_json text not null default '[]',
  actor_id text not null default '',
  actor_open_id text not null default '',
  scope_key text not null,
  conversation_id text not null default '',
  source_message_id text not null default '',
  status text not null default 'pending',
  revision integer not null default 1,
  expires_at text not null,
  claimed_action_id text not null default '',
  lease_id text not null default '',
  lease_expires_at text not null default '',
  resolution_json text not null default '',
  resolved_at text not null default '',
  consumed_at text not null default '',
  created_at text not null,
  updated_at text not null
);
`;

const INTERACTION_STATUS_INDEX_SQL = `
create index if not exists idx_im_interaction_bindings_status
  on im_interaction_bindings(status, expires_at, created_at desc);
`;

const SELECTION_TABLE_SQL = `
create table if not exists im_project_selections (
  selection_id text primary key,
  connector_id text not null,
  scope_key text not null,
  conversation_id text not null,
  chat_id text not null default '',
  user_id text not null default '',
  user_open_id text not null default '',
  source_message_id text not null default '',
  original_prompt text not null,
  candidates_json text not null default '[]',
  status text not null default 'pending',
  selected_project_id text not null default '',
  expires_at text not null,
  consumed_at text not null default '',
  created_at text not null,
  updated_at text not null
);
`;

const SELECTION_STATUS_INDEX_SQL = `
create index if not exists idx_im_project_selections_status
  on im_project_selections(status, expires_at, created_at desc);
`;

const SELECTION_SCOPE_INDEX_SQL = `
create index if not exists idx_im_project_selections_scope
  on im_project_selections(connector_id, scope_key, created_at desc);
`;

function tableExists(sqlite: SQLiteDatabase, name: string): boolean {
  return sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from sqlite_master where type='table' and name=?"
  ).get(name)?.count === 1;
}
