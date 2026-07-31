import type { RunnerDatabase } from "../db/database.ts";
import type { Issue, IssueRun } from "../db/repositories/issues.ts";
import type { IssueEvent } from "../db/repositories/issueEvents.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { IssueStateDiagnostic, IssueStateEvidence } from "./issueStateManager.ts";
import { currentIssueStateSnapshot, type IssueStateSnapshot } from "./issueStateSnapshot.ts";
import { projectVerificationPolicy } from "./verificationPolicy.ts";

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function pendingVerificationDiagnostics(
  db: RunnerDatabase,
  issue: Issue,
  events: IssueEvent[],
  timeoutOverrideMs: number | undefined,
  now: Date
): IssueStateDiagnostic[] {
  const age = now.getTime() - parseTime(issue.updated_at);
  const timeout = timeoutOverrideMs ?? projectVerificationPolicy(db, issue.project_id).pending_timeout_ms;
  if (age < timeout) return [];
  const snapshot = currentIssueStateSnapshot(db, issue.id);
  const evidence = [issueEvidence(issue, `pending verification for ${duration(age)}`)];
  return [diagnostic(issue, "pending_verification_timeout", "needs_user", evidence, [
    action(issue, "comment", evidence, "Escalate timed-out verification for user review.", snapshot, {
      body: `State manager: issue #${issue.id} has been pending verification for ${duration(age)}.`
    })
  ])];
}

export function hasVerificationEvidence(_issue: Issue, _run: IssueRun | undefined, events: IssueEvent[]): boolean {
  return events.some(isAcceptedCompletionEvent);
}

function diagnostic(issue: Issue, code: string, severity: IssueStateDiagnostic["severity"], evidence: IssueStateEvidence[], recommended_actions: IssueStateDiagnostic["recommended_actions"]): IssueStateDiagnostic {
  return { code, evidence, issue_id: issue.id, project_id: issue.project_id, recommended_actions, severity, status: issue.status, title: safeText(issue.title) };
}

function action(
  issue: Issue,
  operation: "comment" | "patch_status",
  evidence: IssueStateEvidence[],
  rationale: string,
  expected_state: IssueStateSnapshot,
  patch?: Record<string, string>
) {
  return { action_type: "issue.state_repair" as const, evidence_refs: evidence.map((item) => item.ref), expected_state, issue_id: issue.id, operation, ...(patch ? { patch } : {}), rationale };
}

function issueEvidence(issue: Issue, summary: string): IssueStateEvidence {
  return { ref: `issue:${issue.id}`, source: "issue", summary: safeText(summary), timestamp: issue.updated_at };
}

function isAcceptedCompletionEvent(event: IssueEvent): boolean {
  const payload = parsePayload(event.payload);
  if (event.type === "issue.pi_acceptance_applied.v1") {
    return clean(payload.action) === "accept" && clean(payload.status) === "done";
  }
  if (event.type === "issue.verification_gate_outcome.v1") {
    const evaluation = objectValue(payload.evaluation);
    return clean(payload.target_status) === "done"
      && clean(evaluation.decision) === "passed"
      && evaluation.satisfied === true;
  }
  if (event.type === "issue.verification_reviewed") {
    return ["accept", "accepted", "passed"].includes(clean(payload.decision));
  }
  return false;
}

function parsePayload(value: string): Record<string, unknown> {
  try { return objectValue(JSON.parse(value) as unknown); } catch { return {}; }
}
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function clean(value: unknown): string { return typeof value === "string" ? value.trim().toLowerCase() : ""; }

function parseTime(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY; }
function duration(ms: number): string { const minutes = Math.max(0, Math.round(ms / 60_000)); return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`; }
function compact<T>(items: Array<T | undefined>): T[] { return items.filter((item): item is T => item !== undefined); }
function safeText(value: string): string { return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]"); }
