import { normalizePiActionEnvelope } from "./actionEnvelope.ts";
import type { HeartbeatActionCandidate, HeartbeatSignals } from "./heartbeatTypes.ts";
import { normalizeVerificationPolicy, type VerificationTimeoutAction } from "./verificationPolicy.ts";

type IssueSummary = { id: number; status: string; updated_at: string };
type PendingIssue = Pick<IssueSummary, "id" | "updated_at">;
type Context = { now: Date; onTimeout: VerificationTimeoutAction; timeoutMs: number; projectID: string };

const SOURCE = "pi_heartbeat";

export function pendingVerificationTimeoutCandidates(signals: HeartbeatSignals, input: {
  now: Date; pendingVerificationTimeoutMs?: number; projectID: string;
}): HeartbeatActionCandidate[] {
  const policy = normalizeVerificationPolicy(signals.project_settings.pi_policy?.verification_policy);
  const context = { now: input.now, onTimeout: policy.on_timeout, timeoutMs: input.pendingVerificationTimeoutMs ?? policy.pending_timeout_ms, projectID: input.projectID };
  return pendingVerificationIssues(signals).filter((issue) => timedOut(issue, context)).map((issue) => timeoutCandidate(issue, context));
}

function timeoutCandidate(issue: PendingIssue, context: Context): HeartbeatActionCandidate {
  return context.onTimeout === "request_verifier" ? verifierCandidate(issue, context) : escalationCandidate(issue, context);
}

function verifierCandidate(issue: PendingIssue, context: Context): HeartbeatActionCandidate {
  return candidate("agent.workflow_request", issue, context, {
    instructions: "Inspect completion evidence, run the minimal verification plan, and recommend accept/request_changes.",
    reason: "pending_verification_timeout",
    role: "verifier",
    target_issue_id: issue.id,
    verification_plan: "Review recorded verification evidence and rerun focused checks if evidence is missing."
  });
}

function escalationCandidate(issue: PendingIssue, context: Context): HeartbeatActionCandidate {
  return candidate("needs_user.escalate", issue, context, {
    body: `Heartbeat planner: issue #${issue.id} has been pending verification for ${duration(ageMs(issue.updated_at, context.now))}.`,
    issue_id: issue.id,
    reason: "pending_verification_timeout",
    requested_action: "review or request verifier follow-up"
  });
}

function pendingVerificationIssues(signals: HeartbeatSignals): PendingIssue[] {
  const map = new Map<number, PendingIssue>();
  for (const issue of latestIssues(signals).filter((item) => item.status === "pending_verification")) map.set(issue.id, issue);
  for (const finding of signals.project?.findings ?? []) {
    if (finding.status === "pending_verification" && finding.issue_id > 0 && !map.has(finding.issue_id)) map.set(finding.issue_id, { id: finding.issue_id, updated_at: finding.updated_at });
  }
  return [...map.values()];
}

function candidate(actionType: string, issue: PendingIssue, context: Context, payload: Record<string, unknown>): HeartbeatActionCandidate {
  return normalizePiActionEnvelope({ action_type: actionType, issue_id: issue.id, payload, project_id: context.projectID, rationale: timeoutRationale(issue, context.now), risk_level: "medium", source: SOURCE });
}

function latestIssues(signals: HeartbeatSignals): IssueSummary[] { return signals.project?.latest_issues ?? []; }
function timedOut(issue: PendingIssue, context: Context): boolean { return ageMs(issue.updated_at, context.now) >= context.timeoutMs; }
function ageMs(updatedAt: string, now: Date): number { const updated = Date.parse(updatedAt); return Number.isFinite(updated) ? now.getTime() - updated : 0; }
function duration(ms: number): string { const minutes = Math.max(0, Math.round(ms / 60_000)); return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`; }
function timeoutRationale(issue: PendingIssue, now: Date): string { return `Escalate issue #${issue.id} because it has been pending verification for ${duration(ageMs(issue.updated_at, now))}.`; }
