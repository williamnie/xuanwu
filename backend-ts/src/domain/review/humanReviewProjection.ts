import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent, listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { requestIssuePiAcceptance } from "../../runner/piAcceptanceRequest.ts";
import {
  readPiAcceptanceActivity,
  recordPiAcceptanceActivity,
  type PiAcceptanceActivity
} from "./piAcceptanceActivity.ts";
import { cleanString } from "../../util/values.ts";
import {
  type IssueDecisionProjection,
  mustGetIssue,
  type HumanReviewRequest,
  HUMAN_REVIEW_EVENT_TYPES,
  objectPayload,
  requestFromPayload,
  type HumanReviewRuntime
} from "./humanReviewModel.ts";

export function readIssueDecisionProjection(
  db: RunnerDatabase,
  issueID: number
): IssueDecisionProjection {
  const issue = mustGetIssue(db, issueID);
  const requests = humanReviewRequests(db, issueID);
  const request = requests.at(-1) ?? null;
  const storedActivity = readPiAcceptanceActivity(db, issueID);
  const activity = activityAppliesToCurrentIssueState(storedActivity, issue.updated_at)
    ? storedActivity
    : null;
  if (issue.status === "done" || issue.status === "failed" || issue.status === "cancelled") {
    return { activity, owner: "pi", phase: "complete", request };
  }
  if (request?.status === "open") return { activity, owner: "human", phase: "human_review", request };
  return {
    activity,
    owner: "pi",
    phase: issue.status === "in_progress" && request?.status === "changes_requested"
      ? "pi_continuing"
      : piAcceptancePhase(activity),
    request
  };
}

function humanReviewRequests(db: RunnerDatabase, issueID: number): HumanReviewRequest[] {
  const events = listIssueEvents(db, issueID, {
    limit: 500,
    types: Object.values(HUMAN_REVIEW_EVENT_TYPES)
  });
  const requests = new Map<string, HumanReviewRequest>();
  for (const event of events) {
    const payload = objectPayload(event.payload);
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.requested) {
      const request = requestFromPayload(payload, event.created_at);
      if (request) requests.set(request.id, request);
      continue;
    }
    const id = cleanString(payload.request_id);
    const current = requests.get(id);
    if (!current) continue;
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.superseded) {
      const action = cleanString(payload.action);
      current.status = action === "accept"
        ? "accepted"
        : action === "reject"
          ? "rejected"
          : "superseded";
    }
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.redundantClosed) current.status = "superseded";
    if (
      event.type === HUMAN_REVIEW_EVENT_TYPES.revisionRequested
      || event.type === HUMAN_REVIEW_EVENT_TYPES.revisionResumed
    ) current.status = "changes_requested";
    if (event.type === HUMAN_REVIEW_EVENT_TYPES.revisionResumeFailed) current.status = "changes_requested";
  }
  return [...requests.values()].sort((a, b) => a.revision - b.revision);
}

export function repairRedundantAcceptedHumanReview(
  db: RunnerDatabase,
  issueID: number,
  runtime: Pick<HumanReviewRuntime, "bus"> = {}
): Issue | null {
  const issue = getIssue(db, issueID);
  const latestRun = listIssueRuns(db, issueID).at(-1);
  if (!issue || issue.status !== "needs_user" || !latestRun || latestRun.ended_at === "") return issue;
  const requests = humanReviewRequests(db, issueID);
  const current = requests.at(-1);
  if (!current || current.status !== "open" || current.kind !== "acceptance") return issue;
  const accepted = [...requests].reverse().find((request) => request.revision < current.revision
    && request.status === "accepted"
    && request.kind === "acceptance"
    && request.origin_run_id !== ""
    && request.origin_run_id === current.origin_run_id
    && request.origin_run_id === latestRun.id);
  if (!accepted) return issue;
  const repaired = db.transaction(() => {
    recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.redundantClosed, {
      accepted_request_id: accepted.id,
      reason: "an accepted delivery review cannot be reopened on the same terminal Run",
      request_id: current.id,
      revision: current.revision,
      run_id: latestRun.id
    });
    const updated = updateIssue(db, issueID, { error: "", status: "in_progress" });
    requestIssuePiAcceptance(db, issueID, {
      reason: `closed redundant human review revision ${current.revision} after accepted revision ${accepted.revision}`,
      source: "human_review_redundant_recovery"
    });
    recordPiAcceptanceActivity(db, issueID, "queued", {
      attempt: 1,
      card_fingerprint: `human-review-recovery:${current.id}`,
      project_id: issue.project_id,
      source: "human-review-redundant-recovery"
    });
    return updated;
  }).immediate();
  runtime.bus?.publish({
    issueId: repaired.id,
    projectId: repaired.project_id,
    status: "in_progress",
    type: "issue.status_changed"
  });
  return repaired;
}

export function restoreOpenHumanReviewAfterTerminalRun(
  db: RunnerDatabase,
  issueID: number,
  runtime: Pick<HumanReviewRuntime, "bus"> = {}
): Issue | null {
  const issue = getIssue(db, issueID);
  const run = listIssueRuns(db, issueID).at(-1);
  if (!issue || issue.status !== "in_progress" || !run || run.ended_at === "") return issue;
  const projection = readIssueDecisionProjection(db, issueID);
  const request = projection.request;
  if (projection.owner !== "human" || !request || request.status !== "open") return issue;
  const alreadyRestored = listIssueEvents(db, issueID, {
    limit: 50,
    types: [HUMAN_REVIEW_EVENT_TYPES.restored]
  }).some((event) => {
    const payload = objectPayload(event.payload);
    return cleanString(payload.request_id) === request.id
      && cleanString(payload.terminal_run_id) === run.id;
  });
  const restored = db.transaction(() => {
    const updated = updateIssue(db, issueID, { error: "", status: "needs_user" });
    if (!alreadyRestored) {
      recordIssueEvent(db, issueID, HUMAN_REVIEW_EVENT_TYPES.restored, {
        reason: "terminal Run cannot bypass the still-open human review",
        request_id: request.id,
        revision: request.revision,
        terminal_run_id: run.id,
        terminal_run_status: run.status
      });
    }
    return updated;
  }).immediate();
  runtime.bus?.publish({
    issueId: restored.id,
    projectId: restored.project_id,
    status: "needs_user",
    type: "issue.status_changed"
  });
  return restored;
}

function activityAppliesToCurrentIssueState(
  activity: PiAcceptanceActivity | null,
  issueUpdatedAt: string
): boolean {
  if (!activity) return false;
  const activityAt = Date.parse(activity.updated_at);
  const issueAt = Date.parse(issueUpdatedAt);
  return !Number.isFinite(issueAt) || !Number.isFinite(activityAt) || activityAt >= issueAt;
}

function piAcceptancePhase(
  activity: PiAcceptanceActivity | null
): IssueDecisionProjection["phase"] {
  if (!activity || activity.status === "queued") return "pi_queued";
  if (activity.status === "running") return "pi_deciding";
  if (activity.status === "failed") return "pi_error";
  return "pi_waiting";
}
