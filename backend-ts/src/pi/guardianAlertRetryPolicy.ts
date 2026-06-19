import type {
  PiGuardianAlert,
  PiGuardianAlertInput,
  PiGuardianAlertStatus
} from "../db/repositories/pi/guardianAlerts.ts";
export { DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT } from "../db/repositories/pi/guardianAlerts.ts";
import { DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT } from "../db/repositories/pi/guardianAlerts.ts";

type RetryAlert = Pick<
  PiGuardianAlert,
  "direct_feishu_state" | "max_retry_count" | "next_retry_at" | "retry_count" | "status"
>;

const BACKOFF_SECONDS = [15 * 60, 60 * 60, 4 * 60 * 60] as const;
const TERMINAL_STATUSES = new Set<PiGuardianAlertStatus>(["acked", "resolved", "suppressed"]);

export function shouldAttemptGuardianAlertFeishu(alert: RetryAlert, now = new Date()): boolean {
  if (TERMINAL_STATUSES.has(alert.status)) return false;
  if (alert.retry_count >= maxRetryCount(alert.max_retry_count)) return false;
  if (["", "not_attempted"].includes(alert.direct_feishu_state)) return true;
  if (alert.direct_feishu_state === "sent") {
    return alert.next_retry_at !== "" && Date.parse(alert.next_retry_at) <= now.getTime();
  }
  if (alert.direct_feishu_state !== "retry") return false;
  if (alert.next_retry_at === "") return true;
  return Date.parse(alert.next_retry_at) <= now.getTime();
}

export function sentGuardianAlertRetryPatch(input: {
  alert: RetryAlert; messageId: string; now?: Date;
}): PiGuardianAlertInput {
  const max_retry_count = maxRetryCount(input.alert.max_retry_count);
  const retry_count = nextSentRetryCount(input.alert, max_retry_count);
  return {
    direct_feishu_error: "",
    direct_feishu_message_id: input.messageId,
    direct_feishu_state: "sent",
    max_retry_count,
    next_retry_at: retry_count >= max_retry_count
      ? ""
      : nextRetryAt(input.now ?? new Date(), retry_count + 1, undefined),
    retry_count
  };
}

export function failedGuardianAlertRetryPatch(input: {
  alert: RetryAlert; now?: Date; permanent?: boolean; retryAfterSeconds?: number;
}): PiGuardianAlertInput {
  const retryCount = Math.max(0, input.alert.retry_count) + 1;
  const max_retry_count = maxRetryCount(input.alert.max_retry_count);
  const failed = input.permanent === true || retryCount >= max_retry_count;
  return {
    direct_feishu_state: failed ? "failed" : "retry",
    max_retry_count,
    next_retry_at: failed ? "" : nextRetryAt(input.now ?? new Date(), retryCount, input.retryAfterSeconds),
    retry_count: retryCount
  };
}

function nextSentRetryCount(alert: RetryAlert, maxRetry: number): number {
  const current = Math.max(0, alert.retry_count);
  if (alert.direct_feishu_state === "sent") return Math.min(current + 1, maxRetry);
  return Math.min(current, maxRetry);
}

function nextRetryAt(now: Date, retryCount: number, retryAfterSeconds: number | undefined): string {
  return iso(new Date(now.getTime() + retryDelaySeconds(retryCount, retryAfterSeconds) * 1000));
}

function retryDelaySeconds(retryCount: number, retryAfterSeconds: number | undefined): number {
  const policyDelay = BACKOFF_SECONDS[Math.min(Math.max(retryCount, 1) - 1, BACKOFF_SECONDS.length - 1)];
  return Math.max(policyDelay, positiveSeconds(retryAfterSeconds));
}

function maxRetryCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_GUARDIAN_ALERT_MAX_RETRY_COUNT;
}

function positiveSeconds(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
