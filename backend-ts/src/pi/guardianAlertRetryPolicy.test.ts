import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT,
  failedGuardianAlertRetryPatch,
  shouldAttemptGuardianAlertFeishu
} from "./guardianAlertRetryPolicy.ts";
import type { PiGuardianAlert, PiGuardianAlertStatus } from "../db/repositories/pi.ts";

const NOW = new Date("2026-06-19T01:00:00Z");

describe("PI guardian alert retry policy", () => {
  test("uses fake-clock backoff and stops at the max retry cap", () => {
    const first = failedGuardianAlertRetryPatch({
      alert: alert({ retry_count: 0 }),
      now: NOW,
      retryAfterSeconds: 30
    });
    const second = failedGuardianAlertRetryPatch({
      alert: alert({ retry_count: 1 }),
      now: NOW
    });
    const capped = failedGuardianAlertRetryPatch({
      alert: alert({ retry_count: DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT - 1 }),
      now: NOW
    });

    expect(first).toMatchObject({
      direct_feishu_state: "retry",
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 1
    });
    expect(second).toMatchObject({
      direct_feishu_state: "retry",
      next_retry_at: "2026-06-19T02:00:00Z",
      retry_count: 2
    });
    expect(capped).toMatchObject({
      direct_feishu_state: "failed",
      next_retry_at: "",
      retry_count: DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT
    });
  });

  test("does not retry terminal alerts or retry alerts before next_retry_at", () => {
    expect(shouldAttemptGuardianAlertFeishu(alert({ status: "acked" }), NOW)).toBe(false);
    expect(shouldAttemptGuardianAlertFeishu(alert({ status: "resolved" }), NOW)).toBe(false);
    expect(shouldAttemptGuardianAlertFeishu(alert({ status: "suppressed" }), NOW)).toBe(false);
    expect(shouldAttemptGuardianAlertFeishu(alert({
      direct_feishu_state: "retry",
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 1
    }), NOW)).toBe(false);
    expect(shouldAttemptGuardianAlertFeishu(alert({
      direct_feishu_state: "retry",
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 1
    }), new Date("2026-06-19T01:15:00Z"))).toBe(true);
  });

  test("treats sent open alerts as pending ack only when their backoff is due", () => {
    expect(shouldAttemptGuardianAlertFeishu(alert({
      direct_feishu_state: "sent",
      next_retry_at: "",
      retry_count: 0
    }), NOW)).toBe(false);
    expect(shouldAttemptGuardianAlertFeishu(alert({
      direct_feishu_state: "sent",
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 0
    }), NOW)).toBe(false);
    expect(shouldAttemptGuardianAlertFeishu(alert({
      direct_feishu_state: "sent",
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 0
    }), new Date("2026-06-19T01:15:00Z"))).toBe(true);
    expect(shouldAttemptGuardianAlertFeishu(alert({
      direct_feishu_state: "sent",
      next_retry_at: "2026-06-19T06:00:00Z",
      retry_count: DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT
    }), new Date("2026-06-19T06:00:00Z"))).toBe(false);
  });
});

type AlertOverrides = {
  direct_feishu_state?: string; max_retry_count?: number; next_retry_at?: string;
  retry_count?: number; status?: PiGuardianAlertStatus;
};

function alert(overrides: AlertOverrides = {}): Pick<
  PiGuardianAlert,
  "direct_feishu_state" | "max_retry_count" | "next_retry_at" | "retry_count" | "status"
> {
  return {
    direct_feishu_state: overrides.direct_feishu_state ?? "retry",
    max_retry_count: overrides.max_retry_count ?? DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT,
    next_retry_at: overrides.next_retry_at ?? "",
    retry_count: overrides.retry_count ?? 0,
    status: overrides.status ?? "open"
  };
}
