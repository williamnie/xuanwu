import type { RunnerDatabase } from "../db/database.ts";
import { getProjectPiPolicy } from "../db/repositories/pi.ts";

export type FailedRetryCategory = "blocked" | "needs_user" | "transient" | "verification_needed";
export type FailedRetryPolicy = { enabled: boolean; max_attempts: number; backoff_minutes: number[] };
export type FailedRetryDecision = {
  category: FailedRetryCategory;
  max_attempts: number;
  next_retry_at: string;
  reason: string;
  retry_candidate: boolean;
};

type FailedRetryInput = {
  attemptCount: number;
  autoRetryNextAt: string;
  category: FailedRetryCategory;
  now: Date;
  policy: FailedRetryPolicy | null;
  updatedAt: string;
};
type FindingCategoryInput = { autoRetryNextAt: string; detail: string; status: string };
type ProjectRetryInput = Omit<FailedRetryInput, "policy"> & { db: RunnerDatabase; projectID: string; status: string };

const MS_PER_MINUTE = 60_000;

export function evaluateFailedRetryPolicy(input: FailedRetryInput): FailedRetryDecision {
  const maxAttempts = maxAttemptsFor(input.policy);
  if (input.category === "needs_user") return decision("needs_user", "needs_user", false, maxAttempts);
  if (input.category !== "transient") return decision("blocked", "issue_failed", false, maxAttempts);
  if (!input.policy) return decision("transient", "transient_retry_waiting", true, maxAttempts);
  if (!input.policy.enabled) return decision("blocked", "retry_policy_disabled", false, maxAttempts);
  if (input.attemptCount >= maxAttempts) {
    return decision("needs_user", "failed_retry_exhausted", false, maxAttempts);
  }
  const nextRetry = nextRetryAt(input);
  if (nextRetry > input.now.getTime()) {
    return decision("transient", "failed_retry_cooling_down", false, maxAttempts, iso(new Date(nextRetry)));
  }
  return decision("transient", "failed_retry_ready", true, maxAttempts, safeIso(nextRetry));
}

export function evaluateProjectFailedRetryPolicy(input: ProjectRetryInput): FailedRetryDecision | undefined {
  if (input.status !== "failed") return undefined;
  return evaluateFailedRetryPolicy({ ...input, policy: projectRetryPolicy(input.db, input.projectID) });
}

export function defaultFindingCategory(input: FindingCategoryInput): FailedRetryCategory {
  if (input.status === "pending_verification") return "verification_needed";
  if (isNeedsUserText(input.detail)) return "needs_user";
  if (input.autoRetryNextAt !== "" || isTransientText(input.detail)) return "transient";
  return "blocked";
}

export function defaultFindingReason(status: string, category: FailedRetryCategory): string {
  if (category === "transient") return "transient_retry_waiting";
  if (category === "needs_user") return "needs_user";
  return status === "failed" ? "issue_failed" : "pending_verification";
}

export function projectRetryPolicy(db: RunnerDatabase, projectID: string): FailedRetryPolicy | null {
  const policy = getProjectPiPolicy(db, projectID);
  return policy ? JSON.parse(policy.retry_policy_json) as FailedRetryPolicy : null;
}

function nextRetryAt(input: FailedRetryInput): number {
  const explicit = parseTime(input.autoRetryNextAt);
  if (Number.isFinite(explicit)) return explicit;
  const updated = parseTime(input.updatedAt);
  if (!Number.isFinite(updated)) return Number.NEGATIVE_INFINITY;
  return updated + retryCooldownMs(input.policy, input.attemptCount);
}

function retryCooldownMs(policy: FailedRetryPolicy | null, attemptCount: number): number {
  const minutes = policy?.backoff_minutes ?? [];
  if (minutes.length === 0) return 0;
  const index = Math.min(Math.max(attemptCount, 1) - 1, minutes.length - 1);
  return minutes[index] * MS_PER_MINUTE;
}

function maxAttemptsFor(policy: FailedRetryPolicy | null): number {
  return policy?.enabled ? policy.max_attempts : 0;
}

function decision(
  category: FailedRetryCategory,
  reason: string,
  retryCandidate: boolean,
  maxAttempts: number,
  nextRetryAt = ""
): FailedRetryDecision {
  return { category, max_attempts: maxAttempts, next_retry_at: nextRetryAt, reason, retry_candidate: retryCandidate };
}

function parseTime(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeIso(timestamp: number): string {
  return Number.isFinite(timestamp) ? iso(new Date(timestamp)) : "";
}

function isNeedsUserText(value: string): boolean {
  const lower = value.toLowerCase();
  return [
    "needs user", "need user", "user input", "human", "manual", "approval denied",
    "requires confirmation", "waiting for user", "blocked by user"
  ].some((token) => lower.includes(token));
}

function isTransientText(value: string): boolean {
  const lower = value.toLowerCase().trim();
  if (lower === "") return false;
  if (["permission denied", "approval denied", "runner paused", "usage limit",
    "authentication failed", "api returned 401", "api returned 429", "verification failed",
    "test failed", "tests failed", "exit status", "command timed out"
  ].some((token) => lower.includes(token))) return false;
  return lower === "eof" || ["stream disconnected before completion", "transport error",
    "network error", "error decoding response body", "connection reset", "unexpected eof",
    ": eof", " eof", "timeout", "timed out", "deadline exceeded"
  ].some((token) => lower.includes(token));
}
