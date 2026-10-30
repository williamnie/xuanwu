import type { RunnerDatabase } from "../database.ts";
import {
  RUN_PROGRESS_STALLED_AFTER_MS,
  rebuildRunProgressProjection,
  type RunProgressProjection
} from "./runProgress.ts";
import {
  ATTEMPT_KINDS,
  ATTEMPT_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  type AttemptKind,
  type AttemptStatus,
  type RunAttempt,
  type RunCost,
  type RunID,
  type RunStatus,
  type RunTrigger,
  type WorkID
} from "../../domain/run/contracts.ts";
import { cleanString } from "../../util/values.ts";
import { type RunRow, type RunView, type AttemptRow, type RunAttemptView } from "./runsModel.ts";

export function mapRunRow(db: RunnerDatabase, row: RunRow, timelineLimit?: number | "summary"): RunView {
  const id = row.run_id as RunID;
  const workID = row.work_id as WorkID;
  const status = RUN_STATUSES.includes(row.unified_status as RunStatus) ? row.unified_status as RunStatus : null;
  const attemptStatus = ATTEMPT_STATUSES.includes(row.latest_attempt_status as AttemptStatus)
    ? row.latest_attempt_status as AttemptStatus
    : null;
  const trigger = RUN_TRIGGERS.includes(row.trigger as RunTrigger)
    ? row.trigger as RunTrigger
    : row.run_sequence === 1 ? "initial" : null;
  const updatedAt = cleanString(row.ended_at) || cleanString(row.latest_attempt_updated_at) || row.started_at;
  const progress = timelineLimit === "summary"
    ? summarizedRunProgress(status, attemptStatus, updatedAt)
    : rebuildRunProgressProjection(db, id, {
        ...(timelineLimit === undefined ? {} : { timelineLimit })
      });
  if (!progress) throw new Error(`Run progress projection source is missing: ${id}`);
  const mappingErrors = [
    ...(status ? [] : [`unsupported legacy issue_run status: ${row.legacy_status}`]),
    ...(row.latest_attempt_id && !attemptStatus ? [`latest Attempt status is unmapped: ${row.latest_attempt_status ?? "null"}`] : []),
    ...(trigger ? [] : ["Run trigger is unavailable for legacy Run without materialization audit"])
  ];
  const terminal = status && ["succeeded", "failed", "cancelled"].includes(status) && row.ended_at
    ? {
        reason: cleanString(row.exit_reason) || cleanString(row.error) || `legacy issue_run ${row.legacy_status}`,
        source_ref: `issue_runs:${row.legacy_id}`
      }
    : undefined;
  return {
    attempt_count: row.attempt_count,
    cost: null,
    created_at: row.started_at,
    ended_at: row.ended_at,
    id,
    legacy: { error: row.error, id: row.legacy_id, status: row.legacy_status },
    links: runLinks(id, workID, row.project_id, row.legacy_id, row.latest_attempt_id),
    mapping_errors: mappingErrors,
    progress: {
      ...progress,
      attempt_id: row.latest_attempt_id ?? "",
      attempt_sequence: row.latest_attempt_sequence ?? 0,
      attempt_status: attemptStatus,
      phase: status,
      updated_at: progress.updated_at || updatedAt
    },
    project_id: row.project_id,
    provider: row.provider,
    revision: row.revision,
    sequence: row.run_sequence,
    started_at: row.started_at,
    status,
    supersedes_run_id: cleanString(row.supersedes_run_id) ? row.supersedes_run_id as RunID : null,
    ...(terminal ? { terminal } : {}),
    trigger,
    updated_at: progress.updated_at || updatedAt,
    work_id: workID,
    work_title: row.work_title
  };
}

function summarizedRunProgress(
  status: RunStatus | null,
  attemptStatus: AttemptStatus | null,
  updatedAt: string
): RunProgressProjection {
  const evaluatedAt = new Date();
  const elapsed = evaluatedAt.getTime() - Date.parse(updatedAt);
  const stalled = ["running", "recovering"].includes(status ?? "")
    && Number.isFinite(elapsed)
    && elapsed >= RUN_PROGRESS_STALLED_AFTER_MS;
  const providerPhase = status ?? (
    attemptStatus === "created" ? "queued"
      : attemptStatus === "running" ? "running"
        : attemptStatus === "succeeded" ? "succeeded"
          : attemptStatus === "failed" ? "failed"
            : attemptStatus === "cancelled" ? "cancelled"
              : attemptStatus === "interrupted" ? "interrupted"
                : "unknown"
  );
  return {
    invalid_event_count: 0,
    latest: null,
    phase_summary: [],
    projected_by: "xuanwu.run-progress-projector.v1",
    projection_mode: "list_summary",
    provider_phase: providerPhase,
    replay: {
      duplicate_event_count: 0,
      ignored_event_count: 0,
      source_event_count: 0,
      source_event_truncated: false,
      timeline_truncated: 0,
      unique_event_count: 0,
      unmapped_event_count: 0
    },
    source_event_range: null,
    source_of_truth: "issue_runs+run_attempts+issue_events",
    stalled: {
      detected: stalled,
      evaluated_at: evaluatedAt.toISOString(),
      reason: stalled ? "no_progress_for_threshold" : "",
      since: updatedAt,
      threshold_ms: RUN_PROGRESS_STALLED_AFTER_MS
    },
    timeline: [],
    updated_at: updatedAt
  };
}

export function mapAttemptRow(row: AttemptRow, runID: RunID, runError: string): RunAttemptView {
  const status = ATTEMPT_STATUSES.includes(row.status as AttemptStatus) ? row.status as AttemptStatus : null;
  const kind = ATTEMPT_KINDS.includes(row.kind as AttemptKind) ? row.kind as AttemptKind : null;
  const cost = parseRunCost(row.cost_json);
  const sessionRef = cleanString(row.provider_session_id);
  const terminal = status && ["succeeded", "failed", "cancelled", "interrupted"].includes(status) && row.ended_at
    ? {
        reason: cleanString(row.terminal_reason) || runError || `${status} Attempt`,
        source_ref: cleanString(row.terminal_source_ref) || `run_attempts:${row.attempt_id}`
      }
    : undefined;
  return {
    agent_session_key: cleanString(row.agent_session_key),
    cost: cost.value,
    created_at: row.created_at,
    ended_at: row.ended_at,
    id: row.attempt_id,
    kind,
    links: {
      run: `/api/runs/${encodeURIComponent(runID)}`,
      ...(sessionRef ? { provider_session: `/api/sessions/${encodeURIComponent(`${row.provider}:${sessionRef}`)}` } : {})
    },
    mapping_errors: [
      ...(cleanString(row.mapping_error) ? [row.mapping_error] : []),
      ...(status ? [] : [`Attempt status is unmapped: ${row.status ?? "null"}`]),
      ...(kind ? [] : [`Attempt kind is unmapped: ${row.kind}`]),
      ...(cost.error ? [cost.error] : [])
    ],
    provider_ref: {
      invocation_ref: row.provider_invocation_ref,
      provider: row.provider,
      ...(sessionRef ? { observation_ref: `${row.provider}:${sessionRef}`, session_ref: sessionRef } : {}),
      ...(cleanString(row.provider_turn_id) ? { turn_ref: row.provider_turn_id } : {})
    },
    revision: row.revision,
    run_id: runID,
    sequence: row.sequence,
    started_at: row.started_at,
    status,
    ...(terminal ? { terminal } : {}),
    updated_at: row.updated_at
  };
}

export function attemptContract(attempt: RunAttemptView): RunAttempt | null {
  if (!attempt.status || !attempt.kind || !attempt.cost) return null;
  return {
    cost: attempt.cost,
    created_at: attempt.created_at,
    ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}),
    id: attempt.id as RunAttempt["id"],
    kind: attempt.kind,
    provider_ref: attempt.provider_ref,
    revision: attempt.revision,
    run_id: attempt.run_id,
    sequence: attempt.sequence,
    ...(attempt.started_at ? { started_at: attempt.started_at } : {}),
    status: attempt.status,
    ...(attempt.terminal ? { terminal: attempt.terminal } : {}),
    updated_at: attempt.updated_at
  };
}

function parseRunCost(value: string): { error: string; value: RunCost | null } {
  try {
    const cost = JSON.parse(value) as RunCost;
    if (!cost || typeof cost !== "object" || !cost.usage || !cost.money ||
      !Array.isArray(cost.pricing_refs) || !Array.isArray(cost.source_refs)) {
      return { error: "Attempt cost_json does not match the RunCost contract", value: null };
    }
    return { error: "", value: cost };
  } catch {
    return { error: "Attempt cost_json is not valid JSON", value: null };
  }
}

function runLinks(
  runID: RunID,
  workID: WorkID,
  projectID: string,
  legacyID: string,
  attemptID: string | null
): Record<string, string> {
  const issueID = Number(workID.slice("xw:work:issues:".length));
  const baseEvents = `/api/issues/${issueID}/events`;
  return {
    self: `/api/runs/${encodeURIComponent(runID)}`,
    work: `/api/works/${encodeURIComponent(workID)}`,
    project: `/api/projects/${encodeURIComponent(projectID)}`,
    issue: `/api/issues/${issueID}`,
    logs: `${baseEvents}?type=issue.log`,
    evidence: `/api/evidence?run_id=${encodeURIComponent(runID)}`,
    lifecycle_audit: `${baseEvents}?type=run.lifecycle.intent.v1,run.lifecycle.outcome.v1,run.lifecycle.run_requested.v1,run.lifecycle.run_materialized.v1`,
    legacy_run: `/api/issues/${issueID}/runs#${encodeURIComponent(legacyID)}`,
    ...(attemptID ? { current_attempt: `/api/runs/${encodeURIComponent(runID)}#${encodeURIComponent(attemptID)}` } : {})
  };
}

export function addFilter(
  clauses: string[],
  args: Array<number | string>,
  expression: string,
  value: string | undefined
): void {
  const text = cleanString(value);
  if (!text) return;
  clauses.push(expression);
  args.push(text);
}

export function addListFilter(
  clauses: string[],
  args: Array<number | string>,
  column: string,
  values: string[] | undefined
): void {
  const requested = unique(values ?? []);
  if (requested.length === 0) return;
  clauses.push(`${column} in (${requested.map(() => "?").join(", ")})`);
  args.push(...requested);
}

export function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))] as T[];
}
