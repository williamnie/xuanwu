import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { createPendingPiAction, type PiActionContext } from "./actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";

export type NextTriageIssueInput = { project_id?: string; rationale?: string };
export type BatchTriageIssueInput = { max_count?: number; project_id?: string; rationale?: string; user_phrase?: string };

type NextTriageContext = PiActionContext & {
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
};

const DEFAULT_BATCH_TRIAGE_LIMIT = 5;
const MAX_BATCH_TRIAGE_LIMIT = 10;

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
  if (!hasExplicitBatchIntent(input.user_phrase)) return refusedBatchIntent(projectID);
  const candidates = triageIssues(db, projectID);
  if (candidates.length === 0) return noBatchTriageCandidate(projectID);
  const limit = batchLimit(input.max_count);
  const result = enqueueBatchCandidates(db, context, candidates.slice(0, limit), input.rationale);
  if (result.enqueued.length > 0) context.onIssueEnqueued?.(projectID);
  return batchSummary(projectID, limit, candidates.length, result);
}

function nextTriageIssue(db: RunnerDatabase, projectID: string): Issue | undefined {
  return triageIssues(db, projectID)[0];
}

function triageIssues(db: RunnerDatabase, projectID: string): Issue[] {
  return listIssues(db, { projectId: projectID, status: "triage" }).sort(nextTriageIssueOrder);
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
  rationale: string | undefined
) {
  const result = { enqueued: [] as unknown[], pending: [] as unknown[], failed: [] as unknown[] };
  for (const issue of issues) collectBatchResult(result, issue, runEnqueueAction(db, context, issue, rationale));
  return result;
}

function runEnqueueAction(
  db: RunnerDatabase,
  context: NextTriageContext,
  issue: Issue,
  rationale: string | undefined
): unknown {
  try {
    return createPendingPiAction(db, enqueueActionContext(context, issue), enqueueProposal(issue, rationale),
      () => compactEnqueuedIssue(enqueueIssue(db, issue.id)));
  } catch (error) {
    return { error: safeError(error), status: "failed" };
  }
}

function collectBatchResult(result: BatchBuckets, issue: Issue, actionResult: unknown): void {
  const record = objectPayload(actionResult);
  const status = cleanString(record.status);
  if (status === "completed") result.enqueued.push(compactIssue(issue, getResultIssue(record.result)));
  else if (status === "pending") result.pending.push(compactIssue(issue));
  else result.failed.push({ ...compactIssue(issue), reason: cleanString(record.error) || status || "not_enqueued" });
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

function refusedBatchIntent(projectID: string) {
  return {
    message: "批量继续需要明确包含所有/全部/这组都/剩下都等语义",
    project_id: projectID,
    reason: "missing_explicit_batch_intent",
    source: "issue_enqueue_batch_triage",
    status: "refused"
  };
}

function batchSummary(projectID: string, limit: number, total: number, result: BatchBuckets) {
  return {
    candidate_count: total,
    enqueued: result.enqueued,
    enqueued_count: result.enqueued.length,
    max_count: limit,
    pending: result.pending,
    pending_count: result.pending.length,
    project_id: projectID,
    skipped: skipReasons(total, limit, result),
    source: "issue_enqueue_batch_triage",
    status: batchStatus(result)
  };
}

type BatchBuckets = { enqueued: unknown[]; failed: unknown[]; pending: unknown[] };
type SkipReason = { count: number; reason: string };

function skipReasons(total: number, limit: number, result: BatchBuckets): SkipReason[] {
  return [
    skipReason("approval_required", result.pending.length),
    skipReason("enqueue_failed", result.failed.length),
    skipReason("limit_exceeded", Math.max(0, total - limit))
  ].filter((item) => item.count > 0);
}

function skipReason(reason: string, count: number): SkipReason {
  return { count, reason };
}

function batchStatus(result: BatchBuckets): string {
  if (result.enqueued.length > 0) return "completed";
  if (result.pending.length > 0) return "pending";
  return "skipped";
}

function enqueueActionContext(context: NextTriageContext, issue: Issue): NextTriageContext {
  return scopedRunnerChatActionContext(context, "issue.enqueue", {
    issueID: issue.id,
    projectID: issue.project_id
  });
}

function enqueueProposal(issue: Issue, rationale: string | undefined) {
  return {
    actionType: "issue.enqueue",
    issueID: issue.id,
    payload: { issue_id: issue.id },
    projectID: issue.project_id,
    rationale
  };
}

function batchLimit(value: unknown): number {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? value : DEFAULT_BATCH_TRIAGE_LIMIT;
  return Math.min(MAX_BATCH_TRIAGE_LIMIT, Math.max(1, raw));
}

function hasExplicitBatchIntent(value: unknown): boolean {
  const text = cleanString(value);
  if (text === "") return false;
  return /所有|全部|这组都|这一组都|剩下都|剩余都|都做完|全做完|\b(all|everything|remaining|rest)\b/i.test(text);
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
