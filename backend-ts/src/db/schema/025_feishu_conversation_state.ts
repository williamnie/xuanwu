import type { SqlMigration } from "../migrations.ts";

export const feishuConversationStateMigration: SqlMigration = {
  id: "025_feishu_conversation_state",
  sql: `
create table if not exists feishu_conversation_state (
  scope_key text primary key,
  active_conversation_id text not null,
  epoch integer not null default 0,
  started_at text not null,
  updated_at text not null
);

create index if not exists idx_feishu_conversation_state_updated
  on feishu_conversation_state(updated_at desc, scope_key asc);
`
};
