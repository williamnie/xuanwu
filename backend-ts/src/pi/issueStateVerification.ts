import type { RunnerDatabase } from "../db/database.ts";
import type { Issue, IssueRun } from "../db/repositories/issues.ts";
import type { IssueEvent } from "../db/repositories/issueEvents.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { IssueStateDiagnostic, IssueStateEvidence } from "./issueStateManager.ts";
import { currentIssueStateSnapshot, type IssueStateSnapshot } from "./issueStateSnapshot.ts";
import { projectVerificationPolicy } from "./verificationPolicy.ts";

const VERIFY_PATTERN = /verification|verified|verify|验收|验证|测试|tests?\s+(?:passed|failed|ok)|(?:vitest|jest|node --test|npm (?:run )?test|pnpm (?:exec )?vitest|build|lint)\s+(?:passed|failed|ok|success|succeeded)/i;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function pendingVerificationDiagnostics(
  db: RunnerDatabase,
  issue: Issue,
  events: IssueEvent[],
  timeoutOverrideMs: number | undefined,
  now: Date
): IssueStateDiagnostic[] {
  const snapshot = currentIssueStateSnapshot(db, issue.id);
  if (hasVerificationEvidence(issue, undefined, events)) return [pendingHasEvidence(issue, events, snapshot)];
  const age = now.getTime() - parseTime(issue.updated_at);
  const timeout = timeoutOverrideMs ?? projectVerificationPolicy(db, issue.project_id).pending_timeout_ms;
  if (age < timeout) return [];
  const evidence = [issueEvidence(issue, `pending verification for ${duration(age)}`)];
  return [diagnostic(issue, "pending_verification_timeout", "needs_user", evidence, [
    action(issue, "comment", evidence, "Escalate timed-out verification for user review.", snapshot, {
      body: `State manager: issue #${issue.id} has been pending verification for ${duration(age)}.`
    })
  ])];
}

export function hasVerificationEvidence(issue: Issue, run: IssueRun | undefined, events: IssueEvent[]): boolean {
  if (VERIFY_PATTERN.test(issue.error) || VERIFY_PATTERN.test(run?.error ?? "")) return true;
  return events.some(isVerificationEvent);
}

function pendingHasEvidence(issue: Issue, events: IssueEvent[], snapshot: IssueStateSnapshot): IssueStateDiagnostic {
  const evidence = compact([issueEvidence(issue, "pending verification has verification evidence"), latestVerificationEventEvidence(events)]);
  return diagnostic(issue, "pending_verification_has_evidence", "repair", evidence, [
    action(issue, "patch_status", evidence, "Close pending verification issue because verification evidence is already recorded.", snapshot, { status: "done" })
  ]);
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

function latestVerificationEventEvidence(events: IssueEvent[]): IssueStateEvidence | undefined {
  const event = events.filter(isVerificationEvent).at(-1);
  return event ? { ref: `event:${event.id}`, source: "event", summary: safeText(`${event.type}: ${event.payload.slice(0, 160)}`), timestamp: event.created_at } : undefined;
}

function isVerificationEvent(event: IssueEvent): boolean {
  return event.type === "issue.verification_reviewed" || event.type === "issue.verification_report" || VERIFY_PATTERN.test(event.payload);
}

function parseTime(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY; }
function duration(ms: number): string { const minutes = Math.max(0, Math.round(ms / 60_000)); return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`; }
function compact<T>(items: Array<T | undefined>): T[] { return items.filter((item): item is T => item !== undefined); }
function safeText(value: string): string { return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]"); }
