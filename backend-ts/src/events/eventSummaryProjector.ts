import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import {
  EVENT_SUMMARY_SOURCE,
  currentEventSummaryProjectionRowCount,
  getEventProjectionWatermark,
  listSourceIssueEvents,
  saveEventProjectionWatermark,
  upsertEventSummaryProjection,
  type EventProjectionWatermark,
  type EventSummaryProjectionWrite,
  type SourceIssueEvent
} from "../db/repositories/eventSummaryProjection.ts";
import { classifyEventRetention } from "./retentionPolicy.ts";

export const EVENT_SUMMARY_PROJECTOR_VERSION = "xuanwu.event-summary-projector.v1" as const;
export const EVENT_SUMMARY_QUERY_SCHEMA_VERSION = "xuanwu.event-summary-query.v1" as const;

const DEFAULT_BATCH_SIZE = 500;
const LOG_SUMMARY_FIELD_LIMIT = 16 * 1024;
const SUMMARY_TEXT_LIMIT = 1000;
const LOG_FIELDS = ["type", "provider", "raw_method", "text", "command", "path", "status", "error"] as const;

export type EventSummaryProjectionRun = {
  batches: number;
  paused: boolean;
  projected_rows: number;
  source: typeof EVENT_SUMMARY_SOURCE;
  source_of_truth: typeof EVENT_SUMMARY_SOURCE;
  watermark: EventProjectionWatermark;
};

export function projectPendingEventSummaries(
  db: RunnerDatabase,
  options: { batchSize?: number; maxBatches?: number } = {}
): EventSummaryProjectionRun {
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatches = options.maxBatches === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInteger(options.maxBatches, "maxBatches");
  let watermark = getEventProjectionWatermark(db);
  if (watermark.projector_version === "") {
    watermark = saveEventProjectionWatermark(db, {
      lastEventID: 0,
      projectedRowCount: 0,
      projectorVersion: EVENT_SUMMARY_PROJECTOR_VERSION,
      updatedAt: new Date().toISOString()
    });
  } else if (watermark.projector_version !== EVENT_SUMMARY_PROJECTOR_VERSION) {
    throw new Error(`event summary projection version mismatch: ${watermark.projector_version}; rebuild required`);
  }
  let batches = 0;
  let projectedRows = 0;
  let projectedRowCount = watermark.projected_row_count;
  while (batches < maxBatches) {
    const rows = listSourceIssueEvents(db, { afterID: watermark.last_event_id, limit: batchSize });
    if (rows.length === 0) break;
    if (batches === 0) projectedRowCount = currentEventSummaryProjectionRowCount(db);
    const projectedAt = new Date().toISOString();
    const writeBatch = db.transaction(() => {
      for (const row of rows) {
        if (upsertEventSummaryProjection(db, projectSourceIssueEvent(row, projectedAt))) projectedRowCount += 1;
      }
      watermark = saveEventProjectionWatermark(db, {
        lastEventID: rows.at(-1)!.id,
        projectedRowCount,
        projectorVersion: EVENT_SUMMARY_PROJECTOR_VERSION,
        updatedAt: projectedAt
      });
    });
    writeBatch.immediate();
    batches += 1;
    projectedRows += rows.length;
  }
  const paused = listSourceIssueEvents(db, { afterID: watermark.last_event_id, limit: 1 }).length > 0;
  return {
    batches,
    paused,
    projected_rows: projectedRows,
    source: EVENT_SUMMARY_SOURCE,
    source_of_truth: EVENT_SUMMARY_SOURCE,
    watermark
  };
}

export function projectSourceIssueEvent(row: SourceIssueEvent, projectedAt: string): EventSummaryProjectionWrite {
  const body = jsonObject(row.payload);
  const rawMethod = text(body.raw_method);
  const classification = classifyEventRetention({
    event_type: row.event_type,
    raw_method: rawMethod,
    source: EVENT_SUMMARY_SOURCE
  });
  const summaryPayload = row.event_type === "issue.log" ? logSummaryPayload(body, row.payload) : row.payload;
  const sourceHashInput = JSON.stringify({
    created_at: row.created_at,
    event_type: row.event_type,
    id: row.id,
    issue_id: row.issue_id,
    payload: row.payload,
    project_id: row.project_id,
    run_id: row.run_id
  });
  const summaryHashInput = JSON.stringify({
    event_type: row.event_type,
    policy_id: classification.policy_id,
    raw_method: rawMethod,
    retention_tier: classification.tier,
    summary_payload: summaryPayload
  });
  return {
    source: EVENT_SUMMARY_SOURCE,
    source_event_id: row.id,
    issue_id: row.issue_id,
    project_id: row.project_id,
    run_id: row.run_id,
    event_type: row.event_type,
    raw_method: rawMethod,
    policy_id: classification.policy_id,
    retention_tier: classification.tier,
    summary: eventSummary(row.event_type, body, summaryPayload),
    summary_payload: summaryPayload,
    source_payload_bytes: Buffer.byteLength(row.payload),
    source_sha256: sha256(sourceHashInput),
    summary_sha256: sha256(summaryHashInput),
    event_created_at: row.created_at,
    projected_at: projectedAt
  };
}

function logSummaryPayload(body: Record<string, unknown>, fallback: string): string {
  const summary = Object.fromEntries(LOG_FIELDS.flatMap((field) => {
    const value = boundedText(body[field], LOG_SUMMARY_FIELD_LIMIT);
    return value ? [[field, value]] : [];
  }));
  if (Object.keys(summary).length > 0) return JSON.stringify(summary);
  return JSON.stringify({ text: boundedText(fallback, LOG_SUMMARY_FIELD_LIMIT) });
}

function eventSummary(eventType: string, body: Record<string, unknown>, summaryPayload: string): string {
  const candidate = [body.error, body.status, body.body, body.reason, body.text, body.command, body.raw_method, body.type]
    .map(text)
    .find(Boolean);
  return boundedText(candidate || (eventType === "issue.log" ? summaryPayload : compactJson(summaryPayload)), SUMMARY_TEXT_LIMIT);
}

function compactJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedText(value: unknown, maximum: number): string {
  const input = typeof value === "string" ? value : "";
  if (Buffer.byteLength(input) <= maximum) return input;
  let end = Math.min(input.length, maximum);
  while (end > 0 && Buffer.byteLength(input.slice(0, end)) > maximum) end -= 1;
  return input.slice(0, end);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
