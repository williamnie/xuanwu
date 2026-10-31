import type { RunnerDatabase } from "../database.ts";
import {
  ATTEMPT_STATUSES,
  RUN_STATUSES,
  type AttemptStatus,
  type RunID,
  type RunStatus
} from "../../domain/run/contracts.ts";
import { NORMALIZED_RUN_EVENT_CONTRACT, type NormalizedRunEvent } from "../../providers/types.ts";
import { validateNormalizedRunEvent } from "../../providers/runEvents.ts";
import { type RunProgressPhase } from "../../events/runProgressProjector.ts";
import { cleanString } from "../../util/values.ts";
import {
  type RunProjectionRow,
  type AttemptProjectionRow,
  type EventRow,
  earliestTimestamp,
  RUN_PROGRESS_SOURCE_EVENT_LIMIT,
  type ParsedEvents,
  jsonObject,
  eventSummary,
  timestamp
} from "./runProgressModel.ts";

export function authoritativeRunPhase(run: RunProjectionRow, latest: AttemptProjectionRow | undefined): RunStatus | null {
  const status = run.legacy_status === "in_progress" && latest?.kind === "recovery" &&
    ["created", "failed", "interrupted"].includes(latest.status ?? "")
    ? "recovering"
    : run.legacy_status === "in_progress" ? "running"
      : run.legacy_status === "succeeded" ? "succeeded"
        : ["failed", "cancelled"].includes(run.legacy_status) ? run.legacy_status
          : null;
  return RUN_STATUSES.includes(status as RunStatus) ? status as RunStatus : null;
}

export function projectionRun(db: RunnerDatabase, runID: RunID): RunProjectionRow | null {
  return db.sqlite.query<RunProjectionRow, [string]>(`
    select id as legacy_id, run_id, issue_id, attempt as run_sequence,
      status as legacy_status, started_at, ended_at
    from issue_runs where run_id=?
  `).get(runID);
}

export function projectionAttempts(db: RunnerDatabase, legacyID: string): AttemptProjectionRow[] {
  return db.sqlite.query<AttemptProjectionRow, [string]>(`
    select attempt_id, sequence, kind, status, provider, provider_session_id,
      provider_turn_id, agent_session_key, started_at, ended_at, updated_at
    from run_attempts where issue_run_id=? order by sequence asc
  `).all(legacyID);
}

export function projectionEventRows(db: RunnerDatabase, run: RunProjectionRow): EventRow[] {
  const nextStartedAt = db.sqlite.query<{ started_at: string }, [number, number]>(`
    select started_at from issue_runs where issue_id=? and attempt>?
    order by attempt asc limit 1
  `).get(run.issue_id, run.run_sequence)?.started_at ?? "";
  const upperBound = earliestTimestamp(run.ended_at, nextStartedAt);
  // 按 (issue_id, type, rowid) 索引倒序走到窗口上限即停，避免为排序解析该 Issue 的全部日志 JSON；
  // 日志在写入时取时间戳，id 序与 created_at 序一致，窗口内再恢复 (created_at, id) 的稳定顺序。
  return db.sqlite.query<EventRow, [number, string, string, string]>(`
    select id, payload, created_at from issue_events
    where issue_id=? and type='issue.log' and julianday(created_at)>=julianday(?)
      and (?='' or julianday(created_at)<=julianday(?))
      and json_valid(payload)
      and json_extract(payload, '$.run_event.contract')='${NORMALIZED_RUN_EVENT_CONTRACT}'
    order by id desc
    limit ${RUN_PROGRESS_SOURCE_EVENT_LIMIT + 1}
  `).all(run.issue_id, run.started_at, upperBound, upperBound).sort(compareEventRows);
}

function compareEventRows(left: EventRow, right: EventRow): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  return left.id - right.id;
}

export function parseProjectionEvents(rows: EventRow[], attempts: AttemptProjectionRow[]): ParsedEvents {
  const boundedRows = rows.slice(-RUN_PROGRESS_SOURCE_EVENT_LIMIT);
  const result: ParsedEvents = {
    events: [], firstID: 0, invalid: 0, lastID: 0,
    sourceCount: boundedRows.length, sourceTruncated: rows.length > RUN_PROGRESS_SOURCE_EVENT_LIMIT, unmapped: 0
  };
  for (const row of boundedRows) {
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
  const turnID = cleanString(event.metadata.provider_turn_id);
  if (turnID) {
    const exact = providerAttempts.filter((attempt) => attempt.provider_turn_id === turnID).at(-1);
    if (exact) return exact;
  }
  const sessionID = cleanString(event.metadata.provider_session_id);
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

export function attemptInitialPhase(run: RunProjectionRow, attempt: AttemptProjectionRow): RunProgressPhase {
  const status = ATTEMPT_STATUSES.includes(attempt.status as AttemptStatus) ? attempt.status as AttemptStatus : null;
  if (attempt.kind === "recovery" && status === "created" && run.legacy_status === "in_progress") return "recovering";
  if (status === "created") return "queued";
  return status ?? "unknown";
}

export function runInitialPhase(run: RunProjectionRow, attempt: AttemptProjectionRow | undefined): RunProgressPhase {
  if (attempt) return attemptInitialPhase(run, attempt);
  const phase = authoritativeRunPhase(run, attempt);
  return phase === "created" ? "queued" : phase ?? "unknown";
}
