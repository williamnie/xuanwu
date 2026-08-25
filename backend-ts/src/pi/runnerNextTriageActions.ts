import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { createPendingPiAction, type PiActionContext } from "./actionEngine.ts";
import { parseBatchTriageScope, type BatchTriageScope } from "./runnerBatchTriageScope.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import { attachRunGroupEnqueueAction, createBatchRunGroup, updateRunGroupEnqueueResult } from "./runGroupService.ts";

export type NextTriageIssueInput = { project_id?: string; rationale?: string };
export type BatchTriageIssueInput = {
  issue_ids?: number[];
  project_id?: string;
  rationale?: string;
  user_phrase?: string;
};

type NextTriageContext = PiActionContext & {
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
};

export function createNextTriageEnqueueAction(
  db: RunnerDatabase,
  context: NextTriageContext,
  input: NextTriageIssueInput
): unknown {
  const projectID = scopedProjectID(input.project_id, context);
  const issue = nextTriageIssue(db, projectID);
  if (!issue) return noNextTriageCandidate(projectID);
  const actionContext = scopedRunnerChatActionContext(context, "issue.enqueue", {
    issueID: issue.id,
    projectID: issue.project_id
  });
  return createPendingPiAction(db, actionContext, {
    actionType: "issue.enqueue",
    issueID: issue.id,
    payload: { issue_id: issue.id },
    projectID: issue.project_id,
    rationale: input.rationale
  }, () => enqueueIssueAndNotify(db, context, issue.id));
}

export function createBatchTriageEnqueueAction(
  db: RunnerDatabase,
  context: NextTriageContext,
  input: BatchTriageIssueInput
): unknown {
  const projectID = scopedProjectID(input.project_id, context);
  const scope = parseBatchTriageScope(input.user_phrase, input.issue_ids);
  const candidates = scopedBatchCandidates(db, projectID, scope);
  if (candidates.length === 0) return noBatchTriageCandidate(projectID);
  const group = createBatchRunGroup(db, {
    conversationID: context.conversationID,
    issues: candidates,
    projectID,
    userPhrase: input.user_phrase
  });
  const result = enqueueBatchCandidates(db, context, candidates, input.rationale, group.id);
  if (result.enqueued.length > 0) context.onIssueEnqueued?.(projectID);
  return batchSummary(projectID, candidates.length, result, group.id);
}

function nextTriageIssue(db: RunnerDatabase, projectID: string): Issue | undefined {
  return triageIssues(db, projectID)[0];
}

function triageIssues(db: RunnerDatabase, projectID: string): Issue[] {
  return listIssues(db, { projectId: projectID, status: "triage" }).sort(nextTriageIssueOrder);
}

function scopedBatchCandidates(db: RunnerDatabase, projectID: string, scope: BatchTriageScope): Issue[] {
  const candidates = triageIssues(db, projectID);
  if (scope.kind !== "issue_refs") return candidates;
  const byID = new Map(candidates.map((issue) => [issue.id, issue]));
  return scope.issueIds.map((id) => byID.get(id)).filter((issue): issue is Issue => issue !== undefined);
}

function nextTriageIssueOrder(left: Issue, right: Issue): number {
  return (right.priority - left.priority) ||
    left.created_at.localeCompare(right.created_at) ||
    (left.id - right.id);
}

function enqueueIssueAndNotify(
  db: RunnerDatabase,
  context: NextTriageContext,
  issueID: number
): Record<string, number | string> {
  const issue = enqueueIssue(db, issueID);
  context.onIssueEnqueued?.(issue.project_id);
  return compactEnqueuedIssue(issue);
}

function enqueueBatchCandidates(
  db: RunnerDatabase,
  context: NextTriageContext,
  issues: Issue[],
  rationale: string | undefined,
  runGroupID: string
) {
  const result = { enqueued: [] as unknown[], pending: [] as unknown[], failed: [] as unknown[] };
  for (const issue of issues) {
    const actionResult = runEnqueueAction(db, context, issue, rationale, runGroupID);
    const actionID = cleanString(objectPayload(actionResult).action_id);
    attachRunGroupEnqueueAction(db, runGroupID, issue.id, actionID);
    updateRunGroupEnqueueResult(
      db,
      runGroupID,
      issue.id,
      cleanString(objectPayload(actionResult).status),
      actionFailureReason(actionResult)
    );
    collectBatchResult(result, issue, actionResult);
  }
  return result;
}

function runEnqueueAction(
  db: RunnerDatabase,
  context: NextTriageContext,
  issue: Issue,
  rationale: string | undefined,
  runGroupID: string
): unknown {
  try {
    return createPendingPiAction(db, enqueueActionContext(context, issue), enqueueProposal(issue, rationale, runGroupID),
      () => compactEnqueuedIssue(enqueueIssue(db, issue.id)));
  } catch (error) {
    return { error: safeError(error), status: "failed" };
  }
}

function collectBatchResult(result: BatchBuckets, issue: Issue, actionResult: unknown): void {
  const record = objectPayload(actionResult);
  const status = cleanString(record.status);
  if (status === "completed") result.enqueued.push(compactIssue(issue, getResultIssue(record.result)));
  else if (status === "pending") {
    result.pending.push({
      ...compactIssue(issue),
      reason: actionFailureReason(record) || "explicit user approval is required"
    });
  } else {
    result.failed.push({
      ...compactIssue(issue),
      reason: actionFailureReason(record) || status || "not_enqueued",
      status: status || "failed"
    });
  }
}

function compactEnqueuedIssue(issue: Issue): Record<string, number | string> {
  return {
    id: issue.id,
    message: `enqueued issue #${issue.id}: ${issue.title}`,
    project_id: issue.project_id,
    status: issue.status,
    title: issue.title
  };
}

function compactIssue(issue: Issue, result: Record<string, unknown> = {}): Record<string, number | string> {
  return {
    id: issue.id,
    status: cleanString(result.status) || issue.status,
    title: shortTitle(cleanString(result.title) || issue.title)
  };
}

function noNextTriageCandidate(projectID: string) {
  return {
    message: "没有可继续的 triage issue",
    project_id: projectID,
    source: "issue_enqueue_next_triage",
    status: "no_candidate"
  };
}

function noBatchTriageCandidate(projectID: string) {
  return {
    enqueued: [],
    enqueued_count: 0,
    message: "没有可批量继续的 triage issue",
    project_id: projectID,
    skipped: [],
    source: "issue_enqueue_batch_triage",
    status: "no_candidate"
  };
}

function batchSummary(projectID: string, total: number, result: BatchBuckets, runGroupID = "") {
  return {
    candidate_count: total,
    enqueued: result.enqueued,
    enqueued_count: result.enqueued.length,
    pending: result.pending,
    pending_count: result.pending.length,
    project_id: projectID,
    run_group_id: runGroupID,
    skipped: skipReasons(result),
    source: "issue_enqueue_batch_triage",
    status: batchStatus(result)
  };
}

type BatchBuckets = { enqueued: unknown[]; failed: unknown[]; pending: unknown[] };
type SkipReason = { count: number; reason: string };

function skipReasons(result: BatchBuckets): SkipReason[] {
  const reasons = new Map<string, number>();
  for (const item of [...result.pending, ...result.failed]) {
    const reason = cleanString(objectPayload(item).reason) || "not_enqueued";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return [...reasons.entries()].map(([reason, count]) => skipReason(reason, count));
}

function skipReason(reason: string, count: number): SkipReason {
  return { count, reason };
}

function batchStatus(result: BatchBuckets): string {
  if (result.enqueued.length > 0) {
    return result.pending.length > 0 || result.failed.length > 0 ? "partial" : "completed";
  }
  if (result.pending.length > 0) return "pending";
  const failedStatuses = result.failed.map((item) => cleanString(objectPayload(item).status));
  return failedStatuses.length > 0 && failedStatuses.every((status) => status === "denied")
    ? "denied"
    : "failed";
}

function actionFailureReason(value: unknown): string {
  const record = objectPayload(value);
  return cleanString(record.error) || cleanString(record.gate_reason);
}

function enqueueActionContext(context: NextTriageContext, issue: Issue): NextTriageContext {
  return scopedRunnerChatActionContext(context, "issue.enqueue", {
    issueID: issue.id,
    projectID: issue.project_id
  });
}

function enqueueProposal(issue: Issue, rationale: string | undefined, runGroupID = "") {
  return {
    actionType: "issue.enqueue",
    issueID: issue.id,
    payload: cleanObject({ issue_id: issue.id, run_group_id: runGroupID }),
    projectID: issue.project_id,
    rationale
  };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getResultIssue(value: unknown): Record<string, unknown> {
  return objectPayload(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortTitle(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function scopedProjectID(id: unknown, context: NextTriageContext): string {
  const projectID = cleanString(id) || (context.project?.id ?? "");
  if (projectID === "") throw new ProjectNotFoundError();
  return projectID;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([_key, value]) => {
    if (value === null || value === undefined) return false;
    return typeof value !== "string" || value.trim() !== "";
  }));
}
