import type { RunnerDatabase } from "../database.ts";

export const EVENT_SUMMARY_PROJECTION_ID = "issue_events_summary_v1";
export const EVENT_SUMMARY_SOURCE = "issue_events";

export type SourceIssueEvent = {
  created_at: string;
  event_type: string;
  id: number;
  issue_id: number;
  payload: string;
  project_id: string;
  run_id: string;
};

export type EventSummaryProjectionWrite = {
  event_created_at: string;
  event_type: string;
  issue_id: number;
  policy_id: string;
  project_id: string;
  projected_at: string;
  raw_method: string;
  retention_tier: string;
  run_id: string;
  source: typeof EVENT_SUMMARY_SOURCE;
  source_event_id: number;
  source_payload_bytes: number;
  source_sha256: string;
  summary: string;
  summary_payload: string;
  summary_sha256: string;
};

export type EventSummaryProjection = EventSummaryProjectionWrite;

export type EventProjectionWatermark = {
  last_event_id: number;
  projected_row_count: number;
  projection_id: string;
  projector_version: string;
  source: string;
  updated_at: string;
};

export type EventSummaryProjectionFilter = {
  afterID?: number;
  beforeID?: number;
  excludeTypes?: string[];
  issueID?: number;
  limit?: number;
  projectID?: string;
  types?: string[];
};

type SourceIssueEventRow = Record<keyof SourceIssueEvent, unknown>;
type EventSummaryProjectionRow = Record<keyof EventSummaryProjection, unknown>;
type EventProjectionWatermarkRow = Record<keyof EventProjectionWatermark, unknown>;

export function listSourceIssueEvents(
  db: RunnerDatabase,
  input: { afterID: number; limit: number }
): SourceIssueEvent[] {
  return db.sqlite.query<SourceIssueEventRow, [number, number]>(`
    select e.id, e.issue_id, i.project_id, e.type as event_type, e.payload, e.created_at,
      coalesce(r.id, '') as run_id
    from issue_events e
    join issues i on i.id=e.issue_id
    left join issue_runs r on r.id=(
      select candidate.id from issue_runs candidate
      where candidate.issue_id=e.issue_id and candidate.started_at<=e.created_at
        and (candidate.ended_at='' or candidate.ended_at>=e.created_at)
      order by candidate.started_at desc, candidate.attempt desc limit 1
    )
    where e.id>? order by e.id asc limit ?
  `).all(input.afterID, input.limit).map(mapSourceIssueEvent);
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

function projectionValues(row: EventSummaryProjectionWrite): Array<number | string> {
  return [
    row.source,
    row.source_event_id,
    row.issue_id,
    row.project_id,
    row.run_id,
    row.event_type,
    row.raw_method,
    row.policy_id,
    row.retention_tier,
    row.summary,
    row.summary_payload,
    row.source_payload_bytes,
    row.source_sha256,
    row.summary_sha256,
    row.event_created_at,
    row.projected_at
  ];
}

export function getEventProjectionWatermark(db: RunnerDatabase): EventProjectionWatermark {
  const row = db.sqlite.query<EventProjectionWatermarkRow, [string]>(`
    select projection_id, source, projector_version, last_event_id, projected_row_count, updated_at
    from event_projection_watermarks where projection_id=?
  `).get(EVENT_SUMMARY_PROJECTION_ID);
  return row ? mapWatermark(row) : emptyWatermark();
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

function projectedRowCount(db: RunnerDatabase): number {
  return scalarCount(db, "select count(*) as count from event_summary_projection where source='issue_events'");
}

export function currentEventSummaryProjectionRowCount(db: RunnerDatabase): number {
  return projectedRowCount(db);
}

function scalarCount(db: RunnerDatabase, sql: string): number {
  return db.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

function emptyWatermark(): EventProjectionWatermark {
  return {
    last_event_id: 0,
    projected_row_count: 0,
    projection_id: EVENT_SUMMARY_PROJECTION_ID,
    projector_version: "",
    source: EVENT_SUMMARY_SOURCE,
    updated_at: ""
  };
}

function mapSourceIssueEvent(row: SourceIssueEventRow): SourceIssueEvent {
  return {
    id: positiveInteger(row.id, "issue_events.id"),
    issue_id: positiveInteger(row.issue_id, "issue_events.issue_id"),
    project_id: requiredText(row.project_id, "issues.project_id"),
    run_id: optionalText(row.run_id),
    event_type: requiredText(row.event_type, "issue_events.type"),
    payload: optionalText(row.payload),
    created_at: requiredText(row.created_at, "issue_events.created_at")
  };
}

function mapProjectionRow(row: EventSummaryProjectionRow): EventSummaryProjection {
  return {
    source: requiredText(row.source, "event_summary_projection.source") as typeof EVENT_SUMMARY_SOURCE,
    source_event_id: positiveInteger(row.source_event_id, "event_summary_projection.source_event_id"),
    issue_id: positiveInteger(row.issue_id, "event_summary_projection.issue_id"),
    project_id: requiredText(row.project_id, "event_summary_projection.project_id"),
    run_id: optionalText(row.run_id),
    event_type: requiredText(row.event_type, "event_summary_projection.event_type"),
    raw_method: optionalText(row.raw_method),
    policy_id: requiredText(row.policy_id, "event_summary_projection.policy_id"),
    retention_tier: requiredText(row.retention_tier, "event_summary_projection.retention_tier"),
    summary: optionalText(row.summary),
    summary_payload: optionalText(row.summary_payload),
    source_payload_bytes: nonNegativeInteger(row.source_payload_bytes, "event_summary_projection.source_payload_bytes"),
    source_sha256: requiredText(row.source_sha256, "event_summary_projection.source_sha256"),
    summary_sha256: requiredText(row.summary_sha256, "event_summary_projection.summary_sha256"),
    event_created_at: requiredText(row.event_created_at, "event_summary_projection.event_created_at"),
    projected_at: requiredText(row.projected_at, "event_summary_projection.projected_at")
  };
}

function mapWatermark(row: EventProjectionWatermarkRow): EventProjectionWatermark {
  return {
    projection_id: requiredText(row.projection_id, "event_projection_watermarks.projection_id"),
    source: requiredText(row.source, "event_projection_watermarks.source"),
    projector_version: requiredText(row.projector_version, "event_projection_watermarks.projector_version"),
    last_event_id: nonNegativeInteger(row.last_event_id, "event_projection_watermarks.last_event_id"),
    projected_row_count: nonNegativeInteger(row.projected_row_count, "event_projection_watermarks.projected_row_count"),
    updated_at: requiredText(row.updated_at, "event_projection_watermarks.updated_at")
  };
}

function positiveInteger(value: unknown, label: string): number {
  const integer = nonNegativeInteger(value, label);
  if (integer <= 0) throw new Error(`${label} must be positive`);
  return integer;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function optionalText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("event projection row value must be a string");
  return value;
}
