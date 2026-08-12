import type { SqlMigration } from "../migrations.ts";

/** Keep the 30-second control-plane sweeps on narrow, ordered access paths. */
export const schedulerPerformanceIndexesMigration: SqlMigration = {
  id: "079_scheduler_performance_indexes",
  sql: `
create index if not exists idx_pi_actions_pending_notification
  on pi_actions(status, action_type, created_at, id);

create index if not exists idx_pi_actions_pending_mcp_expiry
  on pi_actions(lease_expires_at, id)
  where status='pending' and action_type='mcp.tool.call' and lease_expires_at<>'';

create index if not exists idx_pi_notification_intents_kind_source
  on pi_notification_intents(kind, source_event_id, created_at, id);

create index if not exists idx_agent_sessions_issue_updated
  on agent_sessions(issue_id, updated_at desc, session_key);
`
};
