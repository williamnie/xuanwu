import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, type IssueEvent } from "../db/repositories/issueEvents.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { listAgentSessions, type AgentSession } from "../db/repositories/agentSessions.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { defaultFindingCategory, evaluateFailedRetryPolicy, projectRetryPolicy, type FailedRetryPolicy } from "./failedRetryPolicy.ts";
import { hasVerificationEvidence, pendingVerificationDiagnostics } from "./issueStateVerification.ts";
import { currentIssueStateSnapshot, issueStateSnapshot, type IssueStateSnapshot } from "./issueStateSnapshot.ts";
export { applyIssueStateRepair } from "./issueStateRepairExecutor.ts";

export type IssueStateEvidence = {
  ref: string; source: "event" | "issue" | "policy" | "project" | "run" | "session"; summary: string; timestamp: string;
};
export type IssueStateRepairOperation = "comment" | "enqueue" | "move_status" | "patch_status" | "retry";
export type IssueStateSuggestedOperation = "enqueue" | "kick_project_loop";
export type IssueStateAction = {
  action_type: "issue.state_repair"; evidence_refs: string[]; issue_id: number;
  operation: IssueStateRepairOperation; patch?: Record<string, string>; rationale: string;
  suggested_operation?: IssueStateSuggestedOperation; expected_state: IssueStateSnapshot;
};
export type IssueStateDiagnostic = {
  code: string; evidence: IssueStateEvidence[]; issue_id: number; project_id: string;
  recommended_actions: IssueStateAction[]; severity: "blocked" | "needs_user" | "repair" | "watch";
  status: string; title: string;
};
export type IssueStateBatchTarget = { deadline_at?: string; issue_ids: number[]; label: string; status?: string };
export type IssueStateManagerOptions = {
  batchTarget?: IssueStateBatchTarget; batchTargets?: IssueStateBatchTarget[]; includeDoneIssues?: boolean; issueIDs?: number[];
  maxRetries?: number; now?: Date; pendingVerificationTimeoutMs?: number; projectID?: string; retryCooldownMs?: number; staleAfterMs?: number;
};
export type IssueStateManagerResult = { batch_targets: IssueStateBatchProgress[]; diagnostics: IssueStateDiagnostic[]; generated_at: string };
export type IssueStateBatchProgress = {
  deadline_at: string; done: number; label: string; off_track_issue_ids: number[]; target: number; target_status: string;
};

const DEFAULT_MAX_RETRIES = 3, DEFAULT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function diagnoseIssueState(db: RunnerDatabase, options: IssueStateManagerOptions = {}): IssueStateManagerResult {
  const now = options.now ?? new Date();
  const issues = candidateIssues(db, options);
  const diagnosticIssues = options.includeDoneIssues ? issues : issues.filter((issue) => issue.status !== "done");
  return {
    batch_targets: batchProgress(issues, normalizedBatchTargets(options)),
    diagnostics: diagnosticIssues.flatMap((issue) => diagnoseOne(db, issue, options, now)),
    generated_at: iso(now)
  };
}

export function recommendedRepairPayload(
  db: RunnerDatabase,
  issueID: number,
  options: IssueStateManagerOptions & { diagnosisCode?: string; operation?: string } = {}
): Record<string, unknown> {
  const diagnostics = diagnoseIssueState(db, { ...options, includeDoneIssues: true, issueIDs: [issueID] }).diagnostics;
  const diagnostic = diagnostics.find((item) => !options.diagnosisCode || item.code === options.diagnosisCode) ?? diagnostics[0];
  if (!diagnostic) throw new Error("issue has no state manager repair recommendation");
  const action = diagnostic.recommended_actions.find((item) => !options.operation || item.operation === options.operation) ?? diagnostic.recommended_actions[0];
  if (!action) throw new Error("diagnosis has no repair action");
  return { ...action, diagnosis_code: diagnostic.code, evidence: diagnostic.evidence };
}

function candidateIssues(db: RunnerDatabase, options: IssueStateManagerOptions): Issue[] {
  const all = listIssues(db, { projectId: cleanString(options.projectID) });
  const ids = new Set(options.issueIDs ?? []);
  return ids.size === 0 ? all : all.filter((issue) => ids.has(issue.id));
}

function diagnoseOne(db: RunnerDatabase, issue: Issue, options: IssueStateManagerOptions, now: Date): IssueStateDiagnostic[] {
  const runs = listIssueRuns(db, issue.id);
  const sessions = issueSessions(db, issue);
  const events = listIssueEvents(db, issue.id);
  const latestRun = runs.at(-1);
  if (issue.status === "todo" && todoNeedsRuntime(runs, sessions)) return [todoWithoutSession(db, issue, latestRun, sessions[0], now)];
  if (issue.status === "in_progress") return inProgressDiagnostics(issue, latestRun, sessions, events, options, now);
  if (issue.status === "failed") return [failedDiagnostic(db, issue, options, now)];
  if (issue.status === "pending_verification") return pendingVerificationDiagnostics(db, issue, events, options.pendingVerificationTimeoutMs, now);
  if (issue.status === "done" && !hasVerificationEvidence(issue, latestRun, events)) return [doneMissingEvidence(issue, latestRun, sessions[0], events)];
  return [];
}

function todoWithoutSession(
  db: RunnerDatabase,
  issue: Issue,
  latestRun: IssueRun | undefined,
  latestSession: AgentSession | undefined,
  now: Date
): IssueStateDiagnostic {
  const evidence = compact([
    issueEvidence(issue, "todo issue has no active issue_run or agent_session"),
    runEvidence(latestRun),
    sessionEvidence(latestSession),
    projectRunnerEvidence(db, issue, now)
  ]);
  const suggested = todoSuggestedOperation(db, issue);
  return diagnostic(issue, "todo_without_session", "watch", evidence, [
    action(issue, "enqueue", evidence, "Re-enqueue or kick the project loop for todo issue without active runtime session.", undefined, suggested, issueStateSnapshot(issue, latestRun, latestSession))
  ]);
}

function inProgressDiagnostics(
  issue: Issue,
  latestRun: IssueRun | undefined,
  sessions: AgentSession[],
  events: IssueEvent[],
  options: IssueStateManagerOptions,
  now: Date
): IssueStateDiagnostic[] {
  const session = sessions[0];
  if (runEnded(latestRun) || terminalSession(session)) return [inProgressEnded(issue, latestRun, session, events)];
  if (staleIssue(issue, latestRun, session, options, now)) return [staleInProgress(issue, latestRun, session, now)];
  return [];
}

function inProgressEnded(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined, events: IssueEvent[]): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, "issue still in_progress"), runEvidence(run), sessionEvidence(session)]);
  const failed = isFailureStatus(run?.status) || isFailureStatus(session?.status) || cleanString(run?.error) !== "";
  const patch: Record<string, string> = failed
    ? { error: run?.error || "session ended with failure", status: "failed" }
    : { status: hasVerificationEvidence(issue, run, events) ? "done" : "pending_verification" };
  return diagnostic(issue, "in_progress_session_ended", "repair", evidence, [
    action(issue, "patch_status", evidence, "Align issue status with ended runtime session.", patch, undefined, issueStateSnapshot(issue, run, session))
  ]);
}

function staleInProgress(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined, now: Date): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, `inactive for ${duration(now.getTime() - parseTime(latestActivity(issue, run, session)))}`), runEvidence(run), sessionEvidence(session)]);
  return diagnostic(issue, "stale_in_progress", "needs_user", evidence, [action(issue, "comment", evidence, "Escalate stale in-progress issue for user decision.", {
    body: `State manager: issue #${issue.id} appears stale; please decide whether to resume, retry, or cancel.`
  }, undefined, issueStateSnapshot(issue, run, session))]);
}

function failedDiagnostic(db: RunnerDatabase, issue: Issue, options: IssueStateManagerOptions, now: Date): IssueStateDiagnostic {
  const retry = failedRetry(db, issue, options, now);
  const snapshot = currentIssueStateSnapshot(db, issue.id);
  const evidence = [issueEvidence(issue, issue.error || "issue failed"), policyEvidence(issue, retry, now)];
  if (!retry.retry_candidate) return nonRetryableFailedDiagnostic(issue, retry, evidence, snapshot);
  return diagnostic(issue, "failed_retry_ready", "repair", evidence, [
    action(issue, "retry", evidence, "Retry failed issue after transient failure cooldown.", undefined, undefined, snapshot)
  ]);
}

function nonRetryableFailedDiagnostic(issue: Issue, retry: ReturnType<typeof failedRetry>, evidence: IssueStateEvidence[], snapshot: IssueStateSnapshot): IssueStateDiagnostic {
  if (retry.reason === "failed_retry_cooling_down") return diagnostic(issue, retry.reason, "watch", evidence, []);
  if (retry.reason === "needs_user") return diagnostic(issue, "needs_user_escalation", "needs_user", evidence, [needsUserAction(issue, evidence, snapshot)]);
  if (retry.reason === "failed_retry_exhausted") return diagnostic(issue, retry.reason, "needs_user", evidence, [needsUserAction(issue, evidence, snapshot)]);
  return diagnostic(issue, "blocked_escalation", "blocked", evidence, [needsUserAction(issue, evidence, snapshot)]);
}

function doneMissingEvidence(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined, events: IssueEvent[]): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, "status done without verification evidence"), runEvidence(run), latestEventEvidence(events)]);
  return diagnostic(issue, "done_missing_verification_evidence", "repair", evidence, [
    action(issue, "patch_status", evidence, "Move weak done issue back to pending verification for evidence review.", { status: "pending_verification" }, undefined, issueStateSnapshot(issue, run, session))
  ]);
}

function diagnostic(issue: Issue, code: string, severity: IssueStateDiagnostic["severity"], evidence: IssueStateEvidence[], actions: IssueStateAction[]): IssueStateDiagnostic {
  return { code, evidence, issue_id: issue.id, project_id: issue.project_id, recommended_actions: actions, severity, status: issue.status, title: safeText(issue.title) };
}

function action(
  issue: Issue,
  operation: IssueStateRepairOperation,
  evidence: IssueStateEvidence[],
  rationale: string,
  patch?: Record<string, string>,
  suggestedOperation?: IssueStateSuggestedOperation,
  expectedState?: IssueStateSnapshot
): IssueStateAction {
  return {
    action_type: "issue.state_repair",
    evidence_refs: evidence.map((item) => item.ref),
    expected_state: expectedState ?? issueStateSnapshot(issue, undefined, undefined),
    issue_id: issue.id,
    operation,
    ...(patch ? { patch } : {}),
    rationale,
    ...(suggestedOperation ? { suggested_operation: suggestedOperation } : {})
  };
}

function needsUserAction(issue: Issue, evidence: IssueStateEvidence[], snapshot: IssueStateSnapshot): IssueStateAction {
  return action(issue, "comment", evidence, "Escalate blocked or needs-user issue for human decision.", {
    body: `State manager: issue #${issue.id} needs user input before retrying or closing.`
  }, undefined, snapshot);
}

function issueSessions(db: RunnerDatabase, issue: Issue): AgentSession[] {
  return listAgentSessions(db, { projectId: issue.project_id }).filter((session) => session.issue_id === issue.id || (
    issue.codex_thread_id !== "" && session.provider === "codex" && session.provider_session_id === issue.codex_thread_id
  ));
}

function batchProgress(issues: Issue[], targets: IssueStateBatchTarget[]): IssueStateBatchProgress[] {
  const byID = new Map(issues.map((issue) => [issue.id, issue]));
  return targets.map((target) => {
    const status = cleanString(target.status) || "done";
    const offTrack = target.issue_ids.filter((id) => byID.get(id)?.status !== status);
    return { deadline_at: cleanString(target.deadline_at), done: target.issue_ids.length - offTrack.length, label: target.label, off_track_issue_ids: offTrack, target: target.issue_ids.length, target_status: status };
  });
}

function normalizedBatchTargets(options: IssueStateManagerOptions): IssueStateBatchTarget[] {
  return [...(options.batchTargets ?? []), ...(options.batchTarget ? [options.batchTarget] : [])];
}

function policyEvidence(issue: Issue, retry: ReturnType<typeof failedRetry>, now: Date): IssueStateEvidence {
  const max = retry.max_attempts;
  const next = finiteTime(parseTime(retry.next_retry_at), now.getTime());
  return { ref: `policy:retry:${issue.id}`, source: "policy", summary: `attempts=${issue.attempt_count}/${max}; next_retry_at=${iso(new Date(next))}; now=${iso(now)}`, timestamp: iso(now) };
}

function issueEvidence(issue: Issue, summary: string): IssueStateEvidence {
  return { ref: `issue:${issue.id}`, source: "issue", summary: safeText(summary), timestamp: issue.updated_at };
}
function projectRunnerEvidence(db: RunnerDatabase, issue: Issue, now: Date): IssueStateEvidence | undefined {
  const project = getProject(db, issue.project_id);
  if (!project) return undefined;
  const busy = hasActiveExecutorWork(db) ? 1 : 0;
  return { ref: `project:${project.id}:runner`, source: "project", summary: `project auto_run=${project.auto_run}; runner executor_busy=${busy}`, timestamp: iso(now) };
}
function runEvidence(run: IssueRun | undefined): IssueStateEvidence | undefined {
  return run ? { ref: `run:${run.id}`, source: "run", summary: safeText(`attempt ${run.attempt} ${run.status}; ended_at=${run.ended_at}`), timestamp: run.ended_at || run.started_at } : undefined;
}
function sessionEvidence(session: AgentSession | undefined): IssueStateEvidence | undefined {
  return session ? { ref: `session:${session.session_key}`, source: "session", summary: safeText(`session ${session.status || "unknown"}`), timestamp: session.updated_at } : undefined;
}
function latestEventEvidence(events: IssueEvent[]): IssueStateEvidence | undefined {
  const event = events.at(-1);
  return event ? { ref: `event:${event.id}`, source: "event", summary: safeText(`${event.type}: ${event.payload.slice(0, 160)}`), timestamp: event.created_at } : undefined;
}
function failedRetry(db: RunnerDatabase, issue: Issue, options: IssueStateManagerOptions, now: Date) {
  const detail = issue.error || issue.auto_retry_reason || issue.title;
  return evaluateFailedRetryPolicy({
    attemptCount: issue.attempt_count,
    autoRetryNextAt: issue.auto_retry_next_at,
    category: defaultFindingCategory({ autoRetryNextAt: issue.auto_retry_next_at, detail, status: issue.status }),
    now,
    policy: retryPolicy(db, issue.project_id, options),
    updatedAt: issue.updated_at
  });
}
function retryPolicy(db: RunnerDatabase, projectID: string, options: IssueStateManagerOptions): FailedRetryPolicy | null {
  const persisted = projectRetryPolicy(db, projectID);
  if (persisted) return persisted;
  return { enabled: true, max_attempts: options.maxRetries ?? DEFAULT_MAX_RETRIES, backoff_minutes: [Math.max(0, Math.round((options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS) / 60_000))] };
}
function staleIssue(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined, options: IssueStateManagerOptions, now: Date): boolean {
  if (activeSession(session)) return false;
  return now.getTime() - parseTime(latestActivity(issue, run, session)) >= (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
}
function latestActivity(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined): string {
  return [issue.updated_at, run?.ended_at ?? "", run?.started_at ?? "", session?.updated_at ?? ""]
    .filter(Boolean)
    .sort((left, right) => finiteTime(parseTime(left), 0) - finiteTime(parseTime(right), 0))
    .at(-1) ?? issue.updated_at;
}
function compact<T>(items: Array<T | undefined>): T[] { return items.filter((item): item is T => item !== undefined); }
function todoNeedsRuntime(runs: IssueRun[], sessions: AgentSession[]): boolean {
  return !runs.some(openRun) && !sessions.some(activeSession);
}
function todoSuggestedOperation(db: RunnerDatabase, issue: Issue): IssueStateSuggestedOperation {
  return (getProject(db, issue.project_id)?.auto_run ?? 0) === 1 ? "kick_project_loop" : "enqueue";
}
function openRun(run: IssueRun): boolean { return run.ended_at === ""; }
function runEnded(run: IssueRun | undefined): boolean { return Boolean(run?.ended_at); }
function terminalSession(session: AgentSession | undefined): boolean { return ["completed", "done", "failed", "error"].includes(normalize(session?.status ?? "")); }
function activeSession(session: AgentSession | undefined): boolean { return ["active", "running", "inprogress", "busy"].includes(normalize(session?.status ?? "")); }
function isFailureStatus(value: string | undefined): boolean { return ["failed", "error", "failure"].includes(normalize(value ?? "")); }
function parseTime(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY; }
function finiteTime(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback; }
function duration(ms: number): string { const minutes = Math.max(0, Math.round(ms / 60_000)); return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`; }
function normalize(value: string): string { return value.toLowerCase().replace(/[_\s-]/g, ""); }
function safeText(value: string): string { return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]"); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function iso(date: Date): string { return date.toISOString().replace(/\.\d{3}Z$/, "Z"); }
