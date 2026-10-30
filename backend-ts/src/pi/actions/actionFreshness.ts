import type { RunnerDatabase } from "../../db/database.ts";
import { type AgentSession } from "../../db/repositories/agentSessions.ts";
import { getIssue, type Issue } from "../../db/repositories/issues.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import { readIssueDecisionProjection, type HumanReviewRequest } from "../../domain/review/humanReview.ts";
import { getIssueAsWork, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { cleanString, objectValue, positiveInteger } from "../../util/values.ts";
import { evaluateRunFreshness, evaluateSessionSteerFreshness, compareExpectedIssueState } from "./runSessionFreshness.ts";
import { issueSnapshot, rawRefTurnID, parseObject, nonNegativeInteger, newerCompletedEnqueue, issueIDFromPayload, timestampAfter, uniquePositiveIDs, numberList, arrayObjects } from "./actionFreshnessValues.ts";

export type PiActionFreshness =
  | { fresh: true }
  | { fresh: false; reason: string; supersededBy?: string };

export const LEGACY_ENQUEUE_STATES = new Set(["triage", "todo"]);

export const ISSUE_BATCH_ACTIONS = new Set(["issue.cancel", "issue.delete", "issue.status_update"]);

export const TERMINAL_SESSION_STATES = new Set(["aborted", "cancelled", "completed", "done", "error", "failed", "stopped"]);

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

export function evaluateWorkFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
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

export function evaluateIssueEnqueueFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
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

export function evaluateIssueBatchFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
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
    const snapshot = expectedIssues.find((item) => positiveInteger(item.issue_id) === id);
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

export function evaluateHumanReviewFreshness(db: RunnerDatabase, action: PiAction): PiActionFreshness {
  const payload = parseObject(action.payload_json);
  const issueID = action.issue_id || positiveInteger(payload.issue_id);
  const issue = getIssue(db, issueID);
  if (!issue) return { fresh: false, reason: "target_issue_missing" };
  if (action.project_id !== "" && issue.project_id !== action.project_id) {
    return { fresh: false, reason: `target_project_changed:${issue.project_id}` };
  }
  const request = readIssueDecisionProjection(db, issue.id).request;
  const expectedID = cleanString(payload.review_request_id);
  const expectedRevision = positiveInteger(payload.review_revision);
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
    positiveInteger(reviewState.revision) !== request.revision ||
    cleanString(reviewState.status) !== request.status
  )) {
    return { fresh: false, reason: `human_review_snapshot_changed:${request.id}:${request.revision}:${request.status}` };
  }
  return { fresh: true };
}
