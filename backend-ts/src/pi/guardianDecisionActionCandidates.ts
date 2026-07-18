import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import type { PiGuardianEvent } from "../db/repositories/pi.ts";
import { supervisorRecoveryActionCandidates } from "./recoveryActionPlanner.ts";

export function guardianDecisionActionsJson(
  event: PiGuardianEvent,
  payload: Record<string, unknown>,
  db?: RunnerDatabase
): string {
  const explicit = recordArray(payload.actions ?? payload.action_candidates);
  if (explicit.length > 0) return JSON.stringify(explicit);
  if (event.event_type === "guardian.supervisor.candidate") {
    const actions = supervisorRecoveryActionCandidates({
      eventID: event.id,
      issueID: event.issue_id,
      payload,
      projectID: event.project_id
    });
    return JSON.stringify(db ? refreshStableRecoverySnapshots(db, actions) : actions);
  }
  return heartbeatActionJson(event, payload);
}

function refreshStableRecoverySnapshots(
  db: RunnerDatabase,
  actions: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return actions.map((action) => {
    const payload = jsonRecord(action.payload);
    const issueID = positiveNumber(payload.issue_id);
    const issue = issueID > 0 ? getIssue(db, issueID) : null;
    const run = issue ? listIssueRuns(db, issue.id).at(-1) : undefined;
    if (!issue || clean(payload.expected_issue_status) !== issue.status ||
      clean(payload.expected_run_id) !== clean(run?.id) ||
      clean(payload.expected_run_status) !== clean(run?.status)) return action;
    const refreshed: Record<string, unknown> = {
      ...payload,
      expected_issue_updated_at: issue.updated_at,
      expected_provider_session_id: clean(run?.provider_session_id),
      expected_provider_turn_id: clean(run?.provider_turn_id),
      expected_run_ended_at: clean(run?.ended_at)
    };
    refreshStableSessionSnapshot(db, refreshed, clean(run?.provider));
    return { ...action, payload: refreshed };
  });
}

function refreshStableSessionSnapshot(
  db: RunnerDatabase,
  payload: Record<string, unknown>,
  fallbackProvider: string
): void {
  const sessionID = clean(payload.expected_provider_session_id);
  const provider = clean(payload.provider) || fallbackProvider || "codex";
  if (sessionID === "") return;
  const session = getAgentSession(db, `${provider}:${sessionID}`);
  if (!session || clean(payload.expected_session_status) !== clean(session.status)) return;
  payload.expected_session_updated_at = session.updated_at;
  payload.expected_session_turn_id = sessionTurnID(session.raw_ref);
}

function sessionTurnID(rawRef: string): string {
  try { return clean(jsonRecord(JSON.parse(rawRef || "{}")).provider_turn_id); } catch { return ""; }
}

function heartbeatActionJson(event: PiGuardianEvent, payload: Record<string, unknown>): string {
  const actionType = clean(payload.action_type);
  const original = jsonRecord(payload.original_payload);
  if (event.event_type !== "guardian.heartbeat.action_candidate" || actionType === "" ||
    Object.keys(original).length === 0) {
    return "[]";
  }
  return JSON.stringify([{
    action_type: actionType,
    issue_id: event.issue_id,
    payload: original,
    project_id: event.project_id,
    rationale: clean(payload.rationale),
    risk_level: clean(payload.risk_level)
  }]);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(jsonRecord).filter((item) => Object.keys(item).length > 0);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
