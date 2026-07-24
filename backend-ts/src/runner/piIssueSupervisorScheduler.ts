import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createIssueSupervisorEvent,
  getPiSupervisor,
  listIssueSupervisorEvents
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import {
  buildIssueSupervisorRecoveryContextAsync,
  type IssueSupervisorRecoveryContext
} from "../pi/issueSupervisorContext.ts";
import { supervisorCandidateReady } from "../pi/issueSupervisorSignalCollector.ts";
import { isTransientRecoveryDiagnosis } from "../pi/recoveryDiagnosis.ts";
import {
  runPiSupervisorDecision,
  type PiSupervisorDecisionRuntimeResult
} from "../pi/issueSupervisorDecision.ts";
import { applyIssueSupervisorDecisionActions } from "../pi/issueSupervisorActions.ts";
import { ingestPiGuardianEvent } from "../pi/guardianEventIngest.ts";
import { iso } from "../pi/heartbeatOrchestratorSupport.ts";
import { recordBudgetExhaustedEscalation } from "./piIssueSupervisorBudgetEscalation.ts";
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
  const targets = await collectTargets(input.database, now, input);
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
      if (recordTarget(input.database, target, now)) {
        result.skipped += 1;
        continue;
      }
      const decision = await decideTarget(input, target, now);
      if (!decision.valid) result.failed += 1;
      await applyIssueSupervisorDecisionActions({
        context: target.context,
        database: input.database,
        decision: decision.decision,
        now,
        providers: input.providers,
        recordDecision: Boolean(input.runDecision)
      });
      result.decisions += 1;
    } catch (error) {
      result.failed += 1;
      recordFailure(input.database, target, error, now);
    } finally {
      activeSupervisorIssues.delete(key);
    }
  }
  return result;
}
async function collectTargets(
  db: RunnerDatabase,
  now: Date,
  options: Pick<PiIssueSupervisorSchedulerInput, "limit" | "staleAfterSeconds">
): Promise<{ ready: SupervisorTarget[]; scanned: number; signaled: number }> {
  const issueIDs = scanIssueIDs(db, now, options.limit ?? DEFAULT_LIMIT);
  const ready: SupervisorTarget[] = [];
  let signaled = 0;
  for (const issueID of issueIDs) {
    const issue = getIssue(db, issueID);
    if (!issue) continue;
    let context = await buildIssueSupervisorRecoveryContextAsync(db, issueID, {
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
      context = await buildIssueSupervisorRecoveryContextAsync(db, issueID, {
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
  if (isTransientRecoveryDiagnosis(candidate.diagnosis_code) && cooldownBlocksCandidate(context, candidate, now)) return false;
  if (supervisorCandidateReady(context, candidate, now, { staleAfterSeconds: options.staleAfterSeconds })) return true;
  return candidate.diagnosis_code === "provider_retry_after_waiting" &&
    clean(candidate.source_event_type) !== "issue.retry_after_scheduled";
}

function cooldownBlocksCandidate(
  context: IssueSupervisorRecoveryContext,
  candidate: IssueSupervisorRecoveryContext["candidates"][number],
  now: Date
): boolean {
  if (candidate.diagnosis_code === "provider_retry_after_ready" &&
    clean(context.recovery_history.last_action_type) === "issue.retry_after") return false;
  const until = Date.parse(cooldownUntil(context, now));
  return Number.isFinite(until) && until > now.getTime();
}

function scanIssueIDs(db: RunnerDatabase, now: Date, limit: number): number[] {
  const nowText = iso(now);
  const recentFailedCutoff = iso(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return db.sqlite.query<{ id: number }, [string, string]>(`
    select distinct i.id from issues i
    left join issue_runs ir on ir.issue_id=i.id
    left join project_pi_policies policy on policy.project_id=i.project_id
    where i.status='in_progress' or ir.ended_at='' or (i.auto_retry_next_at<>'' and i.auto_retry_next_at<=?)
      or (i.status='failed' and policy.supervisor_mode='autonomous' and i.updated_at>=?)
    order by i.updated_at asc, i.id asc limit ${boundedLimit(limit)}
  `).all(nowText, recentFailedCutoff).map((row) => row.id);
}
function recordTarget(db: RunnerDatabase, target: SupervisorTarget, now: Date): boolean {
  const exhausted = target.candidates.find((candidate) => candidate.exhausted);
  if (exhausted) {
    recordBudgetExhaustedEscalation(db, { ...target, candidate: exhausted }, now);
    return true;
  }
  recordSignal(db, target, now);
  return false;
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
}

async function decideTarget(
  input: PiIssueSupervisorSchedulerInput,
  target: SupervisorTarget,
  now: Date
): Promise<PiSupervisorDecisionRuntimeResult> {
  if (input.runDecision) return input.runDecision(target.context);
  const agent = getPiSupervisor(input.database);
  if (!agent || agent.enabled !== 1) throw new Error("PI Supervisor Agent is missing or disabled");
  const project = getProject(input.database, target.projectID);
  if (!project) throw new Error(`PI Supervisor project is unavailable: ${target.projectID}`);
  return runPiSupervisorDecision({
    agent,
    context: target.context,
    database: input.database,
    now,
    project
  });
}

function recordFailure(db: RunnerDatabase, target: SupervisorTarget, error: unknown, now: Date): void {
  const message = `PI Supervisor unavailable for issue #${target.issueID}: ${safeError(error)}`;
  createIssueSupervisorEvent(db, {
    decision: "needs_user",
    diagnosis_code: primaryDiagnosis(target.context),
    event_type: "decision_failed",
    issue_id: target.issueID,
    payload_json: {
      error: safeError(error),
      recovery_message: message,
      supervisor_agent: { runnable: false, source: "pi_supervisor_runtime" }
    },
    project_id: target.projectID,
    provider: clean(target.context.session.provider) || clean(target.context.provider_error?.provider),
    provider_error_category: clean(target.context.provider_error?.category),
    provider_session_id: clean(target.context.session.provider_session_id),
    provider_turn_id: clean(target.context.session.provider_turn_id),
    run_id: clean(target.context.latest_run?.id)
  });
  ingestPiGuardianEvent(db, {
    eventType: "guardian.pi_supervisor.unavailable",
    idempotencyKey: `pi-supervisor-unavailable:${target.projectID}:${target.issueID}:${primaryDiagnosis(target.context)}`,
    issueID: target.issueID,
    normalizedPayload: {
      diagnosis_code: "pi_supervisor_unavailable",
      message,
      requires_user: true
    },
    projectID: target.projectID,
    severity: "actionable",
    source: "pi_supervisor",
    sourceEventID: `supervisor:${target.projectID}:${target.issueID}:${iso(now)}`,
    status: "pending"
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
    if (!["budget_exhausted", "decision", "action", "result"].includes(event.event_type)) return false;
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

function cooldownUntil(context: IssueSupervisorRecoveryContext, now: Date): string {
  const last = Date.parse(clean(context.recovery_history.last_action_at));
  const seconds = numberValue(context.policy.cooldown_seconds);
  if (!Number.isFinite(last) || seconds <= 0) return "";
  const until = new Date(last + seconds * 1_000);
  return until.getTime() > now.getTime() ? iso(until) : "";
}
