import { normalizePiActionEnvelope } from "./actionEnvelope.ts";
import { pendingVerificationTimeoutCandidates } from "./heartbeatVerificationPlanner.ts";
import type { HeartbeatActionCandidate, HeartbeatSignals } from "./heartbeatTypes.ts";
import type { ProjectFinding } from "./projectFindings.ts";

export type HeartbeatPlannerOptions = {
  now?: Date;
  pendingVerificationTimeoutMs?: number;
  projectID?: string;
};

type IssueSummary = { id: number; status: string; title: string; updated_at: string };
const HEARTBEAT_SOURCE = "pi_heartbeat";

export function planHeartbeatActions(
  signals: HeartbeatSignals,
  options: HeartbeatPlannerOptions = {}
): HeartbeatActionCandidate[] {
  const projectID = plannerProjectID(signals, options.projectID);
  const now = options.now ?? new Date();
  const context = { now, pendingVerificationTimeoutMs: options.pendingVerificationTimeoutMs, projectID };
  return uniqueCandidates([
    ...findingCandidates(signals, context),
    ...todoWithoutSessionCandidates(signals, context),
    ...pendingVerificationTimeoutCandidates(signals, context),
    ...supervisorDecisionCandidates(signals, context)
  ]);
}

type PlannerContext = {
  now: Date; pendingVerificationTimeoutMs?: number; projectID: string;
};

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

function supervisorDecisionCandidates(signals: HeartbeatSignals, context: PlannerContext): HeartbeatActionCandidate[] {
  return (signals.supervisor?.candidates ?? [])
    .filter((item) => item.ready && item.issue_id > 0)
    .map((item) => candidate({
      actionType: "issue.supervisor_decision",
      issueID: item.issue_id,
      payload: {
        diagnosis_code: item.diagnosis_code,
        issue_id: item.issue_id,
        reason: item.reason,
        suggested_operation: "run_pi_supervisor_decision",
        wait_until: item.wait_until
      },
      projectID: item.project_id || context.projectID,
      rationale: `Ask Supervisor to decide recovery for issue #${item.issue_id}: ${item.diagnosis_code}`
    }));
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

function plannerProjectID(signals: HeartbeatSignals, projectID: string | undefined): string {
  return cleanString(projectID) || cleanString(signals.project?.id) || cleanString(signals.project_settings.project.id);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
