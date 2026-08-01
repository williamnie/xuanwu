import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, type IssueEvent } from "../db/repositories/issueEvents.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { listAgentSessions, type AgentSession } from "../db/repositories/agentSessions.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { issueStateSnapshot, type IssueStateSnapshot } from "./issueStateSnapshot.ts";
export { applyIssueStateRepair } from "./issueStateRepairExecutor.ts";

export type IssueStateEvidence = {
  ref: string; source: "event" | "issue" | "policy" | "project" | "run" | "session"; summary: string; timestamp: string;
};
export type IssueStateRepairOperation = "comment" | "enqueue" | "request_pi_decision";
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
  options: IssueStateManagerOptions & { diagnosisCode: string; operation: IssueStateRepairOperation }
): Record<string, unknown> {
  const diagnostics = diagnoseIssueState(db, { ...options, includeDoneIssues: true, issueIDs: [issueID] }).diagnostics;
  const diagnostic = diagnostics.find((item) => item.code === options.diagnosisCode);
  if (!diagnostic) throw new Error(`issue diagnosis ${options.diagnosisCode} is not current`);
  const action = diagnostic.recommended_actions.find((item) => item.operation === options.operation);
  if (!action) throw new Error(`diagnosis ${diagnostic.code} does not allow operation ${options.operation}`);
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
  const events = listIssueEvents(db, issue.id, { hydrateArtifacts: false, limit: 500 });
  const latestRun = runs.at(-1);
  if (issue.status === "todo" && todoNeedsRuntime(runs, sessions)) return [todoWithoutSession(db, issue, latestRun, sessions[0], now)];
  if (issue.status === "in_progress") return inProgressDiagnostics(issue, latestRun, sessions, events, options, now);
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
  if (piDecisionAlreadyRequested(events, latestRun?.id ?? "")) return [];
  if (runEnded(latestRun) || terminalSession(session)) return [inProgressEnded(issue, latestRun, session)];
  if (staleIssue(issue, latestRun, session, options, now)) return [staleInProgress(issue, latestRun, session, now)];
  return [];
}

function inProgressEnded(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, "issue still in_progress"), runEvidence(run), sessionEvidence(session)]);
  return diagnostic(issue, "in_progress_session_ended", "repair", evidence, [
    action(issue, "request_pi_decision", evidence, "Freeze the ended Provider Turn and ask PI to decide the Issue.", undefined, undefined, issueStateSnapshot(issue, run, session))
  ]);
}

function staleInProgress(issue: Issue, run: IssueRun | undefined, session: AgentSession | undefined, now: Date): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, `inactive for ${duration(now.getTime() - parseTime(latestActivity(issue, run, session)))}`), runEvidence(run), sessionEvidence(session)]);
  return diagnostic(issue, "stale_in_progress", "needs_user", evidence, [action(issue, "comment", evidence, "Escalate stale in-progress issue for user decision.", {
    body: `State manager: issue #${issue.id} appears stale; please decide whether to resume, retry, or cancel.`
  }, undefined, issueStateSnapshot(issue, run, session))]);
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

function piDecisionAlreadyRequested(events: IssueEvent[], runID: string): boolean {
  if (runID === "") return false;
  return events.some((event) => {
    if (event.type !== "issue.pi_acceptance_requested.v1") return false;
    try {
      return cleanString((JSON.parse(event.payload) as Record<string, unknown>).issue_run_id) === runID;
    } catch {
      return false;
    }
  });
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
function terminalSession(session: AgentSession | undefined): boolean {
  return ["aborted", "cancelled", "completed", "done", "error", "failed", "stopped"].includes(normalize(session?.status ?? ""));
}
function activeSession(session: AgentSession | undefined): boolean { return ["active", "running", "inprogress", "busy"].includes(normalize(session?.status ?? "")); }
function parseTime(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY; }
function finiteTime(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback; }
function duration(ms: number): string { const minutes = Math.max(0, Math.round(ms / 60_000)); return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`; }
function normalize(value: string): string { return value.toLowerCase().replace(/[_\s-]/g, ""); }
function safeText(value: string): string { return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]"); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function iso(date: Date): string { return date.toISOString().replace(/\.\d{3}Z$/, "Z"); }
