import type { RunnerDatabase } from "../database.ts";
import {
  ATTEMPT_STATUSES,
  RUN_STATUSES,
  type AttemptStatus,
  type RunID,
  type RunStatus
} from "../../domain/run/contracts.ts";
import {
  NORMALIZED_RUN_EVENT_CONTRACT,
  type NormalizedRunEvent
} from "../../providers/types.ts";
import { validateNormalizedRunEvent } from "../../providers/runEvents.ts";
import {
  RUN_PROGRESS_PROJECTOR_VERSION,
  RUN_PROGRESS_TIMELINE_LIMIT,
  projectRunAttemptProgress,
  type RunProgressLatest,
  type RunProgressPhase,
  type RunProgressPhaseSummary,
  type RunProgressSourceEvent,
  type RunProgressTimelineItem
} from "../../events/runProgressProjector.ts";

export const RUN_PROGRESS_STALLED_AFTER_MS = 15 * 60 * 1000;

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

type RunProjectionRow = {
  ended_at: string;
  issue_id: number;
  legacy_id: string;
  legacy_status: string;
  run_id: string;
  run_sequence: number;
  started_at: string;
};

type AttemptProjectionRow = {
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

type EventRow = { created_at: string; id: number; payload: string };

type ParsedEvents = {
  events: RunProgressSourceEvent[];
  firstID: number;
  invalid: number;
  lastID: number;
  sourceCount: number;
  unmapped: number;
};

export function rebuildRunProgressProjection(
  db: RunnerDatabase,
  runID: RunID,
  options: { now?: Date; stalledAfterMs?: number; timelineLimit?: number } = {}
): RunProgressProjection | null {
  const run = projectionRun(db, runID);
  if (!run) return null;
  const attempts = projectionAttempts(db, run.legacy_id);
  const rows = projectionEventRows(db, run);
  const parsed = parseProjectionEvents(rows, attempts);
  const timelineLimit = nonNegativeInteger(options.timelineLimit ?? RUN_PROGRESS_TIMELINE_LIMIT, "timelineLimit");
  const projections = attempts.map((attempt) => projectRunAttemptProgress({
    events: parsed.events.filter((event) => event.attempt_id === attempt.attempt_id),
    initialPhase: attemptInitialPhase(run, attempt),
    timelineLimit
  }));
  const latestAttempt = attempts.at(-1);
  const latestProjection = projections.at(-1);
  const combinedTimeline = projections.flatMap((projection) => projection.timeline).sort(compareTimeline);
  const combinedTruncated = Math.max(0, combinedTimeline.length - timelineLimit);
  const timeline = timelineLimit === 0 ? [] : combinedTimeline.slice(-timelineLimit);
  const latest = latestProjection?.latest ?? null;
  const providerPhase = latestProjection?.current_phase ?? runInitialPhase(run, latestAttempt);
  const updatedAt = latestActivityAt(db, run, latestAttempt, latest?.occurred_at ?? "");
  const now = options.now ?? new Date();
  const stalledAfterMs = positiveInteger(options.stalledAfterMs ?? RUN_PROGRESS_STALLED_AFTER_MS, "stalledAfterMs");

  return {
    invalid_event_count: parsed.invalid,
    latest,
    phase_summary: projections.flatMap((projection) => projection.phase_summary),
    projected_by: RUN_PROGRESS_PROJECTOR_VERSION,
    projection_mode: "read_through_rebuild",
    provider_phase: providerPhase,
    replay: {
      duplicate_event_count: sum(projections.map((projection) => projection.duplicate_event_count)),
      ignored_event_count: sum(projections.map((projection) => projection.ignored_event_count)),
      source_event_count: parsed.sourceCount,
      timeline_truncated: sum(projections.map((projection) => projection.timeline_truncated)) + combinedTruncated,
      unique_event_count: sum(projections.map((projection) => projection.unique_event_count)),
      unmapped_event_count: parsed.unmapped
    },
    source_event_range: parsed.firstID > 0 ? { first_id: parsed.firstID, last_id: parsed.lastID } : null,
    source_of_truth: "issue_runs+run_attempts+issue_events",
    stalled: stalledSignal(authoritativeRunPhase(run, latestAttempt), providerPhase, updatedAt, now, stalledAfterMs),
    timeline,
    updated_at: updatedAt
  };
}

export function runProgressProjectionStatus(db: RunnerDatabase, now = new Date()): Record<string, unknown> {
  const runIDs = db.sqlite.query<{ run_id: string }, []>(`
    select run_id from issue_runs where status='in_progress' order by started_at asc, id asc
  `).all().map((row) => row.run_id as RunID);
  const projections = runIDs.flatMap((runID) => {
    const projection = rebuildRunProgressProjection(db, runID, { now, timelineLimit: 0 });
    return projection ? [projection] : [];
  });
  return {
    active_runs: runIDs.length,
    latest_source_event_id: db.sqlite.query<{ id: number }, []>(`
      select coalesce(max(id), 0) as id from issue_events
      where type='issue.log' and json_valid(payload)
        and json_extract(payload, '$.run_event.contract')='${NORMALIZED_RUN_EVENT_CONTRACT}'
    `).get()?.id ?? 0,
    projection_id: "run_progress_read_projection_v1",
    projection_mode: "read_through_rebuild",
    projector_version: RUN_PROGRESS_PROJECTOR_VERSION,
    source_of_truth: "issue_runs+run_attempts+issue_events",
    stalled_runs: projections.filter((projection) => projection.stalled.detected).length,
    status: "ready",
    waiting_approval_runs: projections.filter((projection) => projection.provider_phase === "waiting_approval").length
  };
}

export function authoritativeRunPhase(run: RunProjectionRow, latest: AttemptProjectionRow | undefined): RunStatus | null {
  const status = run.legacy_status === "in_progress" && latest?.kind === "recovery" &&
    ["created", "failed", "interrupted"].includes(latest.status ?? "")
    ? "recovering"
    : run.legacy_status === "in_progress" ? "running"
      : ["pending_verification", "done"].includes(run.legacy_status) ? "succeeded"
        : ["failed", "cancelled"].includes(run.legacy_status) ? run.legacy_status
          : null;
  return RUN_STATUSES.includes(status as RunStatus) ? status as RunStatus : null;
}

function projectionRun(db: RunnerDatabase, runID: RunID): RunProjectionRow | null {
  return db.sqlite.query<RunProjectionRow, [string]>(`
    select id as legacy_id, run_id, issue_id, attempt as run_sequence,
      status as legacy_status, started_at, ended_at
    from issue_runs where run_id=?
  `).get(runID);
}

function projectionAttempts(db: RunnerDatabase, legacyID: string): AttemptProjectionRow[] {
  return db.sqlite.query<AttemptProjectionRow, [string]>(`
    select attempt_id, sequence, kind, status, provider, provider_session_id,
      provider_turn_id, agent_session_key, started_at, ended_at, updated_at
    from run_attempts where issue_run_id=? order by sequence asc
  `).all(legacyID);
}

function projectionEventRows(db: RunnerDatabase, run: RunProjectionRow): EventRow[] {
  const nextStartedAt = db.sqlite.query<{ started_at: string }, [number, number]>(`
    select started_at from issue_runs where issue_id=? and attempt>?
    order by attempt asc limit 1
  `).get(run.issue_id, run.run_sequence)?.started_at ?? "";
  const upperBound = earliestTimestamp(run.ended_at, nextStartedAt);
  return db.sqlite.query<EventRow, [number, string, string, string]>(`
    select id, payload, created_at from issue_events
    where issue_id=? and type='issue.log' and julianday(created_at)>=julianday(?)
      and (?='' or julianday(created_at)<=julianday(?))
      and json_valid(payload)
      and json_extract(payload, '$.run_event.contract')='${NORMALIZED_RUN_EVENT_CONTRACT}'
    order by created_at asc, id asc
  `).all(run.issue_id, run.started_at, upperBound, upperBound);
}

function parseProjectionEvents(rows: EventRow[], attempts: AttemptProjectionRow[]): ParsedEvents {
  const result: ParsedEvents = { events: [], firstID: 0, invalid: 0, lastID: 0, sourceCount: rows.length, unmapped: 0 };
  for (const row of rows) {
    if (result.firstID === 0) result.firstID = row.id;
    result.lastID = row.id;
    const payload = jsonObject(row.payload);
    const event = normalizedEvent(payload.run_event);
    if (!event) {
      result.invalid += 1;
      continue;
    }
    const attempt = eventAttempt(event, row.created_at, attempts);
    if (!attempt) {
      result.unmapped += 1;
      continue;
    }
    result.events.push({
      attempt_id: attempt.attempt_id,
      attempt_sequence: attempt.sequence,
      event,
      occurred_at: row.created_at,
      source_event_id: row.id,
      summary: eventSummary(payload, event)
    });
  }
  return result;
}

function normalizedEvent(value: unknown): NormalizedRunEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as NormalizedRunEvent;
  try {
    if (event.contract !== NORMALIZED_RUN_EVENT_CONTRACT || !event.metadata || !event.source) return null;
    return validateNormalizedRunEvent(event).length === 0 ? event : null;
  } catch {
    return null;
  }
}

function eventAttempt(
  event: NormalizedRunEvent,
  occurredAt: string,
  attempts: AttemptProjectionRow[]
): AttemptProjectionRow | undefined {
  const providerAttempts = attempts.filter((attempt) => attempt.provider === event.provider);
  const turnID = text(event.metadata.provider_turn_id);
  if (turnID) {
    const exact = providerAttempts.filter((attempt) => attempt.provider_turn_id === turnID).at(-1);
    if (exact) return exact;
  }
  const sessionID = text(event.metadata.provider_session_id);
  if (sessionID) {
    const session = providerAttempts.filter((attempt) => attempt.provider_session_id === sessionID &&
      insideAttemptWindow(occurredAt, attempt)).at(-1);
    if (session) return session;
  }
  const inWindow = providerAttempts.filter((attempt) => insideAttemptWindow(occurredAt, attempt)).at(-1);
  if (inWindow) return inWindow;
  const eventTime = timestamp(occurredAt);
  return providerAttempts.filter((attempt) => timestamp(attempt.started_at || attempt.updated_at) <= eventTime).at(-1) ??
    providerAttempts[0];
}

function insideAttemptWindow(occurredAt: string, attempt: AttemptProjectionRow): boolean {
  const eventTime = timestamp(occurredAt);
  const start = timestamp(attempt.started_at || attempt.updated_at);
  const end = attempt.ended_at ? timestamp(attempt.ended_at) : Number.POSITIVE_INFINITY;
  return eventTime >= start && eventTime <= end;
}

function attemptInitialPhase(run: RunProjectionRow, attempt: AttemptProjectionRow): RunProgressPhase {
  const status = ATTEMPT_STATUSES.includes(attempt.status as AttemptStatus) ? attempt.status as AttemptStatus : null;
  if (attempt.kind === "recovery" && status === "created" && run.legacy_status === "in_progress") return "recovering";
  if (status === "created") return "queued";
  return status ?? "unknown";
}

function runInitialPhase(run: RunProjectionRow, attempt: AttemptProjectionRow | undefined): RunProgressPhase {
  if (attempt) return attemptInitialPhase(run, attempt);
  const phase = authoritativeRunPhase(run, attempt);
  return phase === "created" ? "queued" : phase ?? "unknown";
}

function latestActivityAt(
  db: RunnerDatabase,
  run: RunProjectionRow,
  attempt: AttemptProjectionRow | undefined,
  latestEventAt: string
): string {
  const sessionAt = attempt?.agent_session_key
    ? db.sqlite.query<{ updated_at: string }, [string]>(
        "select updated_at from agent_sessions where session_key=?"
      ).get(attempt.agent_session_key)?.updated_at ?? ""
    : "";
  return latestTimestamp(
    run.ended_at,
    run.started_at,
    attempt?.updated_at ?? "",
    attempt?.ended_at ?? "",
    sessionAt,
    latestEventAt
  );
}

function stalledSignal(
  runPhase: RunStatus | null,
  providerPhase: RunProgressPhase,
  since: string,
  now: Date,
  thresholdMs: number
): RunProgressStalledSignal {
  const waiting = providerPhase === "waiting_approval";
  const active = runPhase === "running" || runPhase === "recovering";
  const elapsed = Math.max(0, now.getTime() - timestamp(since));
  const detected = active && !waiting && elapsed >= thresholdMs;
  return {
    detected,
    evaluated_at: now.toISOString(),
    reason: waiting ? "waiting_approval" : detected ? "no_progress_for_threshold" : "",
    since,
    threshold_ms: thresholdMs
  };
}

function eventSummary(payload: Record<string, unknown>, event: NormalizedRunEvent): string {
  return [payload.error, payload.status, payload.text, payload.command, payload.raw_method, payload.type]
    .map(text)
    .find(Boolean) || event.source.method;
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function compareTimeline(left: RunProgressTimelineItem, right: RunProgressTimelineItem): number {
  const time = timestamp(left.occurred_at) - timestamp(right.occurred_at);
  if (time !== 0) return time;
  return left.source_event_id - right.source_event_id;
}

function earliestTimestamp(...values: string[]): string {
  return values.filter(Boolean).sort((left, right) => timestamp(left) - timestamp(right))[0] ?? "";
}

function latestTimestamp(...values: string[]): string {
  return values.filter(Boolean).sort((left, right) => timestamp(left) - timestamp(right)).at(-1) ?? "";
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
