import type { RunnerDatabase } from "../db/database.ts";
import type {
  HeartbeatStaleSessionDiagnostic,
  HeartbeatSupervisorBudgetSignal,
  HeartbeatSupervisorCandidateSignal,
  HeartbeatSupervisorRetryWindowSignal,
  HeartbeatSupervisorSignals
} from "./heartbeatTypes.ts";
import {
  buildIssueSupervisorRecoveryContext,
  type IssueSupervisorRecoveryContext
} from "./issueSupervisorContext.ts";
import type { SupervisorCandidate } from "./issueSupervisorContextSupport.ts";
import { iso } from "./heartbeatOrchestratorSupport.ts";
import {
  isAutomaticRecoveryBlockedDiagnosis,
  isTransientRecoveryDiagnosis
} from "./recoveryDiagnosis.ts";

export type SupervisorSignalCollectorOptions = {
  issueIDs?: number[];
  limit?: number;
  staleAfterSeconds?: number;
};

const DEFAULT_LIMIT = 50;
const DEFAULT_STALE_SECONDS = 5 * 60;

export function collectIssueSupervisorSignals(
  db: RunnerDatabase,
  projectID: string,
  now: Date,
  options: SupervisorSignalCollectorOptions = {}
): HeartbeatSupervisorSignals {
  const contexts = supervisorContexts(db, projectID, now, options);
  return {
    candidates: contexts.flatMap((context) => candidateSignals(context, now, options)),
    provider_retry_windows: contexts.flatMap(retryWindowSignals),
    recovery_budget: contexts.map(recoveryBudgetSignal).filter(Boolean) as HeartbeatSupervisorBudgetSignal[],
    stale_session_diagnostics: contexts.map(staleDiagnosticSignal)
  };
}

export function supervisorCandidateReady(
  context: IssueSupervisorRecoveryContext,
  candidate: SupervisorCandidate,
  now: Date,
  options: Pick<SupervisorSignalCollectorOptions, "staleAfterSeconds"> = {}
): boolean {
  if (futureTime(candidate.wait_until, now)) return false;
  if (candidate.diagnosis_code === "provider_retry_after_waiting") return false;
  if (candidate.diagnosis_code === "provider_retry_after_ready") return true;
  if (candidate.exhausted || isAutomaticRecoveryBlockedDiagnosis(candidate.diagnosis_code)) return true;
  if (clean(context.issue.status) === "failed" && isTransientRecoveryDiagnosis(candidate.diagnosis_code)) return true;
  if (candidate.diagnosis_code === "session_no_recent_progress" && stoppedContextSession(context)) return true;
  if (isTransientRecoveryDiagnosis(candidate.diagnosis_code)) return staleGapSeconds(context) >= staleAfterSeconds(options);
  return false;
}

function supervisorContexts(
  db: RunnerDatabase,
  projectID: string,
  now: Date,
  options: SupervisorSignalCollectorOptions
): IssueSupervisorRecoveryContext[] {
  return scanIssueIDs(db, projectID, now, options).map((issueID) => buildIssueSupervisorRecoveryContext(db, issueID, {
    now,
    staleAfterSeconds: staleAfterSeconds(options)
  }));
}

function scanIssueIDs(
  db: RunnerDatabase,
  projectID: string,
  now: Date,
  options: SupervisorSignalCollectorOptions
): number[] {
  const scoped = options.issueIDs?.filter((id) => Number.isSafeInteger(id) && id > 0) ?? [];
  if (scoped.length > 0) return scoped.slice(0, limit(options));
  const nowText = iso(now);
  return db.sqlite.query<{ id: number }, [string, string]>(`
    select distinct i.id from issues i
    left join issue_runs ir on ir.issue_id=i.id
    where i.project_id=? and i.status not in ('done', 'cancelled') and (
      i.status='in_progress' or ir.ended_at='' or (
        i.auto_retry_next_at<>'' and i.auto_retry_next_at<=?
      )
    )
    order by i.updated_at asc, i.id asc limit ${limit(options)}
  `).all(projectID, nowText).map((row) => row.id);
}

function candidateSignals(
  context: IssueSupervisorRecoveryContext,
  now: Date,
  options: SupervisorSignalCollectorOptions
): HeartbeatSupervisorCandidateSignal[] {
  return context.candidates.map((candidate) => ({
    allowed_actions: stringArray(context.policy.allowed_actions),
    budget_remaining: numberValue(context.recovery_history.budget_remaining),
    cooldown_until: cooldownUntil(context, now),
    diagnosis_code: candidate.diagnosis_code,
    evidence_refs: candidate.evidence_refs ?? [],
    issue_status: clean(context.issue.status),
    issue_updated_at: clean(context.issue.updated_at),
    issue_id: issueID(context),
    project_id: projectID(context),
    project_budget_remaining: numberValue(context.policy.project_budget_remaining),
    provider: clean(context.session.provider) || clean(context.provider_error?.provider),
    provider_error_category: clean(context.provider_error?.category),
    provider_session_id: clean(context.session.provider_session_id),
    provider_turn_id: clean(context.session.provider_turn_id),
    ready: supervisorCandidateReady(context, candidate, now, options),
    reason: candidate.reason,
    run_ended_at: clean(context.latest_run?.ended_at),
    run_id: clean(context.latest_run?.id),
    run_status: clean(context.latest_run?.status),
    session_status: clean(context.session.raw_status),
    session_turn_id: clean(context.session.provider_turn_id),
    session_updated_at: clean(context.session.updated_at),
    stale_gap_seconds: staleGapSeconds(context),
    wait_until: clean(candidate.wait_until)
  }));
}

function retryWindowSignals(context: IssueSupervisorRecoveryContext): HeartbeatSupervisorRetryWindowSignal[] {
  return context.candidates.filter((candidate) => clean(candidate.wait_until) !== "").map((candidate) => ({
    diagnosis_code: candidate.diagnosis_code,
    issue_id: issueID(context),
    project_id: projectID(context),
    provider_error_category: clean(context.provider_error?.category),
    reason: candidate.reason,
    retry_after_at: clean(candidate.wait_until)
  }));
}

function recoveryBudgetSignal(context: IssueSupervisorRecoveryContext): HeartbeatSupervisorBudgetSignal | null {
  const issue = issueID(context);
  if (issue <= 0) return null;
  return {
    attempts_24h: numberValue(context.recovery_history.attempts_24h),
    budget_remaining: numberValue(context.recovery_history.budget_remaining),
    issue_id: issue,
    project_budget_remaining: numberValue(context.policy.project_budget_remaining),
    project_id: projectID(context)
  };
}

function staleDiagnosticSignal(context: IssueSupervisorRecoveryContext): HeartbeatStaleSessionDiagnostic {
  return {
    issue_id: issueID(context),
    project_id: projectID(context),
    provider_session_id: clean(context.session.provider_session_id),
    run_id: clean(context.latest_run?.id),
    run_state: clean(context.session.run_state),
    stale_gap_seconds: staleGapSeconds(context),
    status: clean(context.session.status),
    updated_at: clean(context.session.updated_at)
  };
}


function stoppedContextSession(context: IssueSupervisorRecoveryContext): boolean {
  const statuses = [clean(context.session.raw_status), clean(context.session.status)];
  return statuses.some((status) => ["idle", "stopped", "completed", "done", "failed", "error"].includes(status.toLowerCase()));
}

function staleAfterSeconds(options: Pick<SupervisorSignalCollectorOptions, "staleAfterSeconds">): number {
  return positiveNumber(options.staleAfterSeconds, DEFAULT_STALE_SECONDS);
}

function staleGapSeconds(context: IssueSupervisorRecoveryContext): number {
  return numberValue(context.session.stale_gap_seconds);
}

function limit(options: SupervisorSignalCollectorOptions): number {
  return Math.min(positiveNumber(options.limit, DEFAULT_LIMIT), DEFAULT_LIMIT);
}

function futureTime(value: string | undefined, now: Date): boolean {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) && ms > now.getTime();
}

function issueID(context: IssueSupervisorRecoveryContext): number {
  return numberValue(context.issue.id);
}

function projectID(context: IssueSupervisorRecoveryContext): string {
  return clean(context.project.id);
}

function cooldownUntil(context: IssueSupervisorRecoveryContext, now: Date): string {
  const last = Date.parse(clean(context.recovery_history.last_action_at));
  const seconds = numberValue(context.policy.cooldown_seconds);
  if (!Number.isFinite(last) || seconds <= 0) return "";
  const until = new Date(last + seconds * 1_000);
  return until.getTime() > now.getTime() ? iso(until) : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
