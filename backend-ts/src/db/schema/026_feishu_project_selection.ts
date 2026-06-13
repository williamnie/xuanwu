import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const feishuProjectSelectionMigration: SqlMigration = {
  id: "026_feishu_project_selection",
  sql: "",
  apply(sqlite) {
    sqlite.run(TABLE_SQL);
    sqlite.run(STATUS_INDEX_SQL);
    sqlite.run(SCOPE_INDEX_SQL);
  }
};

const TABLE_SQL = `
create table if not exists feishu_project_selections (
  selection_id text primary key,
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
  created_at text not null,
  expires_at text not null,
  consumed_at text not null default ''
);
`;

const STATUS_INDEX_SQL = `
create index if not exists idx_feishu_project_selections_status
  on feishu_project_selections(status, expires_at, created_at desc);
`;

const SCOPE_INDEX_SQL = `
create index if not exists idx_feishu_project_selections_scope
  on feishu_project_selections(scope_key, created_at desc);
`;
