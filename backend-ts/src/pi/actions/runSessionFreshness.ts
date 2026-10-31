import type { RunnerDatabase } from "../../db/database.ts";
import { getAgentSession, type AgentSession } from "../../db/repositories/agentSessions.ts";
import { type Issue } from "../../db/repositories/issues.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import { readRunRevision } from "../../domain/run/service.ts";
import type { RunID } from "../../domain/run/contracts.ts";
import { cleanString, objectValue, positiveInteger } from "../../util/values.ts";
import { PiActionFreshness, TERMINAL_SESSION_STATES } from "./actionFreshness.ts";
import { parseObject, nonNegativeInteger, sessionIDFromKey, normalizeState, rawRefTurnID } from "./actionFreshnessValues.ts";

export function evaluateRunFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  const payload = parseObject(action.payload_json);
  const runID = cleanString(payload.run_id);
  if (runID === "") return { fresh: false, reason: "target_run_missing" };
  const run = db.sqlite.query<{
    attempt_revision: number | null;
    attempt_status: string | null;
    ended_at: string;
    issue_id: number;
    project_id: string;
    status: string;
  }, [string]>(`
    select run.issue_id, issue.project_id, run.status, run.ended_at,
      attempt.revision as attempt_revision, attempt.status as attempt_status
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    left join run_attempts attempt on attempt.attempt_id=(
      select current.attempt_id from run_attempts current
      where current.run_id=run.run_id order by current.sequence desc limit 1
    )
    where run.run_id=?
  `).get(runID);
  if (!run) return { fresh: false, reason: `target_run_missing:${runID}` };
  if (action.issue_id > 0 && run.issue_id !== action.issue_id) {
    return { fresh: false, reason: `target_run_issue_changed:${run.issue_id}` };
  }
  if (action.project_id !== "" && run.project_id !== action.project_id) {
    return { fresh: false, reason: `target_project_changed:${run.project_id}` };
  }
  if (action.action_type === "run.interrupt" && run.ended_at !== "") {
    return { fresh: false, reason: `target_run_already_terminal:${run.status}` };
  }
  const expected = parseObject(action.expected_state_json);
  const expectedRevision = nonNegativeInteger(expected.revision ?? payload.expected_revision);
  if (expectedRevision !== undefined) {
    const currentRevision = readRunRevision(db, run.issue_id, runID as RunID);
    if (currentRevision !== expectedRevision) {
      return { fresh: false, reason: `target_run_revision_changed:${expectedRevision}->${currentRevision}` };
    }
  }
  const expectedAttempt = nonNegativeInteger(expected.attempt_revision ?? payload.expected_attempt_revision);
  if (expectedAttempt !== undefined && run.attempt_revision !== expectedAttempt) {
    return { fresh: false, reason: `target_attempt_revision_changed:${expectedAttempt}->${run.attempt_revision ?? -1}` };
  }
  return { fresh: true };
}

export function evaluateSessionSteerFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  const payload = parseObject(action.payload_json);
  const provider = cleanString(payload.provider) || cleanString(payload.session_key).split(":")[0] || "codex";
  const sessionID = cleanString(payload.provider_session_id) || sessionIDFromKey(cleanString(payload.session_key));
  if (sessionID === "") return { fresh: false, reason: "target_session_missing" };
  const session = getAgentSession(db, `${provider}:${sessionID}`);
  if (!session) return { fresh: false, reason: `target_session_missing:${provider}:${sessionID}` };
  if (action.project_id !== "" && session.project_id !== "" && session.project_id !== action.project_id) {
    return { fresh: false, reason: `target_project_changed:${session.project_id}` };
  }
  if (TERMINAL_SESSION_STATES.has(normalizeState(session.status))) {
    return { fresh: false, reason: `target_session_terminal:${session.status}` };
  }
  const expected = parseObject(action.expected_state_json);
  const snapshot = objectValue(expected.session);
  if (Object.keys(snapshot).length === 0) return legacySessionFreshness(session, payload, expected);
  for (const [key, current] of Object.entries({
    project_id: session.project_id,
    provider: session.provider,
    provider_session_id: session.provider_session_id,
    provider_turn_id: rawRefTurnID(session.raw_ref),
    session_key: session.session_key,
    status: session.status,
    updated_at: session.updated_at
  })) {
    const wanted = cleanString(snapshot[key]);
    if (wanted !== "" && wanted !== current) {
      return { fresh: false, reason: `target_session_${key}_changed:${wanted}->${current}` };
    }
  }
  return { fresh: true };
}

export function legacySessionFreshness(
  session: AgentSession,
  payload: Record<string, unknown>,
  expected: Record<string, unknown>
): PiActionFreshness {
  const expectedTurn = cleanString(expected.provider_turn_id ?? payload.provider_turn_id);
  const currentTurn = rawRefTurnID(session.raw_ref);
  if (expectedTurn !== "" && expectedTurn !== currentTurn) {
    return { fresh: false, reason: `target_session_turn_changed:${expectedTurn}->${currentTurn}` };
  }
  const expectedUpdated = cleanString(expected.session_updated_at);
  if (expectedUpdated !== "" && expectedUpdated !== session.updated_at) {
    return { fresh: false, reason: `target_session_revision_changed:${expectedUpdated}->${session.updated_at}` };
  }
  return { fresh: true };
}

export function compareExpectedIssueState(issue: Issue, expected: Record<string, unknown>): PiActionFreshness {
  const expectedID = positiveInteger(expected.issue_id);
  if (expectedID > 0 && expectedID !== issue.id) {
    return { fresh: false, reason: `target_issue_changed:${issue.id}` };
  }
  const expectedProject = cleanString(expected.project_id);
  if (expectedProject !== "" && expectedProject !== issue.project_id) {
    return { fresh: false, reason: `target_project_changed:${issue.project_id}` };
  }
  const expectedStatus = cleanString(expected.status);
  if (expectedStatus !== "" && expectedStatus !== issue.status) {
    return { fresh: false, reason: `target_state_changed:${expectedStatus}->${issue.status}` };
  }
  const expectedUpdatedAt = cleanString(expected.updated_at);
  if (expectedUpdatedAt !== "" && expectedUpdatedAt !== issue.updated_at) {
    return { fresh: false, reason: `target_revision_changed:${expectedUpdatedAt}->${issue.updated_at}` };
  }
  return { fresh: true };
}
