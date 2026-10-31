import type { RunnerDatabase } from "../../db/database.ts";
import { upsertPiGuardianWatchdogStatus } from "../../db/repositories/pi.ts";
import { redactAuditText } from "../../db/repositories/pi/auditRedaction.ts";
import { type PiGuardianWatchdogComponent, CountRow, type PiGuardianWatchdogCheck, type PiGuardianWatchdogContext, DigestGroupRow, DEFAULT_LIMIT } from "./guardianWatchdog.ts";

export function countAlerts(input: {
  alertType: string; component: PiGuardianWatchdogComponent; message: string; rows: CountRow[];
}): PiGuardianWatchdogCheck[] {
  if (input.rows.length === 0) return [ok(input.component)];
  return input.rows.map((row) => alert(input.component, input.alertType, {
    evidence: row,
    message: `${input.message}: ${row.count} stale item(s)`,
    project_id: row.project_id
  }));
}

export function writeStatus(input: {
  checks: PiGuardianWatchdogCheck[]; context: PiGuardianWatchdogContext;
  db: RunnerDatabase; errors: string[];
}): void {
  upsertPiGuardianWatchdogStatus(input.db, {
    checked_components_json: input.checks,
    last_error: input.errors.join("\n"),
    last_seen_at: input.context.nowText,
    last_success_at: input.errors.length === 0
      ? input.context.nowText
      : input.context.previousLastSuccessAt
  });
}

export function digestOverdue(row: DigestGroupRow, now: Date, graceMs: number): boolean {
  const deadline = Date.parse(row.deadline_at);
  const lastDigest = Date.parse(row.last_digest_at);
  if (Number.isFinite(deadline) && deadline + graceMs <= now.getTime()) {
    return !Number.isFinite(lastDigest) || lastDigest < deadline;
  }
  if (!Number.isFinite(row.max_interval_minutes) || row.max_interval_minutes <= 0) return false;
  const anchor = Date.parse(row.last_digest_at || row.created_at);
  return Number.isFinite(anchor) && anchor + row.max_interval_minutes * 60_000 + graceMs <= now.getTime();
}

export function alert(component: PiGuardianWatchdogComponent, alertType: string, input: {
  evidence?: unknown; message: string; project_id?: string; run_group_id?: string;
}): PiGuardianWatchdogCheck {
  return { ...input, alert_type: alertType, component, ok: false, severity: "urgent" };
}

export function ok(component: PiGuardianWatchdogComponent): PiGuardianWatchdogCheck { return { component, ok: true }; }

export function asArray(value: PiGuardianWatchdogCheck | PiGuardianWatchdogCheck[]): PiGuardianWatchdogCheck[] {
  return Array.isArray(value) ? value : [value];
}

export function safeError(error: unknown): string { return redactAuditText(error instanceof Error ? error.message : String(error)); }

export function positiveLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 100) : DEFAULT_LIMIT;
}

export function positiveMs(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback; }
