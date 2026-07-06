import type { RunnerDatabase } from "../database.ts";
import { getPiAutomation, type PiAutomationRecord } from "./piAutomations.ts";
import { automationIntervalMs } from "./piAutomationScheduleState.ts";

export type ClaimedPiAutomation = PiAutomationRecord;
export type AutomationRunPatch = {
  detail?: string;
  failedCursor?: string;
  lastSuccessfulCursor?: string;
  processedWatermark?: string;
};

type IDRow = { id: number };

const DEFAULT_LIMIT = 20;
const MAX_BACKOFF_SECONDS = 3600;

export function claimDuePiAutomations(
  db: RunnerDatabase,
  now: Date,
  limit = DEFAULT_LIMIT
): ClaimedPiAutomation[] {
  const claim = db.transaction((timestamp: string) => {
    markTimedOutPiAutomations(db, now);
    return dueAutomationIDs(db, timestamp, limit).flatMap((id) => claimOne(db, id, now));
  });
  return claim.immediate(now.toISOString());
}

export function markTimedOutPiAutomations(db: RunnerDatabase, now: Date): number {
  const rows = db.sqlite.query<IDRow, [string]>(`
    select id from pi_automations
    where lock_token<>'' and lock_expires_at<>'' and lock_expires_at<=?
  `).all(now.toISOString());
  for (const row of rows) {
    const automation = getPiAutomation(db, row.id);
    if (!automation) continue;
    recordPiAutomationFailure(db, automation, now, {
      detail: "automation run timeout",
      failedCursor: runCursor(automation)
    });
  }
  return rows.length;
}

export function recordPiAutomationSuccess(
  db: RunnerDatabase,
  automation: PiAutomationRecord,
  now: Date,
  patch: AutomationRunPatch = {}
): void {
  db.sqlite.run(`update pi_automations set last_run_at=?, last_status='success',
    last_result=?, error='', run_count=run_count+1, retry_count=0,
    next_run_at=?, lock_token='', lock_expires_at='', run_started_at='',
    processed_watermark=?, last_successful_cursor=?, failed_cursor='', updated_at=?
    where id=? and lock_token=?`, [
    now.toISOString(), clean(patch.detail) || "automation run succeeded",
    nextScheduledRun(automation, now), clean(patch.processedWatermark) || automation.processed_watermark,
    clean(patch.lastSuccessfulCursor) || automation.last_successful_cursor,
    now.toISOString(), automation.id, automation.lock_token
  ]);
}

export function recordPiAutomationFailure(
  db: RunnerDatabase,
  automation: PiAutomationRecord,
  now: Date,
  patch: AutomationRunPatch = {}
): void {
  const detail = clean(patch.detail) || "automation run failed";
  db.sqlite.run(`update pi_automations set last_run_at=?, last_status='error',
    last_result=?, error=?, run_count=run_count+1, retry_count=retry_count+1,
    next_run_at=?, lock_token='', lock_expires_at='', run_started_at='',
    failed_cursor=?, updated_at=? where id=? and lock_token=?`, [
    now.toISOString(), detail, detail, nextRetryRun(automation, now),
    clean(patch.failedCursor) || runCursor(automation), now.toISOString(),
    automation.id, automation.lock_token
  ]);
}

function dueAutomationIDs(db: RunnerDatabase, nowText: string, limit: number): number[] {
  return db.sqlite.query<IDRow, [string, number]>(`
    select id from pi_automations
    where enabled=1 and trigger_type in ('schedule', 'continuous')
      and next_run_at<>'' and next_run_at<=? and lock_token=''
    order by next_run_at asc, updated_at asc, id asc
    limit ?
  `).all(nowText, safeLimit(limit)).map((row) => row.id);
}

function claimOne(db: RunnerDatabase, id: number, now: Date): ClaimedPiAutomation[] {
  const automation = getPiAutomation(db, id);
  if (!automation) return [];
  const token = crypto.randomUUID();
  db.sqlite.run(`update pi_automations set lock_token=?, lock_expires_at=?,
    run_started_at=?, last_status='running', updated_at=?
    where id=? and lock_token=''`, [
    token, new Date(now.getTime() + automation.run_timeout_ms).toISOString(),
    now.toISOString(), now.toISOString(), id
  ]);
  const claimed = getPiAutomation(db, id);
  return claimed?.lock_token === token ? [claimed] : [];
}

function nextScheduledRun(automation: PiAutomationRecord, now: Date): string {
  if (!["schedule", "continuous"].includes(automation.trigger_type)) return "";
  const interval = automationIntervalMs(automation.trigger);
  return interval > 0 ? new Date(now.getTime() + interval).toISOString() : "";
}

function nextRetryRun(automation: PiAutomationRecord, now: Date): string {
  return new Date(now.getTime() + retryBackoffSeconds(automation) * 1000).toISOString();
}

function retryBackoffSeconds(automation: PiAutomationRecord): number {
  const multiplier = 2 ** Math.min(automation.retry_count, 6);
  return Math.min(automation.retry_backoff_seconds * multiplier, MAX_BACKOFF_SECONDS);
}

function runCursor(automation: PiAutomationRecord): string {
  return automation.steps.map((step) => clean(step.cursor)).find(Boolean) || automation.last_successful_cursor;
}

function safeLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : DEFAULT_LIMIT;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
