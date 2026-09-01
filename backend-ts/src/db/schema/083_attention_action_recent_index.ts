import type { SqlMigration } from "../migrations.ts";

export const attentionActionRecentIndexMigration: SqlMigration = {
  id: "083_attention_action_recent_index",
  sql: `
create index if not exists idx_pi_actions_attention_recent
  on pi_actions(updated_at desc, id desc)
  where status in ('candidate', 'pending', 'approved', 'changes_requested', 'snoozed');
`
};
