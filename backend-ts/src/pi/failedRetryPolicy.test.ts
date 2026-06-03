import { describe, expect, test } from "bun:test";
import { evaluateFailedRetryPolicy } from "./failedRetryPolicy.ts";

const NOW = new Date("2026-01-01T01:00:00Z");
const POLICY = { enabled: true, max_attempts: 2, backoff_minutes: [30, 60] };

describe("failed retry policy", () => {
  test("generates retry candidate only after cooldown reaches the retry window", () => {
    expect(evaluateFailedRetryPolicy({
      attemptCount: 1,
      autoRetryNextAt: "",
      category: "transient",
      now: NOW,
      policy: POLICY,
      updatedAt: "2026-01-01T00:00:00Z"
    })).toMatchObject({ reason: "failed_retry_ready", retry_candidate: true });

    expect(evaluateFailedRetryPolicy({
      attemptCount: 1,
      autoRetryNextAt: "",
      category: "transient",
      now: NOW,
      policy: POLICY,
      updatedAt: "2026-01-01T00:45:00Z"
    })).toMatchObject({ reason: "failed_retry_cooling_down", retry_candidate: false });
  });

  test("exhausts max retry attempts and escalates needs-user failures", () => {
    expect(evaluateFailedRetryPolicy({
      attemptCount: 2,
      autoRetryNextAt: "",
      category: "transient",
      now: NOW,
      policy: POLICY,
      updatedAt: "2026-01-01T00:00:00Z"
    })).toMatchObject({ category: "needs_user", reason: "failed_retry_exhausted", retry_candidate: false });

    expect(evaluateFailedRetryPolicy({
      attemptCount: 1,
      autoRetryNextAt: "2026-01-01T00:10:00Z",
      category: "needs_user",
      now: NOW,
      policy: POLICY,
      updatedAt: "2026-01-01T00:00:00Z"
    })).toMatchObject({ category: "needs_user", reason: "needs_user", retry_candidate: false });
  });
});
