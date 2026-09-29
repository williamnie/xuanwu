import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type IssueRun } from "../../db/repositories/issues.ts";
import { HUMAN_REVIEW_EVENT_TYPES, readIssueDecisionProjection, type IssueDecisionProjection } from "./humanReview.ts";

export type HumanFeedback = {
  action: string;
  error: string;
  feedback: string;
  next_question: string;
  origin_run_id: string;
  origin_card_fingerprint: string;
  question: string;
  received_at: string;
  review_request_id: string;
  review_revision: number;
  run: Pick<IssueRun, "id" | "attempt" | "status" | "provider_session_id" | "provider_turn_id"> | null;
  source_event_id: number;
  status: "received" | "executing" | "completed" | "needs_input" | "failed" | "cancelled";
};

// 只投影既有审计事件和执行事实，不持久化第二套反馈状态。
export function readHumanFeedback(
  db: RunnerDatabase, issueID: number, decision: IssueDecisionProjection = readIssueDecisionProjection(db, issueID)
): HumanFeedback | null {
  const issue = getIssue(db, issueID);
  if (!issue) return null;
  const events = listIssueEvents(db, issueID, { limit: 500, types: [
    HUMAN_REVIEW_EVENT_TYPES.requested, HUMAN_REVIEW_EVENT_TYPES.revisionRequested,
    HUMAN_REVIEW_EVENT_TYPES.revisionResumed, HUMAN_REVIEW_EVENT_TYPES.revisionResumeFailed,
    "issue.human_review_answered.v1"
  ] }).map(event => ({ ...event, data: payload(event.payload) }));
  const response = [...events].reverse().find(event => {
    if (![HUMAN_REVIEW_EVENT_TYPES.revisionRequested, "issue.human_review_answered.v1"].includes(event.type)) return false;
    return events.some(request => request.type === HUMAN_REVIEW_EVENT_TYPES.requested
      && request.data.id === event.data.request_id && request.data.revision === event.data.revision);
  });
  if (!response) return null;
  const original = events.find(event => event.type === HUMAN_REVIEW_EVENT_TYPES.requested
    && event.data.id === response.data.request_id && event.data.revision === response.data.revision)!.data;
  const snapshot = response.data.request_snapshot as Record<string, unknown> | undefined;
  const request = snapshot && snapshot.id === original.id && snapshot.revision === original.revision ? snapshot : original;
  const related = events.filter(event => event.id >= response.id && event.data.request_id === request.id && event.data.revision === request.revision);
  const runs = listIssueRuns(db, issueID);
  const requestedRun = runs.find(run => run.id === response.data.new_run_id);
  const originRunID = text(request.origin_run_id) || text(response.data.resumed_from_run_id);
  const origin = runs.find(run => run.id === originRunID);
  const latest = runs.at(-1);
  // 后续 PI 可在同一反馈之后继续执行；旧 Run 不能冒充本轮续跑。
  const run = latest && (requestedRun ? latest.attempt >= requestedRun.attempt
    : response.type === "issue.human_review_answered.v1" && origin && latest.attempt > origin.attempt)
    ? latest : requestedRun;
  const failure = [...related].reverse().find(event => event.type === HUMAN_REVIEW_EVENT_TYPES.revisionResumeFailed);
  const resumed = related.some(event => event.type === HUMAN_REVIEW_EVENT_TYPES.revisionResumed && event.data.new_run_id === run?.id);
  const nextQuestion = decision.owner === "human" && decision.request?.status === "open" ? decision.request.question : "";
  const status: HumanFeedback["status"] = nextQuestion ? "needs_input"
    : issue.status === "done" ? "completed"
    : issue.status === "failed" ? "failed"
    : issue.status === "cancelled" ? "cancelled"
    : failure && (!run || run.id === failure.data.run_id) ? "failed"
    : run && !run.ended_at && (resumed || run.provider_turn_id) ? "executing"
    : decision.phase === "pi_error" ? "failed" : "received";
  return {
    action: response.type === HUMAN_REVIEW_EVENT_TYPES.revisionRequested ? "request_changes" : text(response.data.action),
    error: status === "failed" ? text(failure?.data.error) || run?.error || decision.activity?.error || issue.error : "",
    feedback: text(response.data.feedback ?? response.data.comment),
    next_question: nextQuestion,
    origin_run_id: originRunID,
    origin_card_fingerprint: text(request.origin_card_fingerprint),
    question: text(request.question),
    received_at: response.created_at,
    review_request_id: text(request.id),
    review_revision: Number(request.revision),
    run: run ? { id: run.id, attempt: run.attempt, status: run.status, provider_session_id: run.provider_session_id, provider_turn_id: run.provider_turn_id } : null,
    source_event_id: response.id,
    status
  };
}

function payload(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
