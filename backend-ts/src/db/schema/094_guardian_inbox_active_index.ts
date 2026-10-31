import type { SqlMigration } from "../migrations.ts";

export const GUARDIAN_INBOX_ACTIVE_INDEX = "idx_pi_guardian_event_active";

/** 热路径只访问活跃事件；已消费的审计历史不参与索引统计和读取。 */
export const guardianInboxActiveIndexMigration: SqlMigration = {
  id: "094_guardian_inbox_active_index",
  sql: `
create index if not exists ${GUARDIAN_INBOX_ACTIVE_INDEX}
  on pi_guardian_event_inbox(status, sequence_id, project_id, created_at)
  where status='pending' or status='leased';
`
};
