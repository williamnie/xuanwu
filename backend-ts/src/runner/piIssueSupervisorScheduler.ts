import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createIssueSupervisorEvent,
  getPiAgent,
  getProjectPiSettings,
  listIssueSupervisorEvents,
  listPiAgents,
  type PiAgent
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { applyIssueSupervisorDecisionActions } from "../pi/issueSupervisorActions.ts";
import {
  buildIssueSupervisorRecoveryContext,
  type IssueSupervisorRecoveryContext
} from "../pi/issueSupervisorContext.ts";
import { supervisorCandidateReady } from "../pi/issueSupervisorSignalCollector.ts";
import { runPiSupervisorDecision, type PiSupervisorDecisionRuntimeResult } from "../pi/issueSupervisorDecision.ts";
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
type SupervisorTarget = { context: IssueSupervisorRecoveryContext; issueID: number; projectID: string };
type SupervisorAgentSelection = { agent: PiAgent | null; agentID: string; error: string; source: string };
const activeSupervisorIssues = new Set<string>();
const DEFAULT_LIMIT = 50;
const DEFAULT_FAILURE_COOLDOWN_SECONDS = 300;
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
      if (recentDecisionExists(input, target, now)) {
        result.skipped += 1;
        continue;
      }
      recordSignal(input.database, target);
      if (clean(target.context.policy.mode) === "watchdog") {
        result.skipped += 1;
        continue;
      }
      const decision = await runDecision(input, target.context, now);
      if (!decision.valid) {
        result.skipped += 1;
        continue;
      }
      await applyIssueSupervisorDecisionActions({
        context: target.context,
        database: input.database,
        decision: decision.decision,
        now,
        providers: input.providers,
        recordDecision: input.runDecision !== undefined
      });
      result.decisions += 1;
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
    const progress = refreshSupervisorProgressResult({
      context,
      database: db,
      issueID,
      now,
      projectID: issue.project_id,
      staleAfterSeconds: options.staleAfterSeconds
    });
    if (progress) context = buildIssueSupervisorRecoveryContext(db, issueID, {
      now,
      staleAfterSeconds: options.staleAfterSeconds
    });
    const candidates = context.candidates.filter((candidate) =>
      supervisorCandidateReady(context, candidate, now, { staleAfterSeconds: options.staleAfterSeconds })
    );
    if (context.candidates.length > 0) signaled += 1;
    if (candidates.length === 0) continue;
    ready.push({ context, issueID, projectID: issue.project_id });
  }
  return { ready, scanned: issueIDs.length, signaled };
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
async function runDecision(
  input: PiIssueSupervisorSchedulerInput,
  context: IssueSupervisorRecoveryContext,
  now: Date
): Promise<PiSupervisorDecisionRuntimeResult> {
  if (input.runDecision) return input.runDecision(context);
  const project = requireProject(input.database, clean(context.project.id));
  const selection = selectSupervisorAgent(input.database, project.id);
  if (!selection.agent) throw new Error(selection.error);
  return runPiSupervisorDecision({ agent: selection.agent, context, database: input.database, now, project });
}
function selectSupervisorAgent(db: RunnerDatabase, projectID: string): SupervisorAgentSelection {
  const settingsAgentID = clean(getProjectPiSettings(db, projectID)?.pi_agent_id);
  if (settingsAgentID !== "") return selectProjectSettingsAgent(db, settingsAgentID);
  const globalAgent = listPiAgents(db).find((agent) => agent.enabled === 1) ?? null;
  if (globalAgent) return { agent: globalAgent, agentID: globalAgent.id, error: "", source: "global_fallback" };
  return {
    agent: null,
    agentID: "",
    error: "PI supervisor agent is not runnable: enable a global PI agent or bind project PI settings",
    source: "missing"
  };
}
function selectProjectSettingsAgent(db: RunnerDatabase, agentID: string): SupervisorAgentSelection {
  const agent = getPiAgent(db, agentID);
  if (agent?.enabled === 1) return { agent, agentID, error: "", source: "project_settings" };
  return {
    agent: null,
    agentID,
    error: "PI supervisor agent is not runnable: project PI settings agent is missing or disabled",
    source: "project_settings"
  };
}
function recordSignal(db: RunnerDatabase, target: SupervisorTarget): void {
  const candidate = target.context.candidates[0];
  createIssueSupervisorEvent(db, {
    diagnosis_code: clean(candidate?.diagnosis_code),
    event_type: "signal",
    issue_id: target.issueID,
    payload_json: { candidate, candidates: target.context.candidates },
    project_id: target.projectID,
    provider: clean(target.context.session.provider) || clean(target.context.provider_error?.provider),
    provider_error_category: clean(target.context.provider_error?.category),
    provider_session_id: clean(target.context.session.provider_session_id),
    provider_turn_id: clean(target.context.session.provider_turn_id),
    retry_after_at: clean(candidate?.wait_until),
    run_id: clean(target.context.latest_run?.id)
  });
}
function recordFailure(db: RunnerDatabase, target: SupervisorTarget, error: unknown): void {
  createIssueSupervisorEvent(db, {
    diagnosis_code: primaryDiagnosis(target.context),
    event_type: "decision_failed",
    issue_id: target.issueID,
    payload_json: {
      cooldown_seconds: failureCooldownSeconds(target.context),
      error: safeError(error),
      supervisor_agent: supervisorAgentStatus(selectSupervisorAgent(db, target.projectID))
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
  target: SupervisorTarget,
  now: Date
): boolean {
  if (recentCompletedDecisionExists(input.database, target)) return true;
  return recentUnrunnableAgentFailureExists(input, target, now);
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
function recentUnrunnableAgentFailureExists(
  input: PiIssueSupervisorSchedulerInput,
  target: SupervisorTarget,
  now: Date
): boolean {
  if (input.runDecision) return false;
  if (selectSupervisorAgent(input.database, target.projectID).agent) return false;
  const cutoff = now.getTime() - failureCooldownSeconds(target.context) * 1_000;
  return listIssueSupervisorEvents(input.database, { issueId: target.issueID }).some((event) => (
    event.event_type === "decision_failed" &&
    failedBecauseSupervisorAgent(event.payload_json) &&
    Date.parse(event.created_at) >= cutoff
  ));
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
function requireProject(db: RunnerDatabase, projectID: string): Project {
  const project = getProject(db, projectID);
  if (!project) throw new Error("project not found");
  return project;
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
function failureCooldownSeconds(context: IssueSupervisorRecoveryContext): number {
  const value = Number(context.policy.cooldown_seconds);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_FAILURE_COOLDOWN_SECONDS;
}
function failedBecauseSupervisorAgent(payloadJson: string): boolean {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return clean(payload.error).includes("PI supervisor agent is not runnable");
  } catch {
    return false;
  }
}
function supervisorAgentStatus(selection: SupervisorAgentSelection): Record<string, unknown> {
  return {
    agent_id: selection.agentID || selection.agent?.id || "",
    runnable: selection.agent !== null,
    source: selection.source
  };
}
