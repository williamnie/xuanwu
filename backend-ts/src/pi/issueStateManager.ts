import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment, listIssueEvents, recordIssueEvent, type IssueEvent } from "../db/repositories/issueEvents.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { listAgentSessions, type AgentSession } from "../db/repositories/agentSessions.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type IssueStateEvidence = {
  ref: string; source: "event" | "issue" | "policy" | "project" | "run" | "session"; summary: string; timestamp: string;
};
export type IssueStateRepairOperation = "comment" | "enqueue" | "patch_status" | "retry";
export type IssueStateSuggestedOperation = "enqueue" | "kick_project_loop";
export type IssueStateAction = {
  action_type: "issue.state_repair"; evidence_refs: string[]; issue_id: number;
  operation: IssueStateRepairOperation; patch?: Record<string, string>; rationale: string;
  suggested_operation?: IssueStateSuggestedOperation;
};
export type IssueStateDiagnostic = {
  code: string; evidence: IssueStateEvidence[]; issue_id: number; project_id: string;
  recommended_actions: IssueStateAction[]; severity: "blocked" | "needs_user" | "repair" | "watch";
  status: string; title: string;
};
export type IssueStateBatchTarget = { deadline_at?: string; issue_ids: number[]; label: string; status?: string };
export type IssueStateManagerOptions = {
  batchTarget?: IssueStateBatchTarget; batchTargets?: IssueStateBatchTarget[]; issueIDs?: number[];
  maxRetries?: number; now?: Date; pendingVerificationTimeoutMs?: number; projectID?: string; retryCooldownMs?: number; staleAfterMs?: number;
};
export type IssueStateManagerResult = { batch_targets: IssueStateBatchProgress[]; diagnostics: IssueStateDiagnostic[]; generated_at: string };
export type IssueStateBatchProgress = {
  deadline_at: string; done: number; label: string; off_track_issue_ids: number[]; target: number; target_status: string;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const VERIFY_PATTERN = /verification|verified|verify|验收|验证|测试|tests?\s+(?:passed|failed|ok)|(?:vitest|jest|node --test|npm (?:run )?test|pnpm (?:exec )?vitest|build|lint)\s+(?:passed|failed|ok|success|succeeded)/i;

export function diagnoseIssueState(db: RunnerDatabase, options: IssueStateManagerOptions = {}): IssueStateManagerResult {
  const now = options.now ?? new Date();
  const issues = candidateIssues(db, options);
  return {
    batch_targets: batchProgress(issues, normalizedBatchTargets(options)),
    diagnostics: issues.flatMap((issue) => diagnoseOne(db, issue, options, now)),
    generated_at: iso(now)
  };
}

export function recommendedRepairPayload(
  db: RunnerDatabase,
  issueID: number,
  options: IssueStateManagerOptions & { diagnosisCode?: string; operation?: string } = {}
): Record<string, unknown> {
  const diagnostics = diagnoseIssueState(db, { ...options, issueIDs: [issueID] }).diagnostics;
  const diagnostic = diagnostics.find((item) => !options.diagnosisCode || item.code === options.diagnosisCode) ?? diagnostics[0];
  if (!diagnostic) throw new Error("issue has no state manager repair recommendation");
  const action = diagnostic.recommended_actions.find((item) => !options.operation || item.operation === options.operation) ?? diagnostic.recommended_actions[0];
  if (!action) throw new Error("diagnosis has no repair action");
  return { ...action, diagnosis_code: diagnostic.code, evidence: diagnostic.evidence };
}

export function applyIssueStateRepair(db: RunnerDatabase, payload: Record<string, unknown>): unknown {
  const issueID = positiveID(payload.issue_id);
  const operation = cleanString(payload.operation) as IssueStateRepairOperation;
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const diagnosis = cleanString(payload.diagnosis_code);
  const result = executeRepair(db, issueID, operation, payload);
  recordIssueEvent(db, issueID, "issue.state_manager_repair", { diagnosis_code: diagnosis, evidence, operation });
  return result;
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
  if (issue.status === "failed") return [failedDiagnostic(issue, options, now)];
  if (issue.status === "pending_verification") return pendingDiagnostic(issue, options, now);
  if (issue.status === "done" && !hasVerificationEvidence(issue, latestRun, events)) return [doneMissingEvidence(issue, latestRun, events)];
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
  return diagnostic(issue, "todo_without_session", "watch", evidence, [action(issue, "enqueue", evidence, "Re-enqueue or kick the project loop for todo issue without active runtime session.", undefined, suggested)]);
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
  const patch = failed ? { error: run?.error || "session ended with failure", status: "failed" } : { status: hasVerificationEvidence(issue, run, events) ? "done" : "pending_verification" };
  return diagnostic(issue, "in_progress_session_ended", "repair", evidence, [action(issue, "patch_status", evidence, "Align issue status with ended runtime session.", patch)]);
}

function staleInProgress(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined, now: Date): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, `inactive for ${duration(now.getTime() - parseTime(latestActivity(issue, run, session)))}`), runEvidence(run), sessionEvidence(session)]);
  return diagnostic(issue, "stale_in_progress", "needs_user", evidence, [action(issue, "comment", evidence, "Escalate stale in-progress issue for user decision.", {
    body: `State manager: issue #${issue.id} appears stale; please decide whether to resume, retry, or cancel.`
  })]);
}

function failedDiagnostic(issue: Issue, options: IssueStateManagerOptions, now: Date): IssueStateDiagnostic {
  const evidence = [issueEvidence(issue, issue.error || "issue failed"), policyEvidence(issue, options, now)];
  if (needsUserText(issue.error || issue.title)) return diagnostic(issue, "needs_user_escalation", "needs_user", evidence, [needsUserAction(issue, evidence)]);
  if (!transientText(issue.error || issue.auto_retry_reason || issue.title)) return diagnostic(issue, "blocked_escalation", "blocked", evidence, [needsUserAction(issue, evidence)]);
  if (issue.attempt_count >= (options.maxRetries ?? DEFAULT_MAX_RETRIES)) return diagnostic(issue, "failed_retry_exhausted", "needs_user", evidence, [needsUserAction(issue, evidence)]);
  if (nextRetryAt(issue, options) > now.getTime()) return diagnostic(issue, "failed_retry_cooling_down", "watch", evidence, []);
  return diagnostic(issue, "failed_retry_ready", "repair", evidence, [action(issue, "retry", evidence, "Retry failed issue after transient failure cooldown.")]);
}

function pendingDiagnostic(issue: Issue, options: IssueStateManagerOptions, now: Date): IssueStateDiagnostic[] {
  const age = now.getTime() - parseTime(issue.updated_at);
  if (age < (options.pendingVerificationTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS)) return [];
  const evidence = [issueEvidence(issue, `pending verification for ${duration(age)}`)];
  return [diagnostic(issue, "pending_verification_timeout", "needs_user", evidence, [action(issue, "comment", evidence, "Escalate timed-out verification for user review.", {
    body: `State manager: issue #${issue.id} has been pending verification for ${duration(age)}.`
  })])];
}

function doneMissingEvidence(issue: Issue, run: IssueRun | undefined, events: IssueEvent[]): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, "status done without verification evidence"), runEvidence(run), latestEventEvidence(events)]);
  return diagnostic(issue, "done_missing_verification_evidence", "repair", evidence, [action(issue, "patch_status", evidence, "Move weak done issue back to pending verification for evidence review.", {
    status: "pending_verification"
  })]);
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
  suggestedOperation?: IssueStateSuggestedOperation
): IssueStateAction {
  return {
    action_type: "issue.state_repair",
    evidence_refs: evidence.map((item) => item.ref),
    issue_id: issue.id,
    operation,
    ...(patch ? { patch } : {}),
    rationale,
    ...(suggestedOperation ? { suggested_operation: suggestedOperation } : {})
  };
}

function needsUserAction(issue: Issue, evidence: IssueStateEvidence[]): IssueStateAction {
  return action(issue, "comment", evidence, "Escalate blocked or needs-user issue for human decision.", {
    body: `State manager: issue #${issue.id} needs user input before retrying or closing.`
  });
}

function executeRepair(db: RunnerDatabase, issueID: number, operation: IssueStateRepairOperation, payload: Record<string, unknown>): unknown {
  if (operation === "enqueue") return enqueueIssue(db, issueID);
  if (operation === "retry") return retryIssue(db, issueID);
  const patch = objectPayload(payload.patch);
  if (operation === "patch_status") return updateIssue(db, issueID, patch);
  if (operation === "comment") return createIssueComment(db, issueID, { author: "agent", body: cleanString(patch.body) || cleanString(payload.rationale) });
  throw new Error("unsupported issue state repair operation");
}

function issueSessions(db: RunnerDatabase, issue: Issue): AgentSession[] {
  return listAgentSessions(db, { projectId: issue.project_id }).filter((session) => session.issue_id === issue.id || (
    issue.codex_thread_id !== "" && session.provider === "codex" && session.provider_session_id === issue.codex_thread_id
  ));
}

function hasVerificationEvidence(issue: Issue, run: IssueRun | undefined, events: IssueEvent[]): boolean {
  if (VERIFY_PATTERN.test(issue.error) || VERIFY_PATTERN.test(run?.error ?? "")) return true;
  return events.some((event) => event.type === "issue.verification_reviewed" || event.type === "issue.verification_report" || VERIFY_PATTERN.test(event.payload));
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

function policyEvidence(issue: Issue, options: IssueStateManagerOptions, now: Date): IssueStateEvidence {
  const max = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const next = finiteTime(nextRetryAt(issue, options), now.getTime());
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

function nextRetryAt(issue: Issue, options: IssueStateManagerOptions): number {
  const explicit = parseTime(issue.auto_retry_next_at);
  if (Number.isFinite(explicit)) return explicit;
  const updated = parseTime(issue.updated_at);
  return Number.isFinite(updated) ? updated + (options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS) : Number.NEGATIVE_INFINITY;
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
function objectPayload(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function positiveID(value: unknown): number { if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value; throw new Error("issue_id is required"); }
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
function needsUserText(value: string): boolean { return /needs user|need user|user input|human|manual|approval denied|requires confirmation|waiting for user|blocked by user/i.test(value); }
function transientText(value: string): boolean { return /eof|transport error|network error|connection reset|unexpected eof|timeout|timed out|deadline exceeded|stream disconnected/i.test(value) && !/approval denied|permission denied|test failed|tests failed|verification failed|401|429/i.test(value); }
function normalize(value: string): string { return value.toLowerCase().replace(/[_\s-]/g, ""); }
function safeText(value: string): string { return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]"); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function iso(date: Date): string { return date.toISOString().replace(/\.\d{3}Z$/, "Z"); }
