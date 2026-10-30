import type { RunnerDatabase } from "../database.ts";
import { type RunStatus } from "../../domain/run/contracts.ts";
import { type RunProgressPhase } from "../../events/runProgressProjector.ts";
import {
  type RunProjectionRow,
  type AttemptProjectionRow,
  latestTimestamp,
  type RunProgressStalledSignal,
  timestamp
} from "./runProgressModel.ts";

export function latestActivityAt(
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

export function stalledSignal(
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
