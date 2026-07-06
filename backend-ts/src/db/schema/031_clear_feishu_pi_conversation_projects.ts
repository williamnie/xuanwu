import type { SqlMigration } from "../migrations.ts";

export const clearFeishuPiConversationProjectsMigration: SqlMigration = {
  id: "031_clear_feishu_pi_conversation_projects",
  sql: `
update pi_conversations
   set project_id=''
 where trim(project_id) <> ''
   and (id like 'feishu-%' or title like 'Feishu · %');

update agent_sessions
   set project_id=''
 where trim(project_id) <> ''
   and provider='pi-sdk'
   and (
     provider_session_id like 'feishu-%'
     or raw_ref like '%"conversation_id":"feishu-%'
     or title like 'Feishu · %'
   );
`
};
