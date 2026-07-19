import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import { parseProviderErrorSignal } from "../pi/providerErrorParser.ts";
import { redactSensitiveText } from "../util/redact.ts";

export const PROVIDER_BACKOFF_BASE_MS = 30_000;
export const PROVIDER_BACKOFF_MAX_MS = 15 * 60_000;

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
  provider: ExecutorProviderId,
  now = new Date()
): void {
  const message = redactSensitiveText(errorMessage(error));
  const attempt = providerDeferralAttempt(db, issueID, provider);
  const delayMs = providerBackoffMs(error, message, attempt, now);
  const nextCheckAt = new Date(now.getTime() + delayMs).toISOString();
  updateIssue(db, issueID, {
    auto_retry_next_at: nextCheckAt,
    auto_retry_reason: `provider_infra_transient:${provider}`,
    error: message
  });
  annotateOpenRun(db, issueID, provider, message);
  recordIssueEvent(db, issueID, "issue.provider_deferred", {
    backoff_attempt: attempt,
    backoff_ms: delayMs,
    error: message,
    next_check_at: nextCheckAt,
    provider,
    reason: "provider_infra_transient"
  }, now);
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
  payload: Record<string, unknown>,
  timestamp?: Date
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), timestamp ? eventTimestamp(timestamp) : issueTimestamp()]
  );
}

function eventTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function providerDeferralAttempt(db: RunnerDatabase, issueID: number, provider: ExecutorProviderId): number {
  const count = db.sqlite.query<{ count: number }, [number, string]>(`
    select count(*) as count from issue_events
    where issue_id=? and type='issue.provider_deferred' and json_valid(payload)
      and json_extract(payload, '$.provider')=?
  `).get(issueID, provider)?.count ?? 0;
  return Math.min(Math.max(count + 1, 1), 31);
}

function providerBackoffMs(error: unknown, message: string, attempt: number, now: Date): number {
  const signal = parseProviderErrorSignal({ rawPayload: providerFailurePayload(error, message) }, { now });
  const retryAfterMs = Math.max(0, Date.parse(signal.retry_after_at ?? "") - now.getTime()) ||
    Math.max(0, signal.retry_after_seconds ?? 0) * 1000;
  const exponentialMs = PROVIDER_BACKOFF_BASE_MS * (2 ** Math.min(Math.max(attempt - 1, 0), 30));
  return Math.min(PROVIDER_BACKOFF_MAX_MS, Math.max(PROVIDER_BACKOFF_BASE_MS, exponentialMs, retryAfterMs));
}

function providerFailurePayload(error: unknown, message: string): Record<string, unknown> {
  if (!error || typeof error !== "object") return { error: message };
  return { ...(error as Record<string, unknown>), error: message };
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
