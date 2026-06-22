import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";

const PROVIDER_INFRA_TRANSIENT_PATTERNS = [
  /app-server request timed out/i,
  /request timed out after \d+ms:\s*initialize/i,
  /\binitialize\b.*\btimed out\b/i,
  /\btimed out\b.*\binitialize\b/i,
  /transport stopped/i,
  /app-server exited before response/i,
  /not initialized/i,
  /stream disconnected before completion/i,
  /unexpected eof/i,
  /connection reset/i,
  /network error/i,
  /transport error/i,
  /deadline exceeded/i,
  /claude code run timed out/i
];

export function isProviderInfraTransientFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (businessFailureMessage(message)) return false;
  return PROVIDER_INFRA_TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

export function deferIssueToPiAfterProviderFailure(
  db: RunnerDatabase,
  issueID: number,
  error: unknown,
  provider: ExecutorProviderId
): void {
  const message = redactSensitiveText(errorMessage(error));
  updateIssue(db, issueID, { error: message });
  annotateOpenRun(db, issueID, provider, message);
  recordIssueEvent(db, issueID, "issue.provider_deferred", {
    error: message,
    provider,
    reason: "provider_infra_transient"
  });
}

function annotateOpenRun(
  db: RunnerDatabase,
  issueID: number,
  provider: ExecutorProviderId,
  error: string
): void {
  db.sqlite.run(`update issue_runs set status='in_progress', provider=?, error=?
    where id=(select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1)`,
    [provider, error, issueID]);
}

export function recordIssueEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  payload: Record<string, string>
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), issueTimestamp()]
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = String(error).trim();
  return message || "provider run failed";
}

function businessFailureMessage(message: string): boolean {
  return [
    "permission denied",
    "approval denied",
    "unauthorized",
    "forbidden",
    "access denied",
    "authentication failed",
    "api returned 401",
    "api returned 403",
    "api returned 429",
    "too many requests",
    "rate limit",
    "usage limit",
    "insufficient quota",
    "quota exceeded",
    "quota exhausted",
    "verification failed",
    "test failed",
    "tests failed",
    "exit status",
    "command timed out"
  ].some((token) => message.includes(token));
}
