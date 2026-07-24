import type { RunnerDatabase } from "../db/database.ts";
import {
  listIssueSupervisorEvents,
  type IssueSupervisorEvent,
  type PiActionEvent
} from "../db/repositories/pi.ts";

export type SupervisorReportScope = {
  delegationID: string;
  heartbeatID: string;
};

export type SupervisorReportWindow = {
  since: string;
  until: string;
};

export type SupervisorReportSummary = {
  exhausted_recoveries: number;
  exhausted_recovery_issues: Array<Record<string, unknown>>;
  needs_user_escalation_issues: Array<Record<string, unknown>>;
  needs_user_escalations: number;
  rate_limit_wait_issues: Array<Record<string, unknown>>;
  rate_limit_waits: number;
  recovered_issue_ids: number[];
  recovered_issues: number;
  recovery_actions: number;
};

export function listReportSupervisorEvents(
  db: RunnerDatabase,
  input: {
    auditEvents: PiActionEvent[];
    projectID: string;
    scope: SupervisorReportScope;
    window: SupervisorReportWindow;
  }
): IssueSupervisorEvent[] {
  const auditIssueIDs = new Set(input.auditEvents.map((event) => event.issue_id).filter((id) => id > 0));
  return listIssueSupervisorEvents(db, {
    createdAfter: input.window.since,
    createdBefore: input.window.until,
    projectId: input.projectID
  })
    .filter((event) => inWindow(event.created_at, input.window) && scopeMatches(event, input.scope, auditIssueIDs))
    .slice(-50);
}

export function supervisorReportSummary(events: IssueSupervisorEvent[]): SupervisorReportSummary {
  const recoveryActions = events.filter(supervisorRecoveryAction);
  const rateLimitWaits = events.filter(supervisorRateLimitWait);
  const needsUser = events.filter(supervisorNeedsUser);
  const exhausted = events.filter((event) => event.diagnosis_code === "session_recovery_exhausted");
  return {
    exhausted_recoveries: exhausted.length,
    exhausted_recovery_issues: issueRefs(exhausted),
    needs_user_escalation_issues: issueRefs(needsUser),
    needs_user_escalations: needsUser.length,
    rate_limit_wait_issues: issueRefs(rateLimitWaits),
    rate_limit_waits: rateLimitWaits.length,
    recovered_issue_ids: uniqueIssueIDs(recoveryActions),
    recovered_issues: uniqueIssueIDs(recoveryActions).length,
    recovery_actions: recoveryActions.length
  };
}

function scopeMatches(event: IssueSupervisorEvent, scope: SupervisorReportScope, auditIssueIDs: Set<number>): boolean {
  if (scope.heartbeatID === "" && scope.delegationID === "") return true;
  if (scope.heartbeatID !== "") return eventMatchesHeartbeat(event, scope.heartbeatID);
  return scope.delegationID !== "" && auditIssueIDs.has(event.issue_id);
}

function eventMatchesHeartbeat(event: IssueSupervisorEvent, heartbeatID: string): boolean {
  const payload = parseObject(event.payload_json);
  return clean(payload.heartbeat_id) === heartbeatID || clean(payload.heartbeatID) === heartbeatID;
}

function supervisorRecoveryAction(event: IssueSupervisorEvent): boolean {
  return event.event_type === "action" && ["session.resume_followup", "session.steer", "issue.retry"].includes(event.action_type);
}

function supervisorRateLimitWait(event: IssueSupervisorEvent): boolean {
  return event.action_type === "issue.retry_after" || event.retry_after_at !== "" || event.provider_error_category === "rate_limit";
}

function supervisorNeedsUser(event: IssueSupervisorEvent): boolean {
  return event.action_type === "needs_user.escalate" || event.decision === "needs_user" || event.decision === "blocked";
}

function issueRefs(events: IssueSupervisorEvent[]): Array<Record<string, unknown>> {
  const latest = new Map<number, IssueSupervisorEvent>();
  for (const event of events) if (event.issue_id > 0) latest.set(event.issue_id, event);
  return [...latest.values()].map((event) => ({
    action_type: event.action_type,
    decision: event.decision,
    diagnosis_code: event.diagnosis_code,
    issue_id: event.issue_id,
    retry_after_at: event.retry_after_at
  }));
}

function uniqueIssueIDs(events: IssueSupervisorEvent[]): number[] {
  return [...new Set(events.map((event) => event.issue_id).filter((id) => id > 0))];
}

function inWindow(value: string, window: SupervisorReportWindow): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(window.since) && time <= Date.parse(window.until);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
