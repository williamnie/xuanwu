import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  type IssueSupervisorEvent
} from "../db/repositories/pi.ts";
import {
  latestPiRecoveryAttemptForAction,
  updatePiRecoveryAttemptStatus,
  type PiRecoveryAttempt
} from "../db/repositories/pi/recoveryAttempts.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { IssueSupervisorRecoveryContext } from "../pi/issueSupervisorContext.ts";
import { detectMeaningfulProgress, type ProgressSnapshot } from "../pi/meaningfulProgress.ts";

const DEFAULT_STALE_SECONDS = 5 * 60;
const FINAL_OUTCOMES = new Set(["failed", "no_progress", "progress", "queued", "recorded", "scheduled"]);
const RECOVERY_ACTIONS = new Set(["session.resume_followup", "session.steer", "issue.retry"]);

export type SupervisorProgressRefreshOutcome = "no_progress" | "progress";

export function refreshSupervisorProgressResult(input: {
  context: IssueSupervisorRecoveryContext;
  database: RunnerDatabase;
  issueID: number;
  now: Date;
  projectID: string;
  staleAfterSeconds?: number;
}): SupervisorProgressRefreshOutcome | null {
  const events = listIssueSupervisorEvents(input.database, { issueId: input.issueID });
  const action = latestRecoveryAction(events);
  if (!action || hasFinalResult(events, action)) return null;
  if (!staleEnough(action.created_at, input.now, input.staleAfterSeconds)) return null;
  const progressEvents = issueEventsAfter(input.database, input.issueID, action.created_at);
  const attempt = latestPiRecoveryAttemptForAction(input.database, { actionID: action.action_id, issueID: input.issueID });
  const afterSnapshot = snapshotFromContext(input.context);
  const progress = detectMeaningfulProgress({
    baseline: baselineSnapshot(action, attempt),
    current: afterSnapshot,
    events: progressEvents
  });
  const outcome = progress.has_progress ? "progress" : "no_progress";
  if (attempt) {
    updatePiRecoveryAttemptStatus(input.database, attempt.id, {
      after_snapshot_json: afterSnapshot,
      ignored_reasons_json: progress.ignored_reasons,
      progress_detected: progress.has_progress ? 1 : 0,
      progress_reasons_json: progress.reasons,
      status: outcome
    });
  }
  createIssueSupervisorEvent(input.database, {
    action_id: action.action_id,
    action_type: action.action_type,
    decision: action.decision,
    diagnosis_code: action.diagnosis_code || primaryDiagnosis(input.context),
    event_type: "result",
    issue_id: input.issueID,
    payload_json: {
      ignored_reasons: progress.ignored_reasons,
      observed_issue_events: progressEvents.length,
      outcome,
      recovery_attempt_id: attempt?.id ?? "",
      reasons: progress.reasons,
      since_action_at: action.created_at
    },
    project_id: input.projectID,
    provider: action.provider || clean(input.context.session.provider),
    provider_session_id: action.provider_session_id || clean(input.context.session.provider_session_id),
    provider_turn_id: action.provider_turn_id || clean(input.context.session.provider_turn_id),
    run_id: action.run_id || clean(input.context.latest_run?.id)
  });
  return outcome;
}

export function supervisorResultOutcome(event: IssueSupervisorEvent): string {
  try {
    const payload = JSON.parse(event.payload_json || "{}") as Record<string, unknown>;
    return clean(payload.outcome) || clean(payload.status);
  } catch {
    return "";
  }
}

function latestRecoveryAction(events: IssueSupervisorEvent[]): IssueSupervisorEvent | undefined {
  return [...events].reverse().find((event) =>
    event.event_type === "action" && RECOVERY_ACTIONS.has(event.action_type) && event.action_id !== ""
  );
}

function hasFinalResult(events: IssueSupervisorEvent[], action: IssueSupervisorEvent): boolean {
  return events.some((event) =>
    event.event_type === "result" &&
    event.action_id === action.action_id &&
    FINAL_OUTCOMES.has(supervisorResultOutcome(event))
  );
}

function issueEventsAfter(db: RunnerDatabase, issueID: number, createdAt: string) {
  return listIssueEvents(db, issueID, {
    createdAfter: createdAt,
    hydrateArtifacts: false,
    limit: 500
  })
    .map((event) => ({ payload: event.payload, type: event.type }));
}

function staleEnough(createdAt: string, now: Date, staleAfterSeconds: number | undefined): boolean {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return false;
  const seconds = staleAfterSeconds && staleAfterSeconds > 0 ? staleAfterSeconds : DEFAULT_STALE_SECONDS;
  return now.getTime() - started >= seconds * 1_000;
}

function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return clean(context.candidates[0]?.diagnosis_code) || clean(context.provider_error?.diagnosis_code);
}

function baselineSnapshot(action: IssueSupervisorEvent, attempt: PiRecoveryAttempt | null): ProgressSnapshot {
  return snapshotFromJson(attempt?.before_snapshot_json) ?? snapshotFromAction(action);
}

function snapshotFromAction(action: IssueSupervisorEvent): ProgressSnapshot {
  const payload = objectValue(parseJson(action.payload_json));
  return snapshotFromJson(payload.before_snapshot) ?? {};
}

function snapshotFromContext(context: IssueSupervisorRecoveryContext): ProgressSnapshot {
  return {
    git_diff_hash: clean(context.workspace_snapshot.git_diff_hash),
    issue: {
      status: clean(context.issue.status),
      updated_at: clean(context.issue.updated_at)
    },
    run: {
      status: clean(context.latest_run?.status),
      updated_at: clean(context.latest_run?.ended_at) || clean(context.latest_run?.started_at)
    },
    session: {
      status: clean(context.session.raw_status) || clean(context.session.status),
      updated_at: clean(context.session.updated_at)
    }
  };
}

function snapshotFromJson(value: unknown): ProgressSnapshot | null {
  const snapshot = objectValue(parseJson(value));
  if (Object.keys(snapshot).length === 0) return null;
  return {
    git_diff_hash: clean(snapshot.git_diff_hash),
    issue: statePoint(snapshot.issue),
    run: statePoint(snapshot.run),
    session: statePoint(snapshot.session)
  };
}

function statePoint(value: unknown): { status?: string; updated_at?: string } {
  const point = objectValue(value);
  return { status: clean(point.status), updated_at: clean(point.updated_at) };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
