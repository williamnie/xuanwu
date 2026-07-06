export type PiAutomationScheduleState = {
  error: string; failed_cursor: string; last_result: string; last_run_at: string;
  last_status: string; last_successful_cursor: string; lock_expires_at: string;
  lock_token: string; next_run_at: string; processed_watermark: string;
  retry_backoff_seconds: number; retry_count: number; run_count: number;
  run_started_at: string; run_timeout_ms: number;
};

type ScheduleInput = Partial<PiAutomationScheduleState> & {
  id?: unknown;
  retry_backoff_seconds?: unknown;
  run_timeout_ms?: unknown;
};
type TriggerLike = Record<string, unknown> & { type: string };

export const DEFAULT_RETRY_BACKOFF_SECONDS = 60;
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

export function automationScheduleState(input: ScheduleInput, trigger: TriggerLike, timestamp: Date): PiAutomationScheduleState {
  return {
    error: clean(input.error), failed_cursor: clean(input.failed_cursor),
    last_result: clean(input.last_result), last_run_at: clean(input.last_run_at),
    last_status: clean(input.last_status), last_successful_cursor: clean(input.last_successful_cursor),
    lock_expires_at: clean(input.lock_expires_at), lock_token: clean(input.lock_token),
    next_run_at: initialNextRun(input.next_run_at, trigger, timestamp, nonNegative(input.id) > 0),
    processed_watermark: clean(input.processed_watermark),
    retry_backoff_seconds: positive(input.retry_backoff_seconds, DEFAULT_RETRY_BACKOFF_SECONDS),
    retry_count: nonNegative(input.retry_count), run_count: nonNegative(input.run_count),
    run_started_at: clean(input.run_started_at),
    run_timeout_ms: positive(input.run_timeout_ms, DEFAULT_RUN_TIMEOUT_MS)
  };
}

export function mapAutomationScheduleState(row: Record<string, unknown>): PiAutomationScheduleState {
  return automationScheduleState(row, { type: "manual" }, new Date(0));
}

export function automationIntervalMs(trigger: Record<string, unknown>): number {
  const value = trigger.every ?? trigger.interval_ms ?? trigger.intervalMs;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const match = clean(value).match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (match[2] === "h") return amount * 60 * 60 * 1000;
  if (match[2] === "m") return amount * 60 * 1000;
  if (match[2] === "s") return amount * 1000;
  return amount;
}

function initialNextRun(value: unknown, trigger: TriggerLike, timestamp: Date, existing: boolean): string {
  const explicit = clean(value);
  if (explicit !== "") return validTimestamp(explicit);
  if (existing || !["schedule", "continuous"].includes(trigger.type)) return "";
  return new Date(timestamp.getTime() + automationIntervalMs(trigger)).toISOString();
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("automation next_run_at must be RFC3339");
  return new Date(value).toISOString();
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
