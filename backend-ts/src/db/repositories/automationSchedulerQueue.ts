import type { RunnerDatabase } from "../database.ts";
import { getAutomation, getAutomationTrigger, recordAutomationEvent } from "./automations.ts";
import type { AutomationAudit, AutomationDefinition, AutomationID, AutomationRun } from "../../domain/automation/contracts.ts";
import {
  type ClaimedAutomationRun,
  appendRunEvent,
  type Row,
  mapDefinition,
  mapTrigger,
  MISFIRE_GRACE_MS,
  LEASE_MS,
  changes,
  mapClaimedRun,
  MAX_ATTEMPTS
} from "./automationSchedulerStorage.ts";
import { nextRunAfter } from "./automationSchedulerCron.ts";

export function enqueueAutomationRunNow(
  db: RunnerDatabase,
  id: AutomationID,
  expectedRevision: number,
  audit: AutomationAudit,
  now = new Date()
): AutomationRun {
  const definition = getAutomation(db, id);
  if (!definition) throw new Error(`automation ${id} not found`);
  if (definition.revision !== expectedRevision) throw new Error("automation revision conflict");
  if (definition.status !== "active") throw new Error("only active automation can run now");
  const trigger = getAutomationTrigger(db, id);
  if (!trigger) throw new Error("automation trigger is unavailable");
  const slot = now.toISOString();
  const suffix = audit.event_id.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(-96);
  const run: ClaimedAutomationRun = {
    ...queuedRun(definition, slot, now),
    idempotency_key: `${definition.idempotency_namespace}:manual:${suffix}`,
    run_id: `automation-run:${definition.id.slice("automation:".length)}:manual:${suffix}`,
    trigger_version: trigger.version
  };
  db.transaction(() => {
    if (!insertRun(db, run, { detail: "operator requested run now", source: "automation_ui" })) {
      throw new Error("automation run-now request already exists");
    }
    appendRunEvent(db, run, "automation.run_queued.v1", now, "operator requested run now");
    recordAutomationEvent(db, id, "automation.triggered.v1", audit, { run_id: run.run_id, trigger: "manual" });
  })();
  return { ...run, summary: { detail: "operator requested run now", source: "automation_ui" } };
}

export function materializeDueRuns(db: RunnerDatabase, now: Date): number {
  const definitions = db.sqlite.query<Row, [string]>(`select d.*, c.trigger_type, c.config_json
    from automation_definitions d join automation_trigger_configs c
      on c.automation_id=d.id and c.version=d.active_trigger_version
    where d.status='active' and d.next_run_at is not null and d.next_run_at<=?
      and c.trigger_type in ('cron', 'continuous', 'manual')
      and not exists (select 1 from automation_runs r where r.automation_id=d.id and r.status in ('queued', 'running'))
    order by d.next_run_at asc, d.id asc`).all(now.toISOString());
  let skipped = 0;
  for (const row of definitions) {
    const definition = mapDefinition(row);
    const trigger = mapTrigger(row, definition.id, definition.active_trigger_version);
    const scheduledFor = definition.next_run_at!;
    const run = queuedRun(definition, scheduledFor, now);
    if (Date.parse(scheduledFor) < now.getTime() - MISFIRE_GRACE_MS) {
      insertRun(db, { ...run, completed_at: now.toISOString(), status: "skipped" }, {
        detail: "missed run skipped by deterministic policy", outcome: "misfire_skipped"
      });
      appendRunEvent(db, run, "automation.run_misfire_skipped.v1", now, "missed run skipped by deterministic policy");
      db.sqlite.run("update automation_definitions set next_run_at=?, updated_at=? where id=?", [
        nextRunAfter(trigger, now), now.toISOString(), definition.id
      ]);
      skipped += 1;
      continue;
    }
    if (!insertRun(db, run, { detail: "automation run queued", misfire_policy: "skip" })) continue;
    appendRunEvent(db, run, "automation.run_queued.v1", now, "due scan queued automation run");
  }
  return skipped;
}

export function claimQueuedRuns(db: RunnerDatabase, now: Date, limit: number): ClaimedAutomationRun[] {
  const ids = db.sqlite.query<{ run_id: string }, [string, number]>(`select run_id from automation_runs
    where status='queued' and next_attempt_at<=? and lease_token=''
    order by next_attempt_at asc, created_at asc, run_id asc limit ?`).all(now.toISOString(), limit);
  const claimed: ClaimedAutomationRun[] = [];
  for (const { run_id } of ids) {
    const token = crypto.randomUUID();
    db.sqlite.run(`update automation_runs set status='running', attempt_count=attempt_count+1, lease_token=?,
      lease_expires_at=? where run_id=? and status='queued' and next_attempt_at<=? and lease_token=''`, [
      token, new Date(now.getTime() + LEASE_MS).toISOString(), run_id, now.toISOString()
    ]);
    if (changes(db) !== 1) continue;
    const run = db.sqlite.query<Row, [string]>("select * from automation_runs where run_id=?").get(run_id);
    if (!run) continue;
    const claimedRun = mapClaimedRun(run);
    appendRunEvent(db, claimedRun, "automation.run_claimed.v1", now, "lease acquired by deterministic scheduler");
    claimed.push(claimedRun);
  }
  return claimed;
}

function queuedRun(definition: AutomationDefinition, scheduledFor: string, now: Date): ClaimedAutomationRun {
  const idempotency = `${definition.idempotency_namespace}:${definition.active_trigger_version}:${scheduledFor}`;
  return {
    automation_id: definition.id,
    attempt_count: 0,
    completed_at: null,
    created_at: now.toISOString(),
    idempotency_key: idempotency,
    lease_expires_at: "",
    lease_token: "",
    max_attempts: MAX_ATTEMPTS,
    next_attempt_at: now.toISOString(),
    requested_at: scheduledFor,
    run_id: `automation-run:${definition.id.slice("automation:".length)}:${definition.active_trigger_version}:${Date.parse(scheduledFor)}`,
    scheduled_for: scheduledFor,
    status: "queued",
    summary: {},
    trigger_version: definition.active_trigger_version
  };
}

function insertRun(db: RunnerDatabase, run: ClaimedAutomationRun, summary: Record<string, unknown>): boolean {
  db.sqlite.run(`insert or ignore into automation_runs (
    run_id, automation_id, trigger_version, idempotency_key, status, requested_at, completed_at,
    summary_json, created_at, scheduled_for, next_attempt_at, attempt_count, max_attempts, lease_token, lease_expires_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    run.run_id, run.automation_id, run.trigger_version, run.idempotency_key, run.status, run.requested_at,
    run.completed_at, JSON.stringify(summary), run.created_at, run.scheduled_for, run.next_attempt_at,
    run.attempt_count, run.max_attempts, run.lease_token, run.lease_expires_at
  ]);
  return changes(db) === 1;
}
