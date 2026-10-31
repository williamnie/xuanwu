import type { RunnerDatabase } from "../database.ts";
import { getAutomation, getAutomationTrigger } from "./automations.ts";
import { upsertPiGuardianAlert } from "./pi.ts";
import type { AutomationDefinition, AutomationID, AutomationRun, VersionedAutomationTrigger } from "../../domain/automation/contracts.ts";
import { nextRunAfter } from "./automationSchedulerCron.ts";

export type Row = Record<string, unknown>;

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

export const DEFAULT_LIMIT = 20;

export const LEASE_MS = 5 * 60_000;

export const MAX_ATTEMPTS = 3;

export const MISFIRE_GRACE_MS = 60_000;

const RETRY_BASE_SECONDS = 60;

const RETRY_MAX_SECONDS = 60 * 60;

export function getClaimedRun(db: RunnerDatabase, runID: string, leaseToken: string): ClaimedAutomationRun | null {
  const row = db.sqlite.query<Row, [string, string]>(`select * from automation_runs
    where run_id=? and status='running' and lease_token=?`).get(runID, leaseToken);
  return row ? mapClaimedRun(row) : null;
}

export function appendRunEvent(
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

export function deadLetterAttention(db: RunnerDatabase, run: ClaimedAutomationRun, now: Date, detail: string): void {
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

export function advanceAfterTerminalRun(db: RunnerDatabase, run: ClaimedAutomationRun, now: Date): void {
  const definition = getAutomation(db, run.automation_id);
  const trigger = definition && getAutomationTrigger(db, run.automation_id, run.trigger_version);
  if (!trigger) return;
  db.sqlite.run("update automation_definitions set next_run_at=?, updated_at=? where id=?", [
    nextRunAfter(trigger, new Date(run.scheduled_for)), now.toISOString(), run.automation_id
  ]);
}

export function mapDefinition(row: Row): AutomationDefinition {
  return {
    active_trigger_version: number(row.active_trigger_version), created_at: text(row.created_at), id: text(row.id) as AutomationID,
    idempotency_namespace: text(row.idempotency_namespace), mode: text(row.mode) as AutomationDefinition["mode"], name: text(row.name),
    next_run_at: optionalText(row.next_run_at), owner: text(row.scope_kind) === "project"
      ? { kind: "project", project_id: text(row.scope_id) } : { kind: "control_plane", control_plane_id: "local" },
    permission_policy_ref: text(row.permission_policy_ref), revision: number(row.revision), status: text(row.status) as AutomationDefinition["status"],
    updated_at: text(row.updated_at), workflow_ref: text(row.workflow_ref)
  };
}

export function mapTrigger(row: Row, id: AutomationID, version: number): VersionedAutomationTrigger {
  const type = text(row.trigger_type);
  return { automation_id: id, created_at: "", created_by: "", version, type, config: JSON.parse(text(row.config_json)) } as VersionedAutomationTrigger;
}

export function mapClaimedRun(row: Row): ClaimedAutomationRun {
  return {
    automation_id: text(row.automation_id) as AutomationID, attempt_count: number(row.attempt_count), completed_at: optionalText(row.completed_at),
    created_at: text(row.created_at), idempotency_key: text(row.idempotency_key), lease_expires_at: text(row.lease_expires_at),
    lease_token: text(row.lease_token), max_attempts: number(row.max_attempts) || MAX_ATTEMPTS, next_attempt_at: text(row.next_attempt_at),
    requested_at: text(row.requested_at), run_id: text(row.run_id), scheduled_for: text(row.scheduled_for) || text(row.requested_at),
    status: text(row.status) as AutomationRun["status"], summary: jsonObject(row.summary_json), trigger_version: number(row.trigger_version)
  };
}

export function retryAtFor(run: ClaimedAutomationRun, now: Date): string {
  const seconds = Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(0, run.attempt_count - 1), RETRY_MAX_SECONDS);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function changes(db: RunnerDatabase): number { return Number((db.sqlite.query("select changes() as count").get() as { count: number }).count); }

export function safeLimit(value: number): number { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : DEFAULT_LIMIT; }

export function cleanDetail(value: string): string { return value.trim().slice(0, 1000) || "automation run failed"; }

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function optionalText(value: unknown): string | null { const result = text(value); return result || null; }

function number(value: unknown): number { return typeof value === "number" ? value : Number(value); }

function jsonObject(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(text(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
