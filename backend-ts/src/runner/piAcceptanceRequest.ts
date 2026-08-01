import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";

export type PiAcceptanceRequestInput = {
  reason?: string;
  source: string;
};

/**
 * 将完成声明交给 Issue-scoped PI 验收，而不是由 Evidence 分类器改变生命周期。
 * 运行中的 Run 只能由 Provider terminal reconciliation 结束；外部 done 声明不得
 * 提前关闭 Run。已有终态 Run 时，Issue 仍保持 in_progress，由终态 Run 和
 * issue.pi_acceptance_requested.v1 表示“等待 PI 读取上下文并决定”。
 */
export function requestIssuePiAcceptance(
  db: RunnerDatabase,
  issueID: number,
  input: PiAcceptanceRequestInput
): Issue {
  const issue = mustGetIssue(db, issueID);
  if (issue.status === "done") return issue;
  const run = listIssueRuns(db, issueID).at(-1);
  if (!run) throw new Error("PI acceptance requires a canonical Run");
  if (run.ended_at === "") {
    recordOnce(db, issueID, "issue.pi_acceptance_deferred.v1", run.id, {
      issue_run_id: run.id,
      reason: cleanString(input.reason) || "done was requested before the current Run reached terminal state",
      source: input.source
    });
    return issue;
  }
  if (issue.status !== "in_progress") throw new Error(`PI acceptance cannot be requested from ${issue.status}`);
  recordOnce(db, issueID, "issue.pi_acceptance_requested.v1", run.id, {
    issue_run_id: run.id,
    reason: cleanString(input.reason) || "completion claim requires issue-scoped PI semantic acceptance",
    source: input.source
  });
  return issue;
}

function recordOnce(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  runID: string,
  payload: Record<string, unknown>
): void {
  const exists = listIssueEvents(db, issueID, { limit: 100, types: [type] }).some((event) => {
    try {
      const parsed = JSON.parse(event.payload) as Record<string, unknown>;
      return cleanString(parsed.issue_run_id) === runID;
    } catch {
      return false;
    }
  });
  if (!exists) recordIssueEvent(db, issueID, type, payload);
}

function mustGetIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue #${issueID} not found`);
  return issue;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
