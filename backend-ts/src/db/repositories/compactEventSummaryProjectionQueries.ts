import type { RunnerDatabase } from "../database.ts";
import {
  EVENT_SUMMARY_SOURCE,
  eventProjectionStatus,
  listEventSummaryProjection,
  type EventProjectionWatermark,
  type EventSummaryProjection,
  type EventSummaryProjectionFilter
} from "./eventSummaryProjection.ts";
import { projectSourceIssueEvent } from "../../events/eventSummaryProjector.ts";
import { compactWatermark, decodePayload } from "./compactEventSummaryProjectionDictionary.ts";
import { getEventSummaryProjectionSwitch, assertProjectionParity } from "./compactEventSummaryProjectionSwitch.ts";
import { type CompactRow, type EventSummaryProjectionSwitch } from "./compactEventSummaryProjectionModel.ts";

export function compactProjectionStatus(db: RunnerDatabase): EventProjectionWatermark & {
  lag_rows: number;
  source_last_event_id: number;
  source_of_truth: typeof EVENT_SUMMARY_SOURCE;
  status: "ready" | "lagging";
} {
  const watermark = compactWatermark(db);
  const sourceLastEventID = Number(db.sqlite.query<{ value: number }, []>(
    "select coalesce(max(id), 0) as value from issue_events"
  ).get()?.value ?? 0);
  const lagRows = Number(db.sqlite.query<{ value: number }, [number]>(
    "select count(*) as value from issue_events where id>?"
  ).get(watermark.last_event_id)?.value ?? 0);
  return {
    ...watermark,
    lag_rows: lagRows,
    source_last_event_id: sourceLastEventID,
    source_of_truth: EVENT_SUMMARY_SOURCE,
    status: lagRows === 0 ? "ready" : "lagging"
  };
}

export function eventProjectionStatusForRead(db: RunnerDatabase): ReturnType<typeof eventProjectionStatus> {
  return getEventSummaryProjectionSwitch(db).read_version === "v2"
    ? compactProjectionStatus(db)
    : eventProjectionStatus(db);
}

export function listCompactEventSummaryProjection(
  db: RunnerDatabase,
  filter: EventSummaryProjectionFilter = {}
): EventSummaryProjection[] {
  const query = compactListQuery(filter);
  const payloads = new Map<number, string>();
  const rows = db.sqlite.query<CompactRow, Array<number | string>>(query.sql)
    .all(...query.args)
    .map((row) => mapCompactRow(row, payloads));
  return query.reverseResult ? rows.reverse() : rows;
}

export function listEventSummaryProjectionForRead(
  db: RunnerDatabase,
  filter: EventSummaryProjectionFilter = {},
  now = new Date()
): EventSummaryProjection[] {
  const state = getEventSummaryProjectionSwitch(db);
  const legacy = state.read_version === "v1" || observationActive(state, now)
    ? listEventSummaryProjection(db, filter)
    : undefined;
  const compact = state.read_version === "v2" || observationActive(state, now)
    ? listCompactEventSummaryProjection(db, filter)
    : undefined;
  if (legacy && compact) assertProjectionParity(legacy, compact);
  return state.read_version === "v2" ? compact! : legacy!;
}

export function eventSummaryTypeCountsForRead(
  db: RunnerDatabase,
  now = new Date()
): Array<{ count: number; event_type: string }> {
  const state = getEventSummaryProjectionSwitch(db);
  const readLegacy = () => db.sqlite.query<{ count: number; event_type: string }, []>(`
    select event_type, count(*) as count from event_summary_projection
    group by event_type order by count desc, event_type asc
  `).all();
  const readCompact = () => db.sqlite.query<{ count: number; event_type: string }, []>(`
    select t.event_type, count(*) as count
    from event_summary_projection_compact c
    join event_summary_projection_types t on t.event_type_ref=c.event_type_ref
    group by t.event_type order by count desc, t.event_type asc
  `).all();
  const legacy = state.read_version === "v1" || observationActive(state, now) ? readLegacy() : undefined;
  const compact = state.read_version === "v2" || observationActive(state, now) ? readCompact() : undefined;
  if (legacy && compact && JSON.stringify(legacy) !== JSON.stringify(compact)) {
    throw new Error("event summary projection parity conflict: event type counts differ");
  }
  return state.read_version === "v2" ? compact! : legacy!;
}

function compactListQuery(filter: EventSummaryProjectionFilter) {
  const clauses = ["1=1"];
  const args: Array<number | string> = [];
  if (filter.issueID !== undefined) addIntegerFilter(clauses, args, "c.issue_id=?", filter.issueID);
  if (filter.projectID?.trim()) {
    clauses.push("pr.project_id=?");
    args.push(filter.projectID.trim());
  }
  const types = normalizedTypes(filter.types);
  const excluded = normalizedTypes(filter.excludeTypes);
  if (types.length > 0) addTypeFilter(clauses, args, "t.event_type", "in", types);
  if (excluded.length > 0) addTypeFilter(clauses, args, "t.event_type", "not in", excluded);
  if (filter.beforeID !== undefined) addIntegerFilter(clauses, args, "c.source_event_id<?", filter.beforeID);
  if (filter.afterID !== undefined) addIntegerFilter(clauses, args, "c.source_event_id>?", filter.afterID);
  if (filter.since && Number.isFinite(Date.parse(filter.since))) {
    clauses.push("julianday(c.event_created_at)>=julianday(?)"); args.push(filter.since);
  }
  if (filter.until && Number.isFinite(Date.parse(filter.until))) {
    clauses.push("julianday(c.event_created_at)<=julianday(?)"); args.push(filter.until);
  }
  const limit = normalizedLimit(filter.limit);
  const reverseResult = limit !== undefined && filter.afterID === undefined;
  const order = reverseResult ? "c.source_event_id desc" : "c.source_event_id asc";
  if (limit !== undefined) args.push(limit);
  return {
    args,
    reverseResult,
    sql: `select c.source_event_id, c.issue_id, c.payload_ref, pr.project_id, r.run_id,
      t.event_type, p.summary_payload, p.payload_codec, c.source_payload_bytes,
      c.source_sha256, c.event_created_at as created_at
      from event_summary_projection_compact c
      join event_summary_projection_projects pr on pr.project_ref=c.project_ref
      join event_summary_projection_runs r on r.run_ref=c.run_ref
      join event_summary_projection_types t on t.event_type_ref=c.event_type_ref
      join event_summary_projection_payloads p on p.payload_ref=c.payload_ref
      where ${clauses.join(" and ")}
      order by ${order}${limit === undefined ? "" : " limit ?"}`
  };
}

function mapCompactRow(row: CompactRow, payloads: Map<number, string>): EventSummaryProjection {
  const sourceHash = Buffer.from(row.source_sha256);
  if (sourceHash.byteLength !== 32) throw new Error("compact event summary source hash is invalid");
  const payloadRef = Number(row.payload_ref);
  let payload = payloads.get(payloadRef);
  if (payload === undefined) {
    payload = decodePayload(row.summary_payload, Number(row.payload_codec));
    payloads.set(payloadRef, payload);
  }
  const projected = projectSourceIssueEvent({
    created_at: String(row.created_at),
    event_type: String(row.event_type),
    id: Number(row.source_event_id),
    issue_id: Number(row.issue_id),
    payload,
    project_id: String(row.project_id),
    run_id: String(row.run_id)
  }, "");
  return {
    ...projected,
    projected_at: "",
    source_payload_bytes: Number(row.source_payload_bytes),
    source_sha256: sourceHash.toString("hex")
  };
}

function observationActive(state: EventSummaryProjectionSwitch, now: Date): boolean {
  if (!state.observation_started_at || !state.observation_expires_at) return false;
  const current = now.getTime();
  const started = Date.parse(state.observation_started_at);
  const expires = Date.parse(state.observation_expires_at);
  return Number.isFinite(started) && Number.isFinite(expires) && current >= started && current <= expires;
}

function addIntegerFilter(clauses: string[], args: Array<number | string>, sql: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("event projection cursor must be a positive integer");
  clauses.push(sql);
  args.push(value);
}

function addTypeFilter(
  clauses: string[],
  args: Array<number | string>,
  column: string,
  operator: "in" | "not in",
  values: string[]
): void {
  clauses.push(`${column} ${operator} (${values.map(() => "?").join(", ")})`);
  args.push(...values);
}

function normalizedTypes(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("事件摘要 limit 必须是 1 到 500 的整数");
  }
  return value;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
