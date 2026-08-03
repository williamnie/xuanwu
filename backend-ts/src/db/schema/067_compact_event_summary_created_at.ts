import type { SqlMigration } from "../migrations.ts";

/**
 * Compact summaries must remain readable after their raw issue_events rows move
 * to cold archive. Keep the event timestamp in the compact row instead of
 * joining the hot source table at read time.
 */
export const compactEventSummaryCreatedAtMigration: SqlMigration = {
  id: "067_compact_event_summary_created_at",
  sql: `
alter table event_summary_projection_compact
  add column event_created_at text not null default '';

update event_summary_projection_compact
set event_created_at=coalesce((
  select created_at from issue_events
  where issue_events.id=event_summary_projection_compact.source_event_id
), '')
where event_created_at='';
`
};
