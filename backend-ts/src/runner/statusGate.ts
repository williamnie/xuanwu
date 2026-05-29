import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";

export function failIssueExecution(db: RunnerDatabase, issueID: number, error: unknown, provider: ExecutorProviderId = "codex"): void {
  const message = redactSensitiveText(errorMessage(error));
  updateIssue(db, issueID, { status: "failed", error: message });
  recordIssueError(db, issueID, provider, message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = String(error).trim();
  return message || "provider run failed";
}

function recordIssueError(db: RunnerDatabase, issueID: number, provider: ExecutorProviderId, error: string): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.error", JSON.stringify({ error, provider }), issueTimestamp()]
  );
}
