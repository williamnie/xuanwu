import type { RunnerDatabase } from "../database.ts";
import { getAutomation, getAutomationTrigger, recordAutomationEvent } from "./automations.ts";
import { upsertPiGuardianAlert } from "./pi.ts";
import type { AutomationAudit, AutomationDefinition, AutomationID, AutomationRun, VersionedAutomationTrigger } from "../../domain/automation/contracts.ts";

type Row = Record<string, unknown>;

export type ClaimedAutomationRun = AutomationRun & {
  attempt_count: number;
  lease_expires_at: string;
  lease_token: string;
  max_attempts: number;
  next_attempt_at: string;
  scheduled_for: string;
};

export type AutomationDueScanResult = {
  claimed: ClaimedAutomationRun[];
  dead_lettered: number;
  skipped_misfires: number;
};

const DEFAULT_LIMIT = 20;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MISFIRE_GRACE_MS = 60_000;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 60 * 60;

// This repository is the sole P08.03 lease writer for automation_definitions.
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

function materializeDueRuns(db: RunnerDatabase, now: Date): number {
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

function claimQueuedRuns(db: RunnerDatabase, now: Date, limit: number): ClaimedAutomationRun[] {
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

function getClaimedRun(db: RunnerDatabase, runID: string, leaseToken: string): ClaimedAutomationRun | null {
  const row = db.sqlite.query<Row, [string, string]>(`select * from automation_runs
    where run_id=? and status='running' and lease_token=?`).get(runID, leaseToken);
  return row ? mapClaimedRun(row) : null;
}

function appendRunEvent(
  db: RunnerDatabase,
  run: Pick<ClaimedAutomationRun, "automation_id" | "run_id">,
  eventType: string,
  now: Date,
  detail: string
): void {
  db.sqlite.run(`insert into automation_run_events
    (event_id, automation_id, run_id, event_type, actor_id, actor_kind, correlation_id, detail, occurred_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    `automation-run-event:${crypto.randomUUID()}`, run.automation_id, run.run_id, eventType,
    "automation-scheduler", "system", `automation-run:${run.run_id}`, cleanDetail(detail), now.toISOString()
  ]);
}

function deadLetterAttention(db: RunnerDatabase, run: ClaimedAutomationRun, now: Date, detail: string): void {
  const definition = getAutomation(db, run.automation_id);
  upsertPiGuardianAlert(db, {
    alert_type: "automation_dead_letter",
    evidence_json: { automation_id: run.automation_id, run_id: run.run_id, attempts: run.attempt_count, error: detail },
    message: `Automation ${run.automation_id} exhausted ${run.max_attempts} attempts: ${detail}`,
    project_id: definition?.owner.kind === "project" ? definition.owner.project_id : "",
    run_group_id: `automation:${run.run_id}`,
    severity: "high",
    status: "open",
    watchdog_seen_at: now.toISOString()
  });
}

function advanceAfterTerminalRun(db: RunnerDatabase, run: ClaimedAutomationRun, now: Date): void {
  const definition = getAutomation(db, run.automation_id);
  const trigger = definition && getAutomationTrigger(db, run.automation_id, run.trigger_version);
  if (!trigger) return;
  db.sqlite.run("update automation_definitions set next_run_at=?, updated_at=? where id=?", [
    nextRunAfter(trigger, new Date(run.scheduled_for)), now.toISOString(), run.automation_id
  ]);
}

function nextRunAfter(trigger: VersionedAutomationTrigger, after: Date): string | null {
  if (trigger.type === "continuous") {
    return new Date(after.getTime() + trigger.config.poll_interval_seconds * 1000).toISOString();
  }
  if (trigger.type === "cron") return nextCronOccurrence(trigger.config.expression, trigger.config.timezone, after)?.toISOString() ?? null;
  return null;
}

export function nextCronOccurrence(expression: string, timezone: string, after: Date): Date | null {
  const fields = cronFields(expression);
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const previousLocal = localSlot(after, timezone);
  for (let offset = 0; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = zonedParts(candidate, timezone);
    if (matchesCron(fields, parts) && localSlot(candidate, timezone) !== previousLocal) return candidate;
  }
  return null;
}

type CronFields = { day: Set<number> | null; hour: Set<number> | null; minute: Set<number> | null; month: Set<number> | null; weekday: Set<number> | null };
type ZonedParts = { day: number; hour: number; minute: number; month: number; weekday: number; year: number };

function cronFields(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression must have five fields");
  return {
    minute: cronField(fields[0], 0, 59), hour: cronField(fields[1], 0, 23), day: cronField(fields[2], 1, 31),
    month: cronField(fields[3], 1, 12), weekday: cronField(fields[4], 0, 6, true)
  };
}

function cronField(text: string, min: number, max: number, sundaySeven = false): Set<number> | null {
  if (text === "*") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) throw new Error("cron step is invalid");
    const [fromText, toText] = range === "*" ? [String(min), String(max)] : range.split("-");
    const from = cronNumber(fromText, min, max, sundaySeven);
    const to = cronNumber(toText ?? fromText, min, max, sundaySeven);
    if (from > to) throw new Error("cron range is invalid");
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function cronNumber(text: string, min: number, max: number, sundaySeven: boolean): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > (sundaySeven ? 7 : max)) throw new Error("cron field is invalid");
  return sundaySeven && value === 7 ? 0 : value;
}

function matchesCron(fields: CronFields, parts: ZonedParts): boolean {
  return matches(fields.minute, parts.minute) && matches(fields.hour, parts.hour) && matches(fields.day, parts.day)
    && matches(fields.month, parts.month) && matches(fields.weekday, parts.weekday);
}

function matches(values: Set<number> | null, value: number): boolean { return values === null || values.has(value); }

function zonedParts(date: Date, timezone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit",
    timeZone: timezone, weekday: "short", year: "numeric"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), month: Number(values.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday), year: Number(values.year)
  };
}

function localSlot(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function mapDefinition(row: Row): AutomationDefinition {
  return {
    active_trigger_version: number(row.active_trigger_version), created_at: text(row.created_at), id: text(row.id) as AutomationID,
    idempotency_namespace: text(row.idempotency_namespace), mode: text(row.mode) as AutomationDefinition["mode"], name: text(row.name),
    next_run_at: optionalText(row.next_run_at), owner: text(row.scope_kind) === "project"
      ? { kind: "project", project_id: text(row.scope_id) } : { kind: "control_plane", control_plane_id: "local" },
    permission_policy_ref: text(row.permission_policy_ref), revision: number(row.revision), status: text(row.status) as AutomationDefinition["status"],
    updated_at: text(row.updated_at), workflow_ref: text(row.workflow_ref)
  };
}

function mapTrigger(row: Row, id: AutomationID, version: number): VersionedAutomationTrigger {
  const type = text(row.trigger_type);
  return { automation_id: id, created_at: "", created_by: "", version, type, config: JSON.parse(text(row.config_json)) } as VersionedAutomationTrigger;
}

function mapClaimedRun(row: Row): ClaimedAutomationRun {
  return {
    automation_id: text(row.automation_id) as AutomationID, attempt_count: number(row.attempt_count), completed_at: optionalText(row.completed_at),
    created_at: text(row.created_at), idempotency_key: text(row.idempotency_key), lease_expires_at: text(row.lease_expires_at),
    lease_token: text(row.lease_token), max_attempts: number(row.max_attempts) || MAX_ATTEMPTS, next_attempt_at: text(row.next_attempt_at),
    requested_at: text(row.requested_at), run_id: text(row.run_id), scheduled_for: text(row.scheduled_for) || text(row.requested_at),
    status: text(row.status) as AutomationRun["status"], summary: jsonObject(row.summary_json), trigger_version: number(row.trigger_version)
  };
}

function retryAtFor(run: ClaimedAutomationRun, now: Date): string {
  const seconds = Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(0, run.attempt_count - 1), RETRY_MAX_SECONDS);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function changes(db: RunnerDatabase): number { return Number((db.sqlite.query("select changes() as count").get() as { count: number }).count); }
function safeLimit(value: number): number { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : DEFAULT_LIMIT; }
function cleanDetail(value: string): string { return value.trim().slice(0, 1000) || "automation run failed"; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function optionalText(value: unknown): string | null { const result = text(value); return result || null; }
function number(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function jsonObject(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(text(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
