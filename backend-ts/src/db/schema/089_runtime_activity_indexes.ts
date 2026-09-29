import type { SqlMigration } from "../migrations.ts";

/** 为控制面与有界活动读取提供窄索引，不重写历史业务数据。 */
export const runtimeActivityIndexesMigration: SqlMigration = {
  id: "089_runtime_activity_indexes",
  sql: `
create index if not exists idx_pi_actions_issue_created
  on pi_actions(issue_id, created_at desc, id desc);
create index if not exists idx_pi_actions_conversation_created
  on pi_actions(conversation_id, created_at desc, id desc);
create index if not exists idx_pi_actions_issue_updated
  on pi_actions(issue_id, updated_at desc, id desc);
create index if not exists idx_pi_actions_conversation_updated
  on pi_actions(conversation_id, updated_at desc, id desc);
create index if not exists idx_pi_actions_activity_updated
  on pi_actions(updated_at desc, id desc);
create index if not exists idx_pi_actions_activity_source
  on pi_actions(source, updated_at desc, id desc);
create index if not exists idx_pi_action_events_conversation_type
  on pi_action_events(conversation_id, event_type, id desc);
create index if not exists idx_pi_action_events_conversation
  on pi_action_events(conversation_id, id desc);
create index if not exists idx_pi_action_events_issue
  on pi_action_events(issue_id, id desc);
create index if not exists idx_issue_runs_started_run_id
  on issue_runs(started_at desc, run_id asc);
create index if not exists idx_issues_activity_source_refs
  on issues(updated_at desc, id desc)
  where source_turn_id<>'' or source_excerpt<>'';
create index if not exists idx_pi_notification_intents_ready_digest
  on pi_notification_intents(created_at, flush_sequence, id)
  where kind='digest' and state='ready' and sent_outbox_id=0;
`
};
