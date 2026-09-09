import type { SqlMigration } from "../migrations.ts";

/** 高频状态统计与巡检只读取相关的窄索引，不加载历史 payload。 */
export const runtimeReadIndexesMigration: SqlMigration = {
  id: "085_runtime_read_indexes",
  sql: `
create index if not exists idx_issue_runs_active_provider
  on issue_runs(provider) where ended_at='';
create index if not exists idx_agent_sessions_status
  on agent_sessions(status);
create index if not exists idx_pi_conversations_failed_health
  on pi_conversations(updated_at, project_id) where status='failed' and project_id<>'';
create index if not exists idx_agent_sessions_manager_health
  on agent_sessions(project_id, updated_at, status) where agent_role='pi_manager';
create index if not exists idx_pi_notification_intents_recent_route
  on pi_notification_intents(updated_at desc, created_at desc, id desc)
  where target_channel<>'' and (target_chat_id<>'' or target_thread_id<>'' or target_message_id<>'');
create index if not exists idx_pi_notification_intents_stale_routable
  on pi_notification_intents(state, created_at, project_id)
  where kind<>'digest' and (target_channel<>'' or target_chat_id<>'' or target_thread_id<>''
    or target_message_id<>'' or conversation_id<>'' or run_group_id<>'' or sent_outbox_id>0 or error<>'');
create index if not exists idx_issues_in_progress_title
  on issues(project_id, title) where status='in_progress';
`
};
