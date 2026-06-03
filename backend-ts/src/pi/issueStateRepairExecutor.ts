import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import type { IssueStateRepairOperation } from "./issueStateManager.ts";

export function applyIssueStateRepair(db: RunnerDatabase, payload: Record<string, unknown>): unknown {
  const issueID = positiveID(payload.issue_id);
  const operation = cleanString(payload.operation) as IssueStateRepairOperation;
  const audit = repairAudit(db, operation, payload);
  const result = executeRepair(db, issueID, operation, payload);
  recordIssueEvent(db, issueID, "issue.state_manager_repair", audit);
  return result;
}

function executeRepair(
  db: RunnerDatabase,
  issueID: number,
  operation: IssueStateRepairOperation,
  payload: Record<string, unknown>
): unknown {
  if (operation === "enqueue") return enqueueIssue(db, issueID);
  if (operation === "retry") return retryIssue(db, issueID);
  const patch = objectPayload(payload.patch);
  if (operation === "move_status" || operation === "patch_status") return updateIssue(db, issueID, patch);
  if (operation === "comment") return createIssueComment(db, issueID, {
    author: "agent",
    body: cleanString(patch.body) || cleanString(payload.rationale)
  });
  throw new Error("unsupported issue state repair operation");
}

function repairAudit(
  db: RunnerDatabase,
  operation: IssueStateRepairOperation,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    diagnosis_code: cleanString(payload.diagnosis_code),
    evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
    operation,
    runner_executor_busy: hasActiveExecutorWork(db)
  };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveID(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error("issue_id is required");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
