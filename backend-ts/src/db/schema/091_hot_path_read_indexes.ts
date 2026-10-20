import type { SqlMigration } from "../migrations.ts";

/**
 * 补齐运行热路径与时间线读取的窄索引。
 * run_attempts(issue_run_id) 同时服务 issue_runs 更新触发器，缺失时每次 Run 状态写入都会全表扫描。
 */
export const hotPathReadIndexesMigration: SqlMigration = {
  id: "091_hot_path_read_indexes",
  sql: `
create index if not exists idx_run_attempts_issue_run_sequence
  on run_attempts(issue_run_id, sequence);
create index if not exists idx_issue_runs_in_progress_started
  on issue_runs(started_at desc, id desc)
  where status='in_progress';
create index if not exists idx_issue_runs_provider_session
  on issue_runs(provider, provider_session_id);
create index if not exists idx_agent_sessions_provider_session_updated
  on agent_sessions(provider_session_id, updated_at desc, session_key);
create index if not exists idx_agent_sessions_updated
  on agent_sessions(updated_at desc, session_key);
create index if not exists idx_agent_sessions_role_updated
  on agent_sessions(agent_role, updated_at desc, session_key);
create index if not exists idx_notifications_unread_created
  on notifications(created_at desc, id desc)
  where read_at='';
create index if not exists idx_notifications_issue_event
  on notifications(issue_id, event);
create index if not exists idx_pi_action_events_type_id
  on pi_action_events(event_type, id);
create index if not exists idx_im_reply_drafts_issue_updated
  on im_reply_drafts(issue_id, updated_at desc, id desc);
create index if not exists idx_im_reply_drafts_approval_action
  on im_reply_drafts(approval_action_id);
create index if not exists idx_im_reply_drafts_external_event
  on im_reply_drafts(external_event_id);
create index if not exists idx_sync_outbox_issue_updated
  on sync_outbox(issue_id, updated_at desc, id desc);
create index if not exists idx_sync_outbox_approval_action
  on sync_outbox(approval_action_id);
create index if not exists idx_pi_guardian_decisions_created
  on pi_guardian_decisions(created_at, id);
`
};
