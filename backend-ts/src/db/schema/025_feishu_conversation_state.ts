import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const feishuConversationStateMigration: SqlMigration = {
  id: "025_feishu_conversation_state",
  sql: "",
  apply(sqlite) {
    sqlite.run(TABLE_SQL);
    addColumn(sqlite, "active_project_id", "text not null default ''");
    addColumn(sqlite, "active_project_source", "text not null default ''");
    sqlite.run(UPDATED_INDEX_SQL);
    sqlite.run(ACTIVE_PROJECT_INDEX_SQL);
  }
};

const TABLE_SQL = `
create table if not exists feishu_conversation_state (
  scope_key text primary key,
  active_conversation_id text not null,
  active_project_id text not null default '',
  active_project_source text not null default '',
  epoch integer not null default 0,
  started_at text not null,
  updated_at text not null
);
`;

const UPDATED_INDEX_SQL = `
create index if not exists idx_feishu_conversation_state_updated
  on feishu_conversation_state(updated_at desc, scope_key asc);
`;

const ACTIVE_PROJECT_INDEX_SQL = `
create index if not exists idx_feishu_conversation_state_project
  on feishu_conversation_state(active_project_id, updated_at desc);
`;

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table feishu_conversation_state add column ${name} ${definition}`);
}

function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(feishu_conversation_state)").all()
    .map((row) => row.name));
}
