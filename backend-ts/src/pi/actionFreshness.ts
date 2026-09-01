import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, type AgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { readIssueDecisionProjection, type HumanReviewRequest } from "../domain/review/humanReview.ts";
import { readRunRevision } from "../domain/run/service.ts";
import type { RunID } from "../domain/run/contracts.ts";
import { getIssueAsWork, workIDToIssueID } from "../domain/work/issueAdapter.ts";

export type PiActionFreshness =
  | { fresh: true }
  | { fresh: false; reason: string; supersededBy?: string };

const LEGACY_ENQUEUE_STATES = new Set(["triage", "todo"]);
const ISSUE_BATCH_ACTIONS = new Set(["issue.cancel", "issue.delete", "issue.status_update"]);
const TERMINAL_SESSION_STATES = new Set(["aborted", "cancelled", "completed", "done", "error", "failed", "stopped"]);

export function issueEnqueueExpectedState(issue: Issue): Record<string, unknown> {
  return issueSnapshot(issue);
}

export function issueBatchExpectedState(issues: Issue[]): Record<string, unknown> {
  return { issues: issues.map(issueSnapshot) };
}

export function humanReviewExpectedState(
  issue: Issue,
  request: HumanReviewRequest | null
): Record<string, unknown> {
  return {
    issue: issueSnapshot(issue),
    review: request ? {
      id: request.id,
      revision: request.revision,
      status: request.status
    } : null
  };
}

export function sessionExpectedState(session: AgentSession): Record<string, unknown> {
  return {
    session: {
      project_id: session.project_id,
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      provider_turn_id: rawRefTurnID(session.raw_ref),
      session_key: session.session_key,
      status: session.status,
      updated_at: session.updated_at
    }
  };
}

export function evaluatePiActionFreshness(
  db: RunnerDatabase,
  action: PiAction
): PiActionFreshness {
  if (action.action_type === "issue.enqueue") return evaluateIssueEnqueueFreshness(db, action);
  if (ISSUE_BATCH_ACTIONS.has(action.action_type)) return evaluateIssueBatchFreshness(db, action);
  if (action.action_type === "human_review.respond") return evaluateHumanReviewFreshness(db, action);
  if (action.action_type.startsWith("run.")) return evaluateRunFreshness(db, action);
  if (action.action_type.startsWith("work.")) return evaluateWorkFreshness(db, action);
  if (action.action_type === "session.steer") return evaluateSessionSteerFreshness(db, action);
  return { fresh: true };
}

export function hasPiActionFreshnessEvaluator(actionType: string): boolean {
  return actionType === "issue.enqueue" || ISSUE_BATCH_ACTIONS.has(actionType) ||
    actionType === "human_review.respond" || actionType === "session.steer" ||
    actionType.startsWith("run.") || actionType.startsWith("work.");
}

function evaluateWorkFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  if (action.action_type === "work.create") return { fresh: true };
  const payload = parseObject(action.payload_json);
  const workID = cleanString(payload.work_id);
  if (workID === "") return { fresh: false, reason: "target_work_missing" };
  let issueID: number;
  try {
    issueID = workIDToIssueID(workID);
  } catch {
    return { fresh: false, reason: `target_work_invalid:${workID}` };
  }
  const work = getIssueAsWork(db, issueID);
  if (!work) return { fresh: false, reason: `target_work_missing:${workID}` };
  if (action.project_id !== "" && work.owner.project_id !== action.project_id) {
    return { fresh: false, reason: `target_project_changed:${work.owner.project_id}` };
  }
  const expected = parseObject(action.expected_state_json);
  const expectedRevision = nonNegativeInteger(expected.revision ?? payload.expected_revision);
  if (expectedRevision !== undefined && work.revision !== expectedRevision) {
    return { fresh: false, reason: `target_work_revision_changed:${expectedRevision}->${work.revision}` };
  }
  return { fresh: true };
}

function evaluateIssueEnqueueFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  const superseding = newerCompletedEnqueue(db, action);
  if (superseding !== "") {
    return { fresh: false, reason: `superseded_by:${superseding}`, supersededBy: superseding };
  }

  const issue = getIssue(db, action.issue_id || issueIDFromPayload(action.payload_json));
  if (!issue) return { fresh: false, reason: "target_issue_missing" };
  if (action.project_id !== "" && issue.project_id !== action.project_id) {
    return { fresh: false, reason: `target_project_changed:${issue.project_id}` };
  }

  const expected = parseObject(action.expected_state_json);
  if (Object.keys(expected).length > 0) return compareExpectedIssueState(issue, expected);

  // Compatibility for Actions created before expected-state snapshots existed.
  // Only an unchanged triage/todo target remains approvable.
  if (!LEGACY_ENQUEUE_STATES.has(issue.status)) {
    return { fresh: false, reason: `target_state_changed:${issue.status}` };
  }
  if (timestampAfter(issue.updated_at, action.created_at)) {
    return { fresh: false, reason: `target_updated_after_request:${issue.updated_at}` };
  }
  return { fresh: true };
}

function evaluateIssueBatchFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  const payload = parseObject(action.payload_json);
  const ids = uniquePositiveIDs([
    action.issue_id,
    ...numberList(payload.issue_id),
    ...numberList(payload.issue_ids)
  ]);
  if (ids.length === 0) return { fresh: false, reason: "target_issue_missing" };
  const expected = parseObject(action.expected_state_json);
  const expectedIssues = arrayObjects(expected.issues);
  for (const id of ids) {
    const issue = getIssue(db, id);
    if (!issue) return { fresh: false, reason: `target_issue_missing:${id}` };
    if (action.project_id !== "" && issue.project_id !== action.project_id) {
      return { fresh: false, reason: `target_project_changed:${id}:${issue.project_id}` };
    }
    const snapshot = expectedIssues.find((item) => positiveID(item.issue_id) === id);
    if (snapshot) {
      const result = compareExpectedIssueState(issue, snapshot);
      if (!result.fresh) return { fresh: false, reason: `target_issue_${id}:${result.reason}` };
    } else if (timestampAfter(issue.updated_at, action.created_at)) {
      return { fresh: false, reason: `target_updated_after_request:${id}:${issue.updated_at}` };
    }
  }
  const requestedStatus = cleanString(payload.status);
  if (requestedStatus !== "") {
    const alreadyApplied = ids.every((id) => getIssue(db, id)?.status === requestedStatus);
    if (alreadyApplied) return { fresh: false, reason: `target_state_already_applied:${requestedStatus}` };
  }
  return { fresh: true };
}

function evaluateHumanReviewFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  const payload = parseObject(action.payload_json);
  const issueID = action.issue_id || positiveID(payload.issue_id);
  const issue = getIssue(db, issueID);
  if (!issue) return { fresh: false, reason: "target_issue_missing" };
  if (action.project_id !== "" && issue.project_id !== action.project_id) {
    return { fresh: false, reason: `target_project_changed:${issue.project_id}` };
  }
  const request = readIssueDecisionProjection(db, issue.id).request;
  const expectedID = cleanString(payload.review_request_id);
  const expectedRevision = positiveID(payload.review_revision);
  if (!request || request.status !== "open") return { fresh: false, reason: "human_review_not_open" };
  if (request.id !== expectedID || request.revision !== expectedRevision) {
    return { fresh: false, reason: `human_review_changed:${request.id}:${request.revision}` };
  }
  const expected = parseObject(action.expected_state_json);
  const issueState = objectValue(expected.issue);
  if (Object.keys(issueState).length > 0) {
    const result = compareExpectedIssueState(issue, issueState);
    if (!result.fresh) return result;
  }
  const reviewState = objectValue(expected.review);
  if (Object.keys(reviewState).length > 0 && (
    cleanString(reviewState.id) !== request.id ||
    positiveID(reviewState.revision) !== request.revision ||
    cleanString(reviewState.status) !== request.status
  )) {
    return { fresh: false, reason: `human_review_snapshot_changed:${request.id}:${request.revision}:${request.status}` };
  }
  return { fresh: true };
}

function evaluateRunFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
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

function evaluateSessionSteerFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
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

function legacySessionFreshness(
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

function compareExpectedIssueState(issue: Issue, expected: Record<string, unknown>): PiActionFreshness {
  const expectedID = positiveID(expected.issue_id);
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

function issueSnapshot(issue: Issue): Record<string, unknown> {
  return {
    issue_id: issue.id,
    project_id: issue.project_id,
    status: issue.status,
    updated_at: issue.updated_at
  };
}

function newerCompletedEnqueue(db: RunnerDatabase, action: PiAction): string {
  if (action.issue_id <= 0) return "";
  return db.sqlite.query<{ id: string }, [number, string, string]>(`
    select id from pi_actions
    where action_type='issue.enqueue' and issue_id=? and status='completed'
      and created_at>=? and id<>?
    order by created_at desc, id desc limit 1
  `).get(action.issue_id, action.created_at, action.id)?.id ?? "";
}

function issueIDFromPayload(value: string): number {
  return positiveID(parseObject(value).issue_id);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue).filter((item) => Object.keys(item).length > 0) : [];
}

function numberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numberList);
  return [positiveID(value)].filter((id) => id > 0);
}

function uniquePositiveIDs(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function rawRefTurnID(value: string): string {
  return cleanString(parseObject(value).provider_turn_id);
}

function sessionIDFromKey(value: string): string {
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1).trim();
}

function normalizeState(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}

function timestampAfter(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs;
}

function positiveID(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
