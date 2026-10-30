import type { RunnerDatabase } from "../db/database.ts";
import { listIssueSupervisorEvents } from "../db/repositories/pi.ts";
import { type IssueSupervisorRecoveryContext } from "../pi/supervisor/issueSupervisorContext.ts";
import { iso } from "../pi/heartbeat/heartbeatOrchestratorSupport.ts";
import { supervisorResultOutcome } from "./issueSupervisorProgressTracker.ts";
import { cleanString } from "../util/values.ts";
import { MAX_INVALID_DECISIONS_PER_EVIDENCE, DEFAULT_LIMIT } from "./piIssueSupervisorScheduler.model.ts";
import type { SupervisorTarget, PiIssueSupervisorSchedulerInput } from "./piIssueSupervisorScheduler.model.ts";

export function invalidDecisionBudgetExhausted(db: RunnerDatabase, target: SupervisorTarget): boolean {
  const diagnosis = primaryDiagnosis(target.context);
  const evidenceAt = latestEvidenceTime(target.context);
  return listIssueSupervisorEvents(db, {
    eventTypes: ["decision_failed"],
    issueId: target.issueID
  }).filter((event) => {
    if (diagnosis !== "" && event.diagnosis_code !== diagnosis) return false;
    const createdAt = Date.parse(event.created_at);
    return Number.isFinite(createdAt) && (evidenceAt === 0 || createdAt >= evidenceAt);
  }).length >= MAX_INVALID_DECISIONS_PER_EVIDENCE;
}

export function recentDecisionExists(
  input: PiIssueSupervisorSchedulerInput,
  target: SupervisorTarget,
  now: Date
): boolean {
  return recentCompletedDecisionExists(input.database, target, now);
}

export function recentCompletedDecisionExists(db: RunnerDatabase, target: SupervisorTarget, now: Date): boolean {
  // Signals are intentionally excluded: only completed decision/action/result
  // rows participate in this dedupe check.
  const events = listIssueSupervisorEvents(db, {
    eventTypes: ["budget_exhausted", "decision", "decision_failed", "action", "result"],
    issueId: target.issueID
  });
  const latestResult = latestSupervisorResult(events);
  if (latestResult === "no_progress" || latestResult === "failed") return false;
  const diagnosis = primaryDiagnosis(target.context);
  const retryAfter = readyRetryAfterTime(target.context);
  const threshold = retryAfter || latestEvidenceTime(target.context);
  const failedDecisionCooldown = now.getTime() -
    Math.max(30, numberValue(target.context.policy.cooldown_seconds) || 300) * 1_000;
  const matching = events.filter((event) => {
    if (!["budget_exhausted", "decision", "decision_failed", "action", "result"].includes(event.event_type)) return false;
    if (diagnosis !== "" && event.diagnosis_code !== diagnosis) return false;
    const createdAt = Date.parse(event.created_at);
    return Number.isFinite(createdAt) && (threshold === 0 || createdAt >= threshold);
  });
  const latestDecisionBoundary = [...matching].reverse().find((event) =>
    ["budget_exhausted", "decision", "decision_failed"].includes(event.event_type)
  );
  // A failed PI decision is a runtime fact, never an Issue outcome. Retry
  // after cooldown; once the repeated-invalid boundary is reached, let the
  // next scheduler pass re-enter PI immediately rather than sticking forever.
  if (latestDecisionBoundary?.event_type === "decision_failed") {
    if (invalidDecisionBudgetExhausted(db, target)) return false;
    return Date.parse(latestDecisionBoundary.created_at) >= failedDecisionCooldown;
  }
  return matching.some((event) => event.event_type !== "decision_failed");
}

export function latestSupervisorResult(events: ReturnType<typeof listIssueSupervisorEvents>): string {
  const result = [...events].reverse().find((event) => event.event_type === "result");
  return result ? supervisorResultOutcome(result) : "";
}

export function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return cleanString(context.candidates.find((candidate) => candidate.exhausted)?.diagnosis_code) ||
    cleanString(context.candidates.find((candidate) => candidate.diagnosis_code === "provider_retry_after_ready")?.diagnosis_code) ||
    cleanString(context.candidates[0]?.diagnosis_code);
}

export function readyRetryAfterTime(context: IssueSupervisorRecoveryContext): number {
  for (const candidate of context.candidates) {
    if (candidate.diagnosis_code !== "provider_retry_after_ready") continue;
    const ms = Date.parse(cleanString(candidate.wait_until));
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

export function latestEvidenceTime(context: IssueSupervisorRecoveryContext): number {
  return Math.max(0, ...context.recent_events.map((event) => Date.parse(event.at)).filter(Number.isFinite));
}

export function boundedLimit(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : DEFAULT_LIMIT, 1), DEFAULT_LIMIT);
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

export function cooldownUntil(context: IssueSupervisorRecoveryContext, now: Date): string {
  const last = Date.parse(cleanString(context.recovery_history.last_action_at));
  const seconds = numberValue(context.policy.cooldown_seconds);
  if (!Number.isFinite(last) || seconds <= 0) return "";
  const until = new Date(last + seconds * 1_000);
  return until.getTime() > now.getTime() ? iso(until) : "";
}
