import { randomUUID } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { listIssueRuns, type Issue } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { requestIssuePiAcceptance } from "../../runner/piAcceptanceRequest.ts";
import {
  assertWorkspaceReacquisition,
  commitWorkspaceReacquisition,
  prepareWorkspaceReacquisition
} from "./workspaceWait.ts";
import { cleanString, stringList } from "../../util/values.ts";
import {
  type CreateHumanReviewRequestInput,
  type HumanReviewRuntime,
  type HumanReviewRequest,
  mustGetIssue,
  requiredText,
  reviewOrigin,
  HUMAN_REVIEW_EVENT_TYPES,
  reviewKind,
  humanReviewNotificationText,
  type ReopenIncorrectAcceptanceInput,
  positiveInteger,
  HumanReviewConflictError,
  normalizeAction
} from "./humanReviewModel.ts";
import { readIssueDecisionProjection } from "./humanReviewProjection.ts";
import { requireCurrentReviewRequest, resumeRevisionInSameSession } from "./humanReviewResume.ts";

export function createHumanReviewRequest(
  db: RunnerDatabase,
  issueID: number,
  input: CreateHumanReviewRequestInput,
  runtime: HumanReviewRuntime = {}
): HumanReviewRequest {
  const issue = mustGetIssue(db, issueID);
  if (issue.status !== "needs_user") {
    throw new Error("只有 needs_user Issue 才能请求人类处理");
  }
  const question = requiredText(input.question, "question");
  const evidenceRefs = stringList(input.evidence_refs);
  const origin = reviewOrigin(db, issueID, evidenceRefs);
  const current = readIssueDecisionProjection(db, issueID).request;
  const revision = (current?.revision ?? 0) + 1;
  if (current?.status === "open") {
    recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.superseded, {
      request_id: current.id,
      revision: current.revision,
      reason: "replaced_by_new_human_review_request"
    });
  }
  const request: HumanReviewRequest = {
    acceptance_summary: stringList(input.acceptance_summary),
    consequences: cleanString(input.consequences),
    created_at: new Date().toISOString(),
    evidence_refs: evidenceRefs,
    excluded_scope: stringList(input.excluded_scope),
    id: `human-review-${issueID}-${randomUUID()}`,
    issue_id: issueID,
    kind: reviewKind(input.kind),
    origin_card_fingerprint: origin.cardFingerprint,
    origin_run_id: origin.runID,
    question,
    recommendation: cleanString(input.recommendation),
    revision,
    status: "open"
  };
  recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.requested, request);
  const notificationText = humanReviewNotificationText(issue, request);
  runtime.bus?.publish({
    issueId: issueID,
    projectId: issue.project_id,
    type: "pi.needs_user",
    text: notificationText,
    payload: JSON.stringify({
      acceptance_summary: request.acceptance_summary,
      action_id: request.id,
      consequences: request.consequences,
      evidence_refs: request.evidence_refs,
      excluded_scope: request.excluded_scope,
      issue_id: issueID,
      message: question,
      next_step: "请打开 Work 验收，接受、要求调整或拒绝",
      recommendation: request.recommendation,
      origin_card_fingerprint: request.origin_card_fingerprint,
      origin_run_id: request.origin_run_id,
      reason: "human_review_required",
      requires_user: true,
      review_request_id: request.id,
      review_revision: request.revision,
      severity: "action",
      user_facing_message: notificationText
    })
  });
  return request;
}

/**
 * Operator-only repair for a historical review that was incorrectly classified as delivery
 * acceptance. The old accepted request stays immutable; a corrected revision is appended.
 */
export function reopenIncorrectlyAcceptedHumanReview(
  db: RunnerDatabase,
  issueID: number,
  input: ReopenIncorrectAcceptanceInput,
  runtime: HumanReviewRuntime = {}
): HumanReviewRequest {
  const issue = mustGetIssue(db, issueID);
  if (issue.status !== "done") throw new Error("只有错误完成的 done Issue 才能恢复错误验收");
  if (listIssueRuns(db, issueID).some((run) => run.ended_at === "")) {
    throw new Error("存在运行中的 Run，不能恢复错误验收");
  }
  const accepted = readIssueDecisionProjection(db, issueID).request;
  const requestID = requiredText(input.reopen_accepted_request_id, "reopen_accepted_request_id");
  const revision = positiveInteger(input.reopen_accepted_revision, "reopen_accepted_revision");
  if (!accepted || accepted.status !== "accepted" || accepted.kind !== "acceptance"
    || accepted.id !== requestID || accepted.revision !== revision) {
    throw new HumanReviewConflictError("待恢复的 delivery acceptance 已变化，请刷新后重试");
  }
  const correctedKind = reviewKind(input.kind);
  if (correctedKind === "acceptance") {
    throw new Error("恢复后的审核类型只能是 decision 或 risk_acceptance");
  }
  const reason = requiredText(input.recovery_reason, "recovery_reason");
  return db.transaction(() => {
    recordIssueEvent(db, issueID, "issue.human_review_incorrect_acceptance_reopened.v1", {
      accepted_request_id: accepted.id,
      accepted_revision: accepted.revision,
      corrected_kind: correctedKind,
      reason
    });
    updateIssue(db, issueID, { error: "", status: "needs_user" });
    return createHumanReviewRequest(db, issueID, { ...input, kind: correctedKind }, runtime);
  }).immediate();
}

export async function reviewHumanIssue(
  db: RunnerDatabase,
  issueID: number,
  input: Record<string, unknown>,
  runtime: HumanReviewRuntime = {}
): Promise<Issue> {
  const action = normalizeAction(input.action);
  const comment = cleanString(input.comment);
  const request = requireCurrentReviewRequest(db, issueID, input);
  const resolvedOrigin = reviewOrigin(db, issueID, request.evidence_refs);
  request.origin_card_fingerprint ||= resolvedOrigin.cardFingerprint;
  request.origin_run_id ||= resolvedOrigin.runID;
  if ((action === "request_changes" || action === "reject") && comment === "") {
    throw new Error(`${action} 必须填写具体意见`);
  }
  const workspace = await prepareWorkspaceReacquisition(db, issueID, request);
  if (action === "request_changes") {
    return resumeRevisionInSameSession(db, mustGetIssue(db, issueID), request, comment, runtime, workspace);
  }
  return db.transaction(() => {
    requireCurrentReviewRequest(db, issueID, input);
    assertWorkspaceReacquisition(db, issueID, request, workspace);
    if (comment) {
      recordIssueEvent(db, issueID, "issue.comment", {
        author: "user",
        body: comment,
        source: `human_review_${action}`
      });
    }
    recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.superseded, {
      action,
      comment,
      request_id: request.id,
      revision: request.revision
    });
    updateIssue(db, issueID, { error: "", status: "in_progress", auto_retry_next_at: "", auto_retry_reason: "" });
    recordIssueEvent(db, issueID, "issue.human_review_answered.v1", {
      action,
      comment,
      origin_card_fingerprint: request.origin_card_fingerprint,
      origin_run_id: request.origin_run_id,
      request_snapshot: humanReviewRequestSnapshot(request),
      request_id: request.id,
      revision: request.revision
    });
    commitWorkspaceReacquisition(db, issueID, workspace);
    return requestIssuePiAcceptance(db, issueID, {
      reason: `human review answered: ${action}`,
      source: "human_review"
    });
  }).immediate();
}

function humanReviewRequestSnapshot(request: HumanReviewRequest): Omit<HumanReviewRequest, "status"> {
  const { status: _status, ...snapshot } = request;
  return snapshot;
}

export { HUMAN_REVIEW_EVENT_TYPES } from "./humanReviewModel.ts";
export type { HumanReviewRequest } from "./humanReviewModel.ts";
export type { IssueDecisionProjection } from "./humanReviewModel.ts";
export type { CreateHumanReviewRequestInput } from "./humanReviewModel.ts";
export type { HumanReviewRuntime } from "./humanReviewModel.ts";
export { HumanReviewConflictError } from "./humanReviewModel.ts";
export { readIssueDecisionProjection } from "./humanReviewProjection.ts";
export { repairRedundantAcceptedHumanReview } from "./humanReviewProjection.ts";
export { restoreOpenHumanReviewAfterTerminalRun } from "./humanReviewProjection.ts";
