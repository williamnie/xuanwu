import { normalizePiActionEnvelope } from "./actionEnvelope.ts";
import type { HeartbeatActionCandidate, HeartbeatSignals } from "./heartbeatTypes.ts";
import type { ProjectFinding } from "./projectFindings.ts";

export type HeartbeatPlannerOptions = {
  now?: Date;
  pendingVerificationTimeoutMs?: number;
  projectID?: string;
};

type IssueSummary = { id: number; status: string; title: string; updated_at: string };
type PendingIssue = Pick<IssueSummary, "id" | "updated_at">;

const DEFAULT_PENDING_VERIFICATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_SOURCE = "pi_heartbeat";

export function planHeartbeatActions(
  signals: HeartbeatSignals,
  options: HeartbeatPlannerOptions = {}
): HeartbeatActionCandidate[] {
  const projectID = plannerProjectID(signals, options.projectID);
  const now = options.now ?? new Date();
  const timeout = options.pendingVerificationTimeoutMs ?? DEFAULT_PENDING_VERIFICATION_TIMEOUT_MS;
  const context = { now, pendingVerificationTimeoutMs: timeout, projectID };
  return uniqueCandidates([
    ...findingCandidates(signals, context),
    ...todoWithoutSessionCandidates(signals, context),
    ...pendingVerificationTimeoutCandidates(signals, context)
  ]);
}

type PlannerContext = { now: Date; pendingVerificationTimeoutMs: number; projectID: string };

function findingCandidates(signals: HeartbeatSignals, context: PlannerContext): HeartbeatActionCandidate[] {
  return (signals.project?.findings ?? []).flatMap((finding) => {
    if (finding.action_candidate) return [actionCandidate(finding, context.projectID)];
    if (!isRetryableFinding(finding)) return [];
    return [candidate({
      actionType: "issue.retry_proposal",
      issueID: finding.issue_id,
      payload: { issue_id: finding.issue_id },
      projectID: context.projectID,
      rationale: `Retry issue #${finding.issue_id} after retryable heartbeat finding: ${finding.reason}`
    })];
  });
}

function actionCandidate(finding: ProjectFinding, projectID: string): HeartbeatActionCandidate {
  return candidate({
    actionType: finding.action_candidate?.action_type ?? "",
    issueID: finding.issue_id,
    payload: finding.action_candidate?.payload ?? {},
    projectID,
    rationale: finding.action_candidate?.rationale ?? ""
  });
}

function todoWithoutSessionCandidates(signals: HeartbeatSignals, context: PlannerContext): HeartbeatActionCandidate[] {
  return latestIssues(signals)
    .filter((issue) => issue.status === "todo" && !hasActiveIssueSession(signals, issue.id) && !hasOpenIssueRun(signals, issue.id))
    .map((issue) => candidate({
      actionType: "issue.enqueue",
      issueID: issue.id,
      payload: { issue_id: issue.id, suggested_operation: todoSuggestedOperation(signals) },
      projectID: context.projectID,
      rationale: `Enqueue or kick todo issue #${issue.id} because heartbeat signals show no active linked runtime.`
    }));
}

function pendingVerificationTimeoutCandidates(
  signals: HeartbeatSignals,
  context: PlannerContext
): HeartbeatActionCandidate[] {
  return pendingVerificationIssues(signals)
    .filter((issue) => isTimedOut(issue.updated_at, context.now, context.pendingVerificationTimeoutMs))
    .map((issue) => candidate({
      actionType: "needs_user.escalate",
      issueID: issue.id,
      payload: {
        body: `Heartbeat planner: issue #${issue.id} has been pending verification for ${duration(ageMs(issue.updated_at, context.now))}.`,
        issue_id: issue.id,
        reason: "pending_verification_timeout",
        requested_action: "review or request verifier follow-up"
      },
      projectID: context.projectID,
      rationale: timeoutRationale(issue, context.now)
    }));
}

function pendingVerificationIssues(signals: HeartbeatSignals): PendingIssue[] {
  const map = new Map<number, PendingIssue>();
  for (const issue of latestIssues(signals).filter((item) => item.status === "pending_verification")) {
    map.set(issue.id, issue);
  }
  for (const finding of signals.project?.findings ?? []) {
    if (finding.status === "pending_verification" && finding.issue_id > 0 && !map.has(finding.issue_id)) {
      map.set(finding.issue_id, { id: finding.issue_id, updated_at: finding.updated_at });
    }
  }
  return [...map.values()];
}

function candidate(input: {
  actionType: string; issueID: number; payload: Record<string, unknown>;
  projectID: string; rationale: string;
}): HeartbeatActionCandidate {
  return normalizePiActionEnvelope({
    action_type: input.actionType,
    issue_id: input.issueID,
    payload: input.payload,
    project_id: input.projectID,
    rationale: input.rationale,
    risk_level: "medium",
    source: HEARTBEAT_SOURCE
  });
}

function uniqueCandidates(candidates: HeartbeatActionCandidate[]): HeartbeatActionCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = `${item.action_type}:${item.project_id ?? ""}:${item.issue_id ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestIssues(signals: HeartbeatSignals): IssueSummary[] {
  return signals.project?.latest_issues ?? [];
}

function hasActiveIssueSession(signals: HeartbeatSignals, issueID: number): boolean {
  return [...signals.agent_sessions.recent, ...(signals.project?.recent_sessions ?? []), ...(signals.project?.session_progress ?? [])]
    .some((session) => session.issue_id === issueID && activeSessionStatus(session.status));
}

function hasOpenIssueRun(signals: HeartbeatSignals, issueID: number): boolean {
  return [...signals.issue_runs.recent, ...(signals.project?.recent_runs ?? [])]
    .some((run) => run.issue_id === issueID && (run.ended_at === "" || run.status === "in_progress"));
}

function activeSessionStatus(status: string): boolean {
  return ["active", "busy", "inprogress", "running"].includes(status.toLowerCase().replace(/[_\s-]/g, ""));
}

function todoSuggestedOperation(signals: HeartbeatSignals): string {
  return signals.project_settings.project.auto_run === 1 ? "kick_project_loop" : "enqueue";
}

function isRetryableFinding(finding: ProjectFinding): boolean {
  return finding.issue_id > 0 && finding.category === "transient" &&
    (finding.status === "failed" || finding.reason === "transient_retry_waiting");
}

function isTimedOut(updatedAt: string, now: Date, timeoutMs: number): boolean {
  return ageMs(updatedAt, now) >= timeoutMs;
}

function ageMs(updatedAt: string, now: Date): number {
  const updated = Date.parse(updatedAt);
  return Number.isFinite(updated) ? now.getTime() - updated : 0;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function timeoutRationale(issue: PendingIssue, now: Date): string {
  return `Escalate issue #${issue.id} because it has been pending verification for ${duration(ageMs(issue.updated_at, now))}.`;
}

function plannerProjectID(signals: HeartbeatSignals, projectID: string | undefined): string {
  return cleanString(projectID) || cleanString(signals.project?.id) || cleanString(signals.project_settings.project.id);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
