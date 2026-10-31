import type { RunnerDatabase } from "../database.ts";
import { getAutomation, getAutomationTrigger } from "./automations.ts";
import {
  DEFAULT_LIMIT,
  type AutomationDueScanResult,
  safeLimit,
  type ClaimedAutomationRun,
  cleanDetail,
  changes,
  appendRunEvent,
  getClaimedRun,
  deadLetterAttention,
  advanceAfterTerminalRun,
  retryAtFor,
  type Row,
  mapClaimedRun
} from "./automationSchedulerStorage.ts";
import { materializeDueRuns, claimQueuedRuns } from "./automationSchedulerQueue.ts";
import { nextRunAfter } from "./automationSchedulerCron.ts";

// It intentionally never reads or mutates cron_tasks, pi_automations, watches, or heartbeats.
export function claimDueAutomationRuns(
  db: RunnerDatabase,
  now: Date,
  limit = DEFAULT_LIMIT
): AutomationDueScanResult {
  const scan = db.transaction((nowText: string) => {
    const recovered = recoverExpiredLeases(db, now);
    const skipped = materializeDueRuns(db, now);
    const claimed = claimQueuedRuns(db, now, safeLimit(limit));
    return { claimed, dead_lettered: recovered, skipped_misfires: skipped };
  });
  return scan.immediate(now.toISOString());
}

export function completeAutomationRun(
  db: RunnerDatabase,
  run: ClaimedAutomationRun,
  now: Date,
  detail = "automation run succeeded"
): boolean {
  const definition = getAutomation(db, run.automation_id);
  const trigger = definition && getAutomationTrigger(db, run.automation_id, run.trigger_version);
  if (!definition || !trigger) return false;
  const nextRunAt = nextRunAfter(trigger, new Date(run.scheduled_for));
  const updated = db.transaction(() => {
    db.sqlite.run(`update automation_runs set status='succeeded', completed_at=?, summary_json=?,
      lease_token='', lease_expires_at='', next_attempt_at=?
      where run_id=? and status='running' and lease_token=?`, [
      now.toISOString(), JSON.stringify({ detail: cleanDetail(detail) }), now.toISOString(), run.run_id, run.lease_token
    ]);
    if (changes(db) !== 1) return false;
    db.sqlite.run(`update automation_definitions set next_run_at=?, updated_at=? where id=?`, [
      nextRunAt, now.toISOString(), run.automation_id
    ]);
    appendRunEvent(db, run, "automation.run_succeeded.v1", now, cleanDetail(detail));
    return true;
  });
  return updated.immediate();
}

export function skipAutomationRun(
  db: RunnerDatabase,
  run: ClaimedAutomationRun,
  now: Date,
  detail = "automation run skipped"
): boolean {
  const definition = getAutomation(db, run.automation_id);
  const trigger = definition && getAutomationTrigger(db, run.automation_id, run.trigger_version);
  if (!definition || !trigger) return false;
  const nextRunAt = nextRunAfter(trigger, new Date(run.scheduled_for));
  const updated = db.transaction(() => {
    db.sqlite.run(`update automation_runs set status='skipped', completed_at=?, summary_json=?,
      lease_token='', lease_expires_at='', next_attempt_at=?
      where run_id=? and status='running' and lease_token=?`, [
      now.toISOString(), JSON.stringify({ detail: cleanDetail(detail), outcome: "skipped" }),
      now.toISOString(), run.run_id, run.lease_token
    ]);
    if (changes(db) !== 1) return false;
    db.sqlite.run(`update automation_definitions set next_run_at=?, updated_at=? where id=?`, [
      nextRunAt, now.toISOString(), run.automation_id
    ]);
    appendRunEvent(db, run, "automation.run_skipped.v1", now, cleanDetail(detail));
    return true;
  });
  return updated.immediate();
}

export function failAutomationRun(
  db: RunnerDatabase,
  run: ClaimedAutomationRun,
  now: Date,
  error: unknown
): "dead_lettered" | "retried" | "stale" {
  const detail = cleanDetail(error instanceof Error ? error.message : String(error));
  const result = db.transaction(() => {
    const current = getClaimedRun(db, run.run_id, run.lease_token);
    if (!current) return "stale" as const;
    if (current.attempt_count >= current.max_attempts) {
      db.sqlite.run(`update automation_runs set status='failed', completed_at=?, summary_json=?,
        lease_token='', lease_expires_at='', next_attempt_at=? where run_id=? and lease_token=?`, [
        now.toISOString(), JSON.stringify({ detail, outcome: "dead_lettered" }), now.toISOString(), run.run_id, run.lease_token
      ]);
      appendRunEvent(db, current, "automation.run_dead_lettered.v1", now, detail);
      deadLetterAttention(db, current, now, detail);
      advanceAfterTerminalRun(db, current, now);
      return "dead_lettered" as const;
    }
    const retryAt = retryAtFor(current, now);
    db.sqlite.run(`update automation_runs set status='queued', summary_json=?, lease_token='', lease_expires_at='',
      next_attempt_at=? where run_id=? and lease_token=?`, [
      JSON.stringify({ detail, outcome: "retry_scheduled" }), retryAt, run.run_id, run.lease_token
    ]);
    appendRunEvent(db, current, "automation.run_retry_scheduled.v1", now, detail);
    return "retried" as const;
  });
  return result.immediate();
}

function recoverExpiredLeases(db: RunnerDatabase, now: Date): number {
  const expired = db.sqlite.query<Row, [string]>(`select * from automation_runs
    where status='running' and lease_token<>'' and lease_expires_at<>'' and lease_expires_at<=?`).all(now.toISOString())
    .map(mapClaimedRun);
  for (const run of expired) {
    if (run.attempt_count >= run.max_attempts) {
      db.sqlite.run(`update automation_runs set status='failed', completed_at=?, summary_json=?, lease_token='',
        lease_expires_at='', next_attempt_at=? where run_id=? and lease_token=?`, [
        now.toISOString(), JSON.stringify({ detail: "automation lease expired", outcome: "dead_lettered" }),
        now.toISOString(), run.run_id, run.lease_token
      ]);
      appendRunEvent(db, run, "automation.run_dead_lettered.v1", now, "automation lease expired");
      deadLetterAttention(db, run, now, "automation lease expired");
      advanceAfterTerminalRun(db, run, now);
      continue;
    }
    const retryAt = retryAtFor(run, now);
    db.sqlite.run(`update automation_runs set status='queued', summary_json=?, lease_token='', lease_expires_at='',
      next_attempt_at=? where run_id=? and lease_token=?`, [
      JSON.stringify({ detail: "automation lease expired", outcome: "retry_scheduled" }), retryAt, run.run_id, run.lease_token
    ]);
    appendRunEvent(db, run, "automation.run_lease_expired.v1", now, "automation lease expired");
  }
  return expired.filter((run) => run.attempt_count >= run.max_attempts).length;
}

export type { ClaimedAutomationRun } from "./automationSchedulerStorage.ts";
export { enqueueAutomationRunNow } from "./automationSchedulerQueue.ts";
export { nextCronOccurrence } from "./automationSchedulerCron.ts";
