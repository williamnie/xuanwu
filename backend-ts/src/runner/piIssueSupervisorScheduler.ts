import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createIssueSupervisorEvent,
  getPiSupervisor,
  listIssueSupervisorEvents
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
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
  bus?: Pick<EventBus, "publish">;
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
type SupervisorDecisionSelection = PiSupervisorDecisionRuntimeResult & {
  recordDecision?: boolean;
};
const activeSupervisorIssues = new Set<string>();
const DEFAULT_LIMIT = 50;
const DEFAULT_STALE_SECONDS = 5 * 60;
const MAX_INVALID_DECISIONS_PER_EVIDENCE = 2;
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
      if (recentDecisionExists(input, target, now)) {
        result.skipped += 1;
        continue;
      }
      const boundary = recordTarget(input.database, target, now);
      if (boundary) {
        await applyIssueSupervisorDecisionActions({
          bus: input.bus,
          context: target.context,
          database: input.database,
          decision: boundaryDecision(target, boundary),
          now,
          providers: input.providers,
          recordDecision: false
        });
        continue;
      }
      const decision = await decideTarget(input, target, now);
      result.decisions += 1;
      if (!decision.valid) {
        result.failed += 1;
        continue;
      }
      await applyIssueSupervisorDecisionActions({
        bus: input.bus,
        context: target.context,
        database: input.database,
        decision: decision.decision,
        now,
        providers: input.providers,
        recordDecision: Boolean(input.runDecision) || decision.recordDecision === true
      });
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
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS;
  const ready: SupervisorTarget[] = [];
  let signaled = 0;
  for (const issueID of issueIDs) {
    const issue = getIssue(db, issueID);
    if (!issue) continue;
    let context = await buildIssueSupervisorRecoveryContextAsync(db, issueID, {
      includeWorkspaceGit: false,
      now,
      staleAfterSeconds
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
        includeWorkspaceGit: false,
        now,
        staleAfterSeconds
      });
    }
    const dispatchableCandidates = context.candidates.filter((candidate) =>
      supervisorCandidateDispatchable(context, candidate, now, { staleAfterSeconds })
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
    join project_pi_settings settings on settings.project_id=i.project_id
    join pi_agents supervisor on supervisor.id='runner-default' and supervisor.enabled=1
    where i.status not in ('done', 'cancelled') and (
      i.status='in_progress' or ir.ended_at='' or (i.auto_retry_next_at<>'' and i.auto_retry_next_at<=?)
      or (i.status='failed' and i.updated_at>=?)
    )
    order by i.updated_at asc, i.id asc limit ${boundedLimit(limit)}
  `).all(nowText, recentFailedCutoff).map((row) => row.id);
}
function recordTarget(
  db: RunnerDatabase,
  target: SupervisorTarget,
  now: Date
): "invalid_decision_budget_exhausted" | "recovery_budget_exhausted" | null {
  const exhausted = target.candidates.find((candidate) => candidate.exhausted);
  if (exhausted) {
    recordBudgetExhaustedEscalation(db, { ...target, candidate: exhausted }, now);
    return "recovery_budget_exhausted";
  }
  if (invalidDecisionBudgetExhausted(db, target)) {
    createIssueSupervisorEvent(db, {
      action_type: "needs_user.escalate",
      decision: "needs_user",
      diagnosis_code: primaryDiagnosis(target.context),
      event_type: "budget_exhausted",
      issue_id: target.issueID,
      payload_json: {
        count: MAX_INVALID_DECISIONS_PER_EVIDENCE,
        message: "PI Supervisor repeatedly returned invalid decisions for the same evidence.",
        outcome: "needs_user",
        report_status: "invalid_decision_budget_exhausted"
      },
      project_id: target.projectID,
      provider: clean(target.context.session.provider),
      provider_session_id: clean(target.context.session.provider_session_id),
      provider_turn_id: clean(target.context.session.provider_turn_id),
      run_id: clean(target.context.latest_run?.id)
    });
    return "invalid_decision_budget_exhausted";
  }
  recordSignal(db, target, now);
  return null;
}

function invalidDecisionBudgetExhausted(db: RunnerDatabase, target: SupervisorTarget): boolean {
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

function boundaryDecision(
  target: SupervisorTarget,
  reason: "invalid_decision_budget_exhausted" | "recovery_budget_exhausted"
) {
  const invalid = reason === "invalid_decision_budget_exhausted";
  const message = invalid
    ? "PI Supervisor 对同一批证据连续返回无效决策，已达到最大决策轮次。请检查 Supervisor 模型、Provider 或决策审计。"
    : "PI 自动恢复预算已耗尽，Issue 仍未恢复。请查看最近恢复动作和证据后决定下一步。";
  return {
    confidence: "high" as const,
    decision: "needs_user" as const,
    evidence_refs: invalid ? ["supervisor_decision_failed"] : ["recovery_budget"],
    expected_outcome: "释放执行槽，并把需要人工处理的原因可靠地写入告警和通知。",
    fallback_if_no_progress: "blocked" as const,
    rationale: message,
    recovery_message: message,
    risk_level: "medium" as const
  };
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
): Promise<SupervisorDecisionSelection> {
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
  target: SupervisorTarget,
  now: Date
): boolean {
  return recentCompletedDecisionExists(input.database, target, now);
}
function recentCompletedDecisionExists(db: RunnerDatabase, target: SupervisorTarget, now: Date): boolean {
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
  // Older builds applied their needs_user fallback even after recording an
  // invalid PI decision. Treat that action/result tail as part of the failed
  // decision, otherwise it permanently suppresses a corrected Supervisor.
  if (latestDecisionBoundary?.event_type === "decision_failed") {
    // Reaching the configured decision boundary must immediately hand control
    // to needs_user instead of waiting through another cooldown window.
    if (invalidDecisionBudgetExhausted(db, target)) return false;
    return Date.parse(latestDecisionBoundary.created_at) >= failedDecisionCooldown;
  }
  return matching.some((event) => event.event_type !== "decision_failed");
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
