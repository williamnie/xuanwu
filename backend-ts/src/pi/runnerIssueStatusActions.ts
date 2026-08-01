import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { requestIssuePiAcceptance } from "../runner/piAcceptanceRequest.ts";
import { applyPiSemanticIssueStatus } from "../runner/piIssueLifecycle.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import {
  cancelIssueWithInterrupt,
  interruptIssueForStatusTransition,
  retryIssueWithInterrupt
} from "../runner/interrupt.ts";
import {
  WORK_STATE_TRANSITIONS,
  WORK_STATUSES,
  type WorkStatus
} from "../domain/work/contracts.ts";

export type IssueStatusUpdateInput = {
  error?: string;
  issue_ids: number[];
  reason: string;
  status: WorkStatus;
};

export type IssueStatusUpdateRuntime = {
  bus?: Pick<EventBus, "publish">;
  onExecutionRequested?: (projectID: string) => void;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type PreparedIssueStatusUpdate = {
  issues: Issue[];
  projectID: string;
  targetStatus: WorkStatus;
};

export function allowedIssueStatusTargets(status: string): WorkStatus[] {
  if (!isWorkStatus(status)) return [];
  return [...WORK_STATE_TRANSITIONS[status]];
}

export function prepareIssueStatusUpdate(
  db: RunnerDatabase,
  input: IssueStatusUpdateInput
): PreparedIssueStatusUpdate {
  const ids = uniqueIssueIDs(input.issue_ids);
  const issues = ids.map((id) => mustGetIssue(db, id));
  const projectIDs = new Set(issues.map((issue) => issue.project_id));
  if (projectIDs.size !== 1) throw new Error("一次只能更新同一项目内的 Issue");
  for (const issue of issues) {
    if (issue.status === "needs_user" && input.status === "in_progress") {
      throw new Error(
        `Issue #${issue.id} 正在等待 human review；请使用 human_review_response 回答当前验收请求，` +
        "不要用 issue_status_update 隐式创建新的 Run/Session"
      );
    }
    assertStatusTransition(issue, input.status);
  }
  return { issues, projectID: issues[0]!.project_id, targetStatus: input.status };
}

export async function executeIssueStatusUpdate(
  db: RunnerDatabase,
  input: IssueStatusUpdateInput,
  runtime: IssueStatusUpdateRuntime = {}
) {
  const prepared = prepareIssueStatusUpdate(db, input);
  const items = [];
  for (const issue of prepared.issues) {
    try {
      items.push(await updateOneIssueStatus(db, issue, input, runtime));
    } catch (error) {
      const current = mustGetIssue(db, issue.id);
      items.push(statusResult(issue, current, input.status, false, safeError(error)));
    }
  }
  if (items.some((item) => item.accepted && item.execution_requested)) {
    runtime.onExecutionRequested?.(prepared.projectID);
  }
  const accepted = items.filter((item) => item.accepted).length;
  return {
    accepted,
    failed: items.length - accepted,
    items,
    project_id: prepared.projectID,
    requested_status: input.status,
    status: accepted === items.length ? "completed" : accepted > 0 ? "partial" : "failed"
  };
}

async function updateOneIssueStatus(
  db: RunnerDatabase,
  issue: Issue,
  input: IssueStatusUpdateInput,
  runtime: IssueStatusUpdateRuntime
) {
  if (issue.status === input.status) return statusResult(issue, issue, input.status, false);
  if (input.status === "cancelled") {
    return statusResult(issue, await cancelIssueWithInterrupt(db, issue.id, runtime), input.status, false);
  }
  if (input.status === "done") {
    const pending = requestIssuePiAcceptance(db, issue.id, {
      reason: input.reason,
      source: "pi-issue-status-update"
    });
    return statusResult(issue, pending, input.status, false, "", true);
  }
  if (input.status === "todo" && issue.status !== "triage") {
    const updated = await retryIssueWithInterrupt(db, issue.id, {}, runtime);
    return statusResult(issue, updated, input.status, true);
  }
  if (input.status === "in_progress") {
    const updated = issue.status === "triage" || issue.status === "todo"
      ? enqueueIssue(db, issue.id)
      : await retryIssueWithInterrupt(db, issue.id, {}, runtime);
    return statusResult(issue, updated, input.status, true);
  }
  if (issue.status === "in_progress") {
    await interruptIssueForStatusTransition(db, issue.id, `issue_status_update:${input.status}`, runtime);
  }
  if (input.status === "needs_user" || input.status === "failed") {
    const updated = applyPiSemanticIssueStatus(db, issue.id, {
      card_fingerprint: `pi-status-update:${issue.id}:${issue.updated_at}:${input.status}`,
      decision: input.status,
      reason: cleanString(input.error) || input.reason,
      run_id: issue.latest_run?.id ?? "",
      status: input.status
    });
    return statusResult(issue, updated, input.status, false);
  }
  const patch = { error: "", status: input.status };
  return statusResult(issue, updateIssue(db, issue.id, patch), input.status, false);
}

function statusResult(
  previous: Issue,
  current: Issue,
  requestedStatus: WorkStatus,
  executionRequested: boolean,
  error = "",
  acceptanceRequested = false
) {
  const reachedTarget = current.status === requestedStatus;
  return {
    acceptance_requested: acceptanceRequested,
    accepted: error === "" && (reachedTarget || executionRequested || acceptanceRequested),
    actual_status: current.status,
    changed: previous.status !== current.status,
    error,
    execution_requested: executionRequested,
    id: current.id,
    previous_status: previous.status,
    project_id: current.project_id,
    reached_target: reachedTarget,
    requested_status: requestedStatus,
    title: current.title
  };
}

function assertStatusTransition(issue: Issue, target: WorkStatus): void {
  if (issue.status === target) return;
  const allowed = allowedIssueStatusTargets(issue.status);
  if (allowed.includes(target)) return;
  throw new Error(
    `Issue #${issue.id} 不允许从 ${issue.status} 移动到 ${target}；可用目标：${allowed.join(", ") || "无"}`
  );
}

function uniqueIssueIDs(rawIDs: number[]): number[] {
  const ids = [...new Set(rawIDs)];
  if (ids.length === 0) throw new Error("issue_ids 不能为空");
  if (ids.length > 40) throw new Error("一次最多更新 40 个 Issue");
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("issue_ids 必须是正整数");
  return ids;
}

function isWorkStatus(value: string): value is WorkStatus {
  return WORK_STATUSES.includes(value as WorkStatus);
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
