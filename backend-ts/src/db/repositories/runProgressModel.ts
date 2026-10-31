import { type NormalizedRunEvent } from "../../providers/types.ts";
import {
  RUN_PROGRESS_PROJECTOR_VERSION,
  type RunProgressLatest,
  type RunProgressPhase,
  type RunProgressPhaseSummary,
  type RunProgressSourceEvent,
  type RunProgressTimelineItem
} from "../../events/runProgressProjector.ts";
import { cleanString } from "../../util/values.ts";

export const RUN_PROGRESS_STALLED_AFTER_MS = 15 * 60 * 1000;

export const RUN_PROGRESS_SOURCE_EVENT_LIMIT = 5000;

export const RUN_PROGRESS_STATUS_RUN_LIMIT = 32;

export type RunProgressStalledSignal = {
  detected: boolean;
  evaluated_at: string;
  reason: "" | "no_progress_for_threshold" | "waiting_approval";
  since: string;
  threshold_ms: number;
};

export type RunProgressProjection = {
  invalid_event_count: number;
  latest: RunProgressLatest | null;
  phase_summary: RunProgressPhaseSummary[];
  projected_by: typeof RUN_PROGRESS_PROJECTOR_VERSION;
  projection_mode: "list_summary" | "read_through_rebuild";
  provider_phase: RunProgressPhase;
  replay: {
    duplicate_event_count: number;
    ignored_event_count: number;
    source_event_count: number;
    source_event_truncated: boolean;
    timeline_truncated: number;
    unique_event_count: number;
    unmapped_event_count: number;
  };
  source_event_range: { first_id: number; last_id: number } | null;
  source_of_truth: "issue_runs+run_attempts+issue_events";
  stalled: RunProgressStalledSignal;
  timeline: RunProgressTimelineItem[];
  updated_at: string;
};

export type RunProjectionRow = {
  ended_at: string;
  issue_id: number;
  legacy_id: string;
  legacy_status: string;
  run_id: string;
  run_sequence: number;
  started_at: string;
};

export type AttemptProjectionRow = {
  agent_session_key: string | null;
  attempt_id: string;
  ended_at: string;
  kind: string;
  provider: string;
  provider_session_id: string;
  provider_turn_id: string;
  sequence: number;
  started_at: string;
  status: string | null;
  updated_at: string;
};

export type EventRow = { created_at: string; id: number; payload: string };

export type ParsedEvents = {
  events: RunProgressSourceEvent[];
  firstID: number;
  invalid: number;
  lastID: number;
  sourceCount: number;
  sourceTruncated: boolean;
  unmapped: number;
};

export function eventSummary(payload: Record<string, unknown>, event: NormalizedRunEvent): string {
  return [payload.error, payload.status, payload.text, payload.command, payload.raw_method, payload.type]
    .map(cleanString)
    .find(Boolean) || event.source.method;
}

export function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function compareTimeline(left: RunProgressTimelineItem, right: RunProgressTimelineItem): number {
  const time = timestamp(left.occurred_at) - timestamp(right.occurred_at);
  if (time !== 0) return time;
  return left.source_event_id - right.source_event_id;
}

export function earliestTimestamp(...values: string[]): string {
  return values.filter(Boolean).sort((left, right) => timestamp(left) - timestamp(right))[0] ?? "";
}

export function latestTimestamp(...values: string[]): string {
  return values.filter(Boolean).sort((left, right) => timestamp(left) - timestamp(right)).at(-1) ?? "";
}

export function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
