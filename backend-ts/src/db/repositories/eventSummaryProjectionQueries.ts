import type { RunnerDatabase } from "../database.ts";
import {
  type EventSummaryProjectionFilter,
  type EventSummaryProjection,
  type EventSummaryProjectionRow,
  mapProjectionRow,
  type EventProjectionWatermark,
  EVENT_SUMMARY_SOURCE,
  getEventProjectionWatermark,
  projectedRowCount,
  scalarCount,
  addIntegerFilter,
  normalizedTypes,
  addTypeFilter,
  normalizedLimit
} from "./eventSummaryProjectionModel.ts";

export function listEventSummaryProjection(
  db: RunnerDatabase,
  filter: EventSummaryProjectionFilter = {}
): EventSummaryProjection[] {
  const query = projectionListQuery(filter);
  const rows = db.sqlite.query<EventSummaryProjectionRow, Array<number | string>>(query.sql)
    .all(...query.args)
    .map(mapProjectionRow);
  return query.reverseResult ? rows.reverse() : rows;
}

export function eventProjectionStatus(db: RunnerDatabase): EventProjectionWatermark & {
  lag_rows: number;
  source_last_event_id: number;
  source_of_truth: typeof EVENT_SUMMARY_SOURCE;
  status: "ready" | "lagging";
} {
  const watermark = getEventProjectionWatermark(db);
  const projectionRows = projectedRowCount(db);
  const sourceLastEventID = scalarCount(db, "select coalesce(max(id), 0) as count from issue_events");
  const lagRows = db.sqlite.query<{ count: number }, [number]>(
    "select count(*) as count from issue_events where id>?"
  ).get(watermark.last_event_id)?.count ?? 0;
  return {
    ...watermark,
    projected_row_count: projectionRows,
    lag_rows: lagRows,
    source_last_event_id: sourceLastEventID,
    source_of_truth: EVENT_SUMMARY_SOURCE,
    status: lagRows === 0 ? "ready" : "lagging"
  };
}

function projectionListQuery(filter: EventSummaryProjectionFilter) {
  const clauses = ["source = ?"];
  const args: Array<number | string> = [EVENT_SUMMARY_SOURCE];
  if (filter.issueID !== undefined) addIntegerFilter(clauses, args, "issue_id = ?", filter.issueID);
  if (filter.projectID?.trim()) {
    clauses.push("project_id = ?");
    args.push(filter.projectID.trim());
  }
  const types = normalizedTypes(filter.types);
  const excluded = normalizedTypes(filter.excludeTypes);
  if (types.length > 0) addTypeFilter(clauses, args, "event_type", "in", types);
  if (excluded.length > 0) addTypeFilter(clauses, args, "event_type", "not in", excluded);
  if (filter.beforeID !== undefined) addIntegerFilter(clauses, args, "source_event_id < ?", filter.beforeID);
  if (filter.afterID !== undefined) addIntegerFilter(clauses, args, "source_event_id > ?", filter.afterID);
  if (filter.since && Number.isFinite(Date.parse(filter.since))) {
    clauses.push("julianday(event_created_at)>=julianday(?)"); args.push(filter.since);
  }
  if (filter.until && Number.isFinite(Date.parse(filter.until))) {
    clauses.push("julianday(event_created_at)<=julianday(?)"); args.push(filter.until);
  }
  const limit = normalizedLimit(filter.limit);
  const reverseResult = limit !== undefined && filter.afterID === undefined;
  const order = reverseResult ? "source_event_id desc" : "source_event_id asc";
  if (limit !== undefined) args.push(limit);
  return {
    args,
    reverseResult,
    sql: `select source, source_event_id, issue_id, project_id, run_id, event_type, raw_method,
      policy_id, retention_tier, summary, summary_payload, source_payload_bytes,
      source_sha256, summary_sha256, event_created_at, projected_at
      from event_summary_projection where ${clauses.join(" and ")}
      order by ${order}${limit === undefined ? "" : " limit ?"}`
  };
}
