import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

/**
 * A3: provider-neutral IM conversation state (design
 * 2026-08-02-generic-im-channel-telegram-design.md §7.1/§7.2). The table holds
 * per-scope conversation epochs only — IM conversations never persist a
 * current project, so `active_project_*` from the legacy Feishu table is
 * deliberately not carried over. `feishu_conversation_state` stays as a
 * read-only historical carrier until a separate destructive migration.
 */
export const imConversationStateMigration: SqlMigration = {
  id: "070_im_conversation_state",
  sql: "",
  apply(sqlite) {
    sqlite.run(TABLE_SQL);
    sqlite.run(UPDATED_INDEX_SQL);
    backfillFromFeishu(sqlite);
    return undefined;
  }
};

/**
 * Idempotent backfill for databases where the 070 migration row already
 * exists but legacy Feishu rows appeared afterwards (or drift repair skipped
 * the initial backfill). Returns the number of rows inserted by this run.
 */
export function backfillImConversationState(sqlite: SQLiteDatabase): number {
  if (!tableExists(sqlite, "im_conversation_state")) return 0;
  if (!tableExists(sqlite, "feishu_conversation_state")) return 0;
  const result = sqlite.run(
    `insert or ignore into im_conversation_state
       (connector_id, scope_key, base_conversation_id, active_conversation_id, epoch, started_at, updated_at)
     select 'feishu', scope_key,
            scope_key,
            active_conversation_id,
            epoch,
            started_at,
            updated_at
       from feishu_conversation_state`
  );
  return Number(result.changes ?? 0);
}

const TABLE_SQL = `
create table if not exists im_conversation_state (
  connector_id text not null,
  scope_key text not null,
  base_conversation_id text not null,
  active_conversation_id text not null,
  epoch integer not null default 0,
  started_at text not null,
  updated_at text not null,
  primary key (connector_id, scope_key)
);
`;

const UPDATED_INDEX_SQL = `
create index if not exists idx_im_conversation_state_updated
  on im_conversation_state(connector_id, updated_at desc, scope_key asc);
`;

function backfillFromFeishu(sqlite: SQLiteDatabase): void {
  backfillImConversationState(sqlite);
}

function tableExists(sqlite: SQLiteDatabase, name: string): boolean {
  return sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from sqlite_master where type='table' and name=?"
  ).get(name)?.count === 1;
}
