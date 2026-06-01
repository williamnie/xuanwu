import type { SqlMigration } from "../migrations.ts";

export const readPerformanceIndexesMigration: SqlMigration = {
  id: "005_read_performance_indexes",
  sql: `
create index if not exists idx_issue_events_issue_type
  on issue_events(issue_id, type);
`
};
