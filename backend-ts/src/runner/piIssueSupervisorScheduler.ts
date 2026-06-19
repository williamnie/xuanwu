import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents
} from "../db/repositories/pi.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import {
  buildIssueSupervisorRecoveryContext,
  type IssueSupervisorRecoveryContext
} from "../pi/issueSupervisorContext.ts";
import { supervisorCandidateReady } from "../pi/issueSupervisorSignalCollector.ts";
import type { PiSupervisorDecisionRuntimeResult } from "../pi/issueSupervisorDecision.ts";
import {
  guardianSignalsFromSupervisorCandidates,
  writeGuardianSignals
} from "../pi/guardianSignals.ts";
import { iso } from "../pi/heartbeatOrchestratorSupport.ts";
import {
  refreshSupervisorProgressResult,
  supervisorResultOutcome
} from "./issueSupervisorProgressTracker.ts";
export type PiIssueSupervisorSchedulerInput = {
  database: RunnerDatabase;
  limit?: number;
  now?: Date;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runDecision?: (context: IssueSupervisorRecoveryContext) => Promise<PiSupervisorDecisionRuntimeResult>;
  staleAfterSeconds?: number;
};
export type PiIssueSupervisorSchedulerResult = {
  decisions: number;
  failed: number;
  scanned: number;
  signaled: number;
  skipped: number;
};
type SupervisorTarget = {
  candidates: IssueSupervisorRecoveryContext["candidates"];
  context: IssueSupervisorRecoveryContext;
  issueID: number;
  projectID: string;
};
const activeSupervisorIssues = new Set<string>();
const DEFAULT_LIMIT = 50;
export async function runPiIssueSupervisorSchedulerOnce(
  input: PiIssueSupervisorSchedulerInput
): Promise<PiIssueSupervisorSchedulerResult> {
  const now = input.now ?? new Date();
  const targets = collectTargets(input.database, now, input);
  const result: PiIssueSupervisorSchedulerResult = {
    decisions: 0,
    failed: 0,
    scanned: targets.scanned,
    signaled: targets.signaled,
    skipped: 0
  };
  for (const target of targets.ready) {
    const key = `${target.projectID}:${target.issueID}`;
    if (activeSupervisorIssues.has(key)) {
      result.skipped += 1;
      continue;
    }
    activeSupervisorIssues.add(key);
    try {
      if (recentDecisionExists(input, target)) {
        result.skipped += 1;
        continue;
      }
      recordSignal(input.database, target, now);
      result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      recordFailure(input.database, target, error);
    } finally {
      activeSupervisorIssues.delete(key);
    }
  }
  return result;
}
function collectTargets(
  db: RunnerDatabase,
  now: Date,
  options: Pick<PiIssueSupervisorSchedulerInput, "limit" | "staleAfterSeconds">
): { ready: SupervisorTarget[]; scanned: number; signaled: number } {
  const issueIDs = scanIssueIDs(db, now, options.limit ?? DEFAULT_LIMIT);
  const ready: SupervisorTarget[] = [];
  let signaled = 0;
  for (const issueID of issueIDs) {
    const issue = getIssue(db, issueID);
    if (!issue) continue;
    let context = buildIssueSupervisorRecoveryContext(db, issueID, {
      now,
      staleAfterSeconds: options.staleAfterSeconds
    });
    if (clean(context.policy.mode) === "off") continue;
    if (refreshSupervisorProgressResult({
      context,
      database: db,
      issueID,
      now,
      projectID: issue.project_id,
      staleAfterSeconds: options.staleAfterSeconds
    }) !== null) {
      context = buildIssueSupervisorRecoveryContext(db, issueID, {
        now,
        staleAfterSeconds: options.staleAfterSeconds
      });
    }
    const dispatchableCandidates = context.candidates.filter((candidate) =>
      supervisorCandidateDispatchable(context, candidate, now, options)
    );
    if (dispatchableCandidates.length > 0) signaled += 1;
    if (dispatchableCandidates.length === 0) continue;
    ready.push({
      candidates: dispatchableCandidates,
      context,
      issueID,
      projectID: issue.project_id
    });
  }
  return { ready, scanned: issueIDs.length, signaled };
}

function supervisorCandidateDispatchable(
  context: IssueSupervisorRecoveryContext,
  candidate: IssueSupervisorRecoveryContext["candidates"][number],
  now: Date,
  options: Pick<PiIssueSupervisorSchedulerInput, "staleAfterSeconds">
): boolean {
  if (supervisorCandidateReady(context, candidate, now, { staleAfterSeconds: options.staleAfterSeconds })) return true;
  return candidate.diagnosis_code === "provider_retry_after_waiting" &&
    clean(candidate.source_event_type) !== "issue.retry_after_scheduled";
}

function scanIssueIDs(db: RunnerDatabase, now: Date, limit: number): number[] {
  const nowText = iso(now);
  return db.sqlite.query<{ id: number }, [string]>(`
    select distinct i.id from issues i
    left join issue_runs ir on ir.issue_id=i.id
    where i.status='in_progress' or ir.ended_at='' or (i.auto_retry_next_at<>'' and i.auto_retry_next_at<=?)
    order by i.updated_at asc, i.id asc limit ${boundedLimit(limit)}
  `).all(nowText).map((row) => row.id);
}
function recordSignal(db: RunnerDatabase, target: SupervisorTarget, now: Date): void {
  const candidate = target.candidates[0];
  createIssueSupervisorEvent(db, {
    diagnosis_code: clean(candidate?.diagnosis_code),
    event_type: "signal",
    issue_id: target.issueID,
    payload_json: { candidate, candidates: target.candidates },
    project_id: target.projectID,
    provider: clean(target.context.session.provider) || clean(target.context.provider_error?.provider),
    provider_error_category: clean(target.context.provider_error?.category),
    provider_session_id: clean(target.context.session.provider_session_id),
    provider_turn_id: clean(target.context.session.provider_turn_id),
    retry_after_at: clean(candidate?.wait_until),
    run_id: clean(target.context.latest_run?.id)
  });
  writeGuardianSignals(db, guardianSignalsFromSupervisorCandidates(
    target.candidates.map((item) => ({
      allowed_actions: stringArray(target.context.policy.allowed_actions),
      budget_remaining: numberValue(target.context.recovery_history.budget_remaining),
      cooldown_until: cooldownUntil(target.context, now),
      diagnosis_code: clean(item.diagnosis_code),
      evidence_refs: item.evidence_refs ?? [],
      issue_status: clean(target.context.issue.status),
      issue_updated_at: clean(target.context.issue.updated_at),
      issue_id: target.issueID,
      project_id: target.projectID,
      project_budget_remaining: numberValue(target.context.policy.project_budget_remaining),
      provider: clean(target.context.session.provider) || clean(target.context.provider_error?.provider),
      provider_error_category: clean(target.context.provider_error?.category),
      provider_session_id: clean(target.context.session.provider_session_id),
      provider_turn_id: clean(target.context.session.provider_turn_id),
      ready: true,
      reason: item.reason,
      run_ended_at: clean(target.context.latest_run?.ended_at),
      run_id: clean(target.context.latest_run?.id),
      run_status: clean(target.context.latest_run?.status),
      session_status: clean(target.context.session.raw_status),
      session_turn_id: clean(target.context.session.provider_turn_id),
      session_updated_at: clean(target.context.session.updated_at),
      stale_gap_seconds: numberValue(target.context.session.stale_gap_seconds),
      supervisor_mode: clean(target.context.policy.mode),
      wait_until: clean(item.wait_until),
      ...retryAfterPayload(item)
    })),
    { heartbeatID: `supervisor:${target.projectID}:${target.issueID}:${iso(now)}`, now, projectID: target.projectID }
  ));
}
function recordFailure(db: RunnerDatabase, target: SupervisorTarget, error: unknown): void {
  createIssueSupervisorEvent(db, {
    diagnosis_code: primaryDiagnosis(target.context),
    event_type: "signal_failed",
    issue_id: target.issueID,
    payload_json: {
      error: safeError(error),
      supervisor_agent: { runnable: false, source: "guardian_signal_only" }
    },
    project_id: target.projectID,
    provider: clean(target.context.session.provider) || clean(target.context.provider_error?.provider),
    provider_error_category: clean(target.context.provider_error?.category),
    provider_session_id: clean(target.context.session.provider_session_id),
    provider_turn_id: clean(target.context.session.provider_turn_id),
    run_id: clean(target.context.latest_run?.id)
  });
}
function recentDecisionExists(
  input: PiIssueSupervisorSchedulerInput,
  target: SupervisorTarget
): boolean {
  return recentCompletedDecisionExists(input.database, target);
}
function recentCompletedDecisionExists(db: RunnerDatabase, target: SupervisorTarget): boolean {
  const events = listIssueSupervisorEvents(db, { issueId: target.issueID });
  if (latestSupervisorResult(events) === "no_progress") return false;
  const diagnosis = primaryDiagnosis(target.context);
  const retryAfter = readyRetryAfterTime(target.context);
  const threshold = retryAfter || latestEvidenceTime(target.context);
  return events.some((event) => {
    if (!["decision", "action", "result"].includes(event.event_type)) return false;
    if (diagnosis !== "" && event.diagnosis_code !== diagnosis) return false;
    return threshold === 0 || Date.parse(event.created_at) >= threshold;
  });
}
function latestSupervisorResult(events: ReturnType<typeof listIssueSupervisorEvents>): string {
  const result = [...events].reverse().find((event) => event.event_type === "result");
  return result ? supervisorResultOutcome(result) : "";
}
function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return clean(context.candidates.find((candidate) => candidate.exhausted)?.diagnosis_code) ||
    clean(context.candidates.find((candidate) => candidate.diagnosis_code === "provider_retry_after_ready")?.diagnosis_code) ||
    clean(context.candidates[0]?.diagnosis_code);
}
function readyRetryAfterTime(context: IssueSupervisorRecoveryContext): number {
  for (const candidate of context.candidates) {
    if (candidate.diagnosis_code !== "provider_retry_after_ready") continue;
    const ms = Date.parse(clean(candidate.wait_until));
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}
function latestEvidenceTime(context: IssueSupervisorRecoveryContext): number {
  return Math.max(0, ...context.recent_events.map((event) => Date.parse(event.at)).filter(Number.isFinite));
}
function boundedLimit(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : DEFAULT_LIMIT, 1), DEFAULT_LIMIT);
}
function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function cooldownUntil(context: IssueSupervisorRecoveryContext, now: Date): string {
  const last = Date.parse(clean(context.recovery_history.last_action_at));
  const seconds = numberValue(context.policy.cooldown_seconds);
  if (!Number.isFinite(last) || seconds <= 0) return "";
  const until = new Date(last + seconds * 1_000);
  return until.getTime() > now.getTime() ? iso(until) : "";
}

function retryAfterPayload(candidate: IssueSupervisorRecoveryContext["candidates"][number]): Record<string, string> {
  return clean(candidate.source_event_type) === "issue.retry_after_scheduled" ? { retry_after_ready: "true" } : {};
}
