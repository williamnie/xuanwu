import type { RunnerDatabase } from "../../db/database.ts";
import { getPiGuardianWatchdogStatus } from "../../db/repositories/pi.ts";
import type { GuardianAlertDelivery } from "./guardianAlertDelivery.ts";
import { suppressUnroutableLifecycleIntents } from "./guardianWatchdogMaintenance.ts";
import { writeGuardianWatchdogAlerts, type WatchdogAlertWriteResult } from "./guardianWatchdogAlerts.ts";
import { expirePendingPiActionApprovals } from "../mcp/mcpApprovalExpiry.ts";
import { isoSeconds } from "../../util/values.ts";
import { piRuntimeChecks, coordinatorChecks, outboxChecks, digestChecks, approvalChecks, schedulerChecks, inboxChecks } from "./guardianWatchdogChecks.ts";
import { ok, writeStatus, asArray, safeError, positiveMs, positiveLimit } from "./guardianWatchdogStatus.ts";

export type PiGuardianWatchdogComponent =
  "approval" | "coordinator" | "digest" | "inbox" | "outbox" | "pi_runtime" | "scheduler";

export type PiGuardianWatchdogCheck = {
  alert_type?: string; component: PiGuardianWatchdogComponent; evidence?: unknown;
  issue_id?: number; message?: string; ok: boolean; project_id?: string;
  run_group_id?: string; severity?: string;
};

export type PiGuardianWatchdogProbe = {
  component: PiGuardianWatchdogComponent;
  run(context: PiGuardianWatchdogContext): PiGuardianWatchdogCheck | PiGuardianWatchdogCheck[];
};

export type PiGuardianWatchdogContext = {
  cutoffText: string; db: RunnerDatabase; limit: number; now: Date; nowText: string;
  previousLastSeenAt: string; previousLastSuccessAt: string;
  schedulerStaleAfterMs: number; staleAfterMs: number;
};

export type PiGuardianWatchdogInput = {
  checks?: PiGuardianWatchdogProbe[]; limit?: number; now?: Date | string;
  delivery?: GuardianAlertDelivery;
  schedulerStaleAfterMs?: number; staleAfterMs?: number;
  timingObserver?: (timing: PiGuardianWatchdogStageTiming) => void;
};

export type PiGuardianWatchdogStageTiming = {
  duration_ms: number;
  result?: Record<string, number>;
  stage: string;
  started_at: string;
  status: "failed" | "succeeded";
};

export type PiGuardianWatchdogSummary = {
  alerts: number; checks: PiGuardianWatchdogCheck[]; errors: number; scanned: number;
};

export type CountRow = { count: number; oldest_created_at: string; project_id: string };

export type DigestGroupRow = {
  created_at: string; deadline_at: string; id: string; last_digest_at: string;
  max_interval_minutes: number; project_id: string; status: string;
};

export type PiRuntimeRow = CountRow & { reason: string };

export const DEFAULT_LIMIT = 20;

export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export const DEFAULT_SCHEDULER_STALE_AFTER_MS = 120_000;

export const SLOW_WATCHDOG_STAGE_MS = 100;

export const DEFAULT_CHECKS: PiGuardianWatchdogProbe[] = [
  { component: "pi_runtime", run: piRuntimeChecks },
  { component: "coordinator", run: coordinatorChecks },
  { component: "outbox", run: outboxChecks },
  { component: "digest", run: digestChecks },
  { component: "approval", run: approvalChecks },
  { component: "scheduler", run: schedulerChecks },
  { component: "inbox", run: inboxChecks }
];

export async function runPiGuardianWatchdogOnce(
  db: RunnerDatabase,
  input: PiGuardianWatchdogInput = {}
): Promise<PiGuardianWatchdogSummary> {
  const context = watchdogContext(db, input);
  const probes = input.checks ?? DEFAULT_CHECKS;
  const summary: PiGuardianWatchdogSummary = { alerts: 0, checks: [], errors: 0, scanned: 0 };
  const errors: string[] = [];
  await timedWatchdogStage("approval_expiry", () => expirePendingPiActionApprovals(db, context.now), input);
  await timedWatchdogStage("suppress_unroutable_intents", () => suppressUnroutableLifecycleIntents(db), input);
  for (const probe of probes) {
    summary.scanned += 1;
    const result = await timedWatchdogStage(
      `probe:${probe.component}`,
      () => runProbe(db, probe, context, input.delivery),
      input
    );
    summary.checks.push(...result.checks);
    summary.alerts += result.alerts;
    if (result.error !== "") {
      summary.errors += 1;
      errors.push(result.error);
    }
  }
  await timedWatchdogStage("write_status", () => writeStatus({ checks: summary.checks, context, db, errors }), input);
  return summary;
}

export async function timedWatchdogStage<T>(
  stage: string,
  operation: () => T | Promise<T>,
  input: PiGuardianWatchdogInput
): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let result: T | undefined;
  let status: PiGuardianWatchdogStageTiming["status"] = "succeeded";
  try {
    result = await operation();
    return result;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    const durationMs = performance.now() - started;
    const summary = numericSummary(result);
    const timing: PiGuardianWatchdogStageTiming = {
      duration_ms: durationMs,
      ...(summary ? { result: summary } : {}),
      stage,
      started_at: startedAt,
      status
    };
    input.timingObserver?.(timing);
    if (durationMs >= SLOW_WATCHDOG_STAGE_MS) {
      console.warn(JSON.stringify({
        event: "runner.guardian_watchdog_stage_slow",
        ...timing,
        duration_ms: Math.round(durationMs)
      }));
    }
  }
}

export function numericSummary(value: unknown): Record<string, number> | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return { value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
    .slice(0, 12)) as Record<string, number>;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export async function runProbe(
  db: RunnerDatabase,
  probe: PiGuardianWatchdogProbe,
  context: PiGuardianWatchdogContext,
  delivery: GuardianAlertDelivery | undefined
): Promise<WatchdogAlertWriteResult & { checks: PiGuardianWatchdogCheck[] }> {
  try {
    const checks = asArray(probe.run(context));
    const writer = await writeGuardianWatchdogAlerts(db, checks, context, delivery);
    return { checks, ...writer };
  } catch (error) {
    const message = safeError(error);
    return {
      alerts: 0,
      checks: [{ component: probe.component, evidence: { error: message }, ok: false }],
      error: `${probe.component}: ${message}`
    };
  }
}

export function watchdogContext(db: RunnerDatabase, input: PiGuardianWatchdogInput): PiGuardianWatchdogContext {
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const staleAfterMs = positiveMs(input.staleAfterMs, DEFAULT_STALE_AFTER_MS);
  const previousStatus = getPiGuardianWatchdogStatus(db);
  return {
    cutoffText: isoSeconds(new Date(now.getTime() - staleAfterMs)),
    db,
    limit: positiveLimit(input.limit),
    now,
    nowText: isoSeconds(now),
    previousLastSeenAt: previousStatus?.last_seen_at ?? "",
    previousLastSuccessAt: previousStatus?.last_success_at ?? "",
    schedulerStaleAfterMs: positiveMs(input.schedulerStaleAfterMs, DEFAULT_SCHEDULER_STALE_AFTER_MS),
    staleAfterMs
  };
}
