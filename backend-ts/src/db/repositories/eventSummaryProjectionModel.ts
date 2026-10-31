import type { RunnerDatabase } from "../database.ts";
import { hydrateStoredIssueLogPayload } from "./issueEvents.ts";

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
  since?: string;
  types?: string[];
  until?: string;
};

export type SourceIssueEventRow = Record<keyof SourceIssueEvent, unknown>;

export type EventSummaryProjectionRow = Record<keyof EventSummaryProjection, unknown>;

type EventProjectionWatermarkRow = Record<keyof EventProjectionWatermark, unknown>;

export function projectionValues(row: EventSummaryProjectionWrite): Array<number | string> {
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

export function addIntegerFilter(clauses: string[], args: Array<number | string>, sql: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("event projection cursor must be a positive integer");
  clauses.push(sql);
  args.push(value);
}

export function addTypeFilter(
  clauses: string[],
  args: Array<number | string>,
  column: string,
  operator: "in" | "not in",
  values: string[]
): void {
  clauses.push(`${column} ${operator} (${values.map(() => "?").join(", ")})`);
  args.push(...values);
}

export function normalizedTypes(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizedLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("事件摘要 limit 必须是 1 到 500 的整数");
  }
  return value;
}

export function projectedRowCount(db: RunnerDatabase): number {
  return scalarCount(db, "select count(*) as count from event_summary_projection where source='issue_events'");
}

export function currentEventSummaryProjectionRowCount(db: RunnerDatabase): number {
  return projectedRowCount(db);
}

export function scalarCount(db: RunnerDatabase, sql: string): number {
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

export function mapSourceIssueEvent(db: RunnerDatabase, row: SourceIssueEventRow, hydrateIssueLogs: boolean): SourceIssueEvent {
  const eventType = requiredText(row.event_type, "issue_events.type");
  const storedPayload = optionalText(row.payload);
  return {
    id: positiveInteger(row.id, "issue_events.id"),
    issue_id: positiveInteger(row.issue_id, "issue_events.issue_id"),
    project_id: requiredText(row.project_id, "issues.project_id"),
    run_id: optionalText(row.run_id),
    event_type: eventType,
    payload: hydrateIssueLogs && eventType === "issue.log" ? hydrateStoredIssueLogPayload(db, storedPayload) : storedPayload,
    created_at: requiredText(row.created_at, "issue_events.created_at")
  };
}

export function mapProjectionRow(row: EventSummaryProjectionRow): EventSummaryProjection {
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
