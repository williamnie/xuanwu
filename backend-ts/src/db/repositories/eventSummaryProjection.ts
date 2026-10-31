import type { RunnerDatabase } from "../database.ts";
import {
  type SourceIssueEvent,
  type SourceIssueEventRow,
  mapSourceIssueEvent,
  type EventSummaryProjectionWrite,
  projectionValues,
  type EventProjectionWatermark,
  EVENT_SUMMARY_PROJECTION_ID,
  EVENT_SUMMARY_SOURCE,
  getEventProjectionWatermark
} from "./eventSummaryProjectionModel.ts";

export function listSourceIssueEvents(
  db: RunnerDatabase,
  input: { afterID: number; hydrateIssueLogs?: boolean; limit: number }
): SourceIssueEvent[] {
  return db.sqlite.query<SourceIssueEventRow, [number, number]>(`
    select e.id, e.issue_id, i.project_id, e.type as event_type, e.payload, e.created_at,
      case when legacy.source_event_id is not null then legacy.run_id else coalesce(r.id, '') end as run_id
    from issue_events e
    join issues i on i.id=e.issue_id
    left join event_summary_projection legacy
      on legacy.source='issue_events' and legacy.source_event_id=e.id
    left join issue_runs r on r.id=(
      select candidate.id from issue_runs candidate
      where candidate.issue_id=e.issue_id
        and julianday(candidate.started_at)<=julianday(e.created_at)
        and (candidate.ended_at='' or julianday(candidate.ended_at)>=julianday(e.created_at))
      order by julianday(candidate.started_at) desc, candidate.attempt desc limit 1
    )
    where e.id>? order by e.id asc limit ?
  `).all(input.afterID, input.limit).map((row) => mapSourceIssueEvent(db, row, input.hydrateIssueLogs !== false));
}

export function upsertEventSummaryProjection(db: RunnerDatabase, row: EventSummaryProjectionWrite): boolean {
  const values = projectionValues(row);
  const inserted = Number(db.sqlite.run(`
    insert into event_summary_projection (
      source, source_event_id, issue_id, project_id, run_id, event_type, raw_method,
      policy_id, retention_tier, summary, summary_payload, source_payload_bytes,
      source_sha256, summary_sha256, event_created_at, projected_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source, source_event_id) do nothing
  `, values).changes) > 0;
  if (inserted) return true;
  db.sqlite.run(`update event_summary_projection set
      issue_id=excluded.issue_id,
      project_id=excluded.project_id,
      run_id=excluded.run_id,
      event_type=excluded.event_type,
      raw_method=excluded.raw_method,
      policy_id=excluded.policy_id,
      retention_tier=excluded.retention_tier,
      summary=excluded.summary,
      summary_payload=excluded.summary_payload,
      source_payload_bytes=excluded.source_payload_bytes,
      source_sha256=excluded.source_sha256,
      summary_sha256=excluded.summary_sha256,
      event_created_at=excluded.event_created_at,
      projected_at=excluded.projected_at
    from (select
      ? as source, ? as source_event_id, ? as issue_id, ? as project_id, ? as run_id,
      ? as event_type, ? as raw_method, ? as policy_id, ? as retention_tier,
      ? as summary, ? as summary_payload, ? as source_payload_bytes, ? as source_sha256,
      ? as summary_sha256, ? as event_created_at, ? as projected_at
    ) as excluded
    where event_summary_projection.source=excluded.source
      and event_summary_projection.source_event_id=excluded.source_event_id
      and (event_summary_projection.source_sha256<>excluded.source_sha256
        or event_summary_projection.summary_sha256<>excluded.summary_sha256)
  `, values);
  return false;
}

export function saveEventProjectionWatermark(
  db: RunnerDatabase,
  input: { lastEventID: number; projectedRowCount: number; projectorVersion: string; updatedAt: string }
): EventProjectionWatermark {
  db.sqlite.run(`
    insert into event_projection_watermarks (
      projection_id, source, projector_version, last_event_id, projected_row_count, updated_at
    ) values (?, ?, ?, ?, ?, ?)
    on conflict(projection_id) do update set
      source=excluded.source,
      projector_version=excluded.projector_version,
      last_event_id=excluded.last_event_id,
      projected_row_count=excluded.projected_row_count,
      updated_at=excluded.updated_at
  `, [
    EVENT_SUMMARY_PROJECTION_ID,
    EVENT_SUMMARY_SOURCE,
    input.projectorVersion,
    input.lastEventID,
    input.projectedRowCount,
    input.updatedAt
  ]);
  return getEventProjectionWatermark(db);
}

export function clearEventSummaryProjection(db: RunnerDatabase, projectorVersion: string, at: string): void {
  const clear = db.transaction(() => {
    db.sqlite.run("delete from event_summary_projection");
    db.sqlite.run("delete from event_projection_watermarks where projection_id=?", [EVENT_SUMMARY_PROJECTION_ID]);
    saveEventProjectionWatermark(db, {
      lastEventID: 0,
      projectedRowCount: 0,
      projectorVersion,
      updatedAt: at
    });
  });
  clear.immediate();
}

export { EVENT_SUMMARY_SOURCE } from "./eventSummaryProjectionModel.ts";
export type { SourceIssueEvent } from "./eventSummaryProjectionModel.ts";
export type { EventSummaryProjectionWrite } from "./eventSummaryProjectionModel.ts";
export type { EventSummaryProjection } from "./eventSummaryProjectionModel.ts";
export type { EventProjectionWatermark } from "./eventSummaryProjectionModel.ts";
export type { EventSummaryProjectionFilter } from "./eventSummaryProjectionModel.ts";
export { getEventProjectionWatermark } from "./eventSummaryProjectionModel.ts";
export { listEventSummaryProjection } from "./eventSummaryProjectionQueries.ts";
export { eventProjectionStatus } from "./eventSummaryProjectionQueries.ts";
export { currentEventSummaryProjectionRowCount } from "./eventSummaryProjectionModel.ts";
