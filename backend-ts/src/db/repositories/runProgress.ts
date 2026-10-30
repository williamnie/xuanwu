import type { RunnerDatabase } from "../database.ts";
import { type RunID } from "../../domain/run/contracts.ts";
import { NORMALIZED_RUN_EVENT_CONTRACT } from "../../providers/types.ts";
import {
  RUN_PROGRESS_PROJECTOR_VERSION,
  RUN_PROGRESS_TIMELINE_LIMIT,
  projectRunAttemptProgress
} from "../../events/runProgressProjector.ts";
import {
  type RunProgressProjection,
  nonNegativeInteger,
  compareTimeline,
  positiveInteger,
  RUN_PROGRESS_STALLED_AFTER_MS,
  sum,
  RUN_PROGRESS_STATUS_RUN_LIMIT
} from "./runProgressModel.ts";
import {
  projectionRun,
  projectionAttempts,
  projectionEventRows,
  parseProjectionEvents,
  attemptInitialPhase,
  runInitialPhase,
  authoritativeRunPhase
} from "./runProgressEvents.ts";
import { latestActivityAt, stalledSignal } from "./runProgressSignals.ts";

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
      source_event_truncated: parsed.sourceTruncated,
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
  const activeRuns = Number(db.sqlite.query<{ count: number }, []>(
    "select count(*) as count from issue_runs where status='in_progress'"
  ).get()?.count ?? 0);
  const runIDs = db.sqlite.query<{ run_id: string }, []>(`
    select run_id from issue_runs where status='in_progress' order by started_at desc, id desc
    limit ${RUN_PROGRESS_STATUS_RUN_LIMIT}
  `).all().map((row) => row.run_id as RunID);
  const projections = runIDs.flatMap((runID) => {
    const projection = rebuildRunProgressProjection(db, runID, { now, timelineLimit: 0 });
    return projection ? [projection] : [];
  });
  return {
    active_runs: activeRuns,
    backpressure: activeRuns > runIDs.length,
    evaluated_active_runs: runIDs.length,
    // `max(id)` makes SQLite evaluate the JSON predicate across the complete
    // issue_events table. Walking the integer primary key backwards can stop
    // at the first matching normalized event and is equivalent.
    latest_source_event_id: db.sqlite.query<{ id: number }, []>(`
      select id from issue_events indexed by idx_issue_events_run_event_v1_id_desc
      where type='issue.log' and json_valid(payload)
        and json_extract(payload, '$.run_event.contract')='${NORMALIZED_RUN_EVENT_CONTRACT}'
      order by id desc limit 1
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

export { RUN_PROGRESS_STALLED_AFTER_MS } from "./runProgressModel.ts";
export type { RunProgressProjection } from "./runProgressModel.ts";
