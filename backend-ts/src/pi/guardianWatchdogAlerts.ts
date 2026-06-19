import type { RunnerDatabase } from "../db/database.ts";
import {
  type PiGuardianAlert,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import {
  sendDirectFeishuGuardianAlert,
  type PiGuardianDirectFeishuOptions
} from "../integrations/feishuGuardianAlerts.ts";
import type {
  PiGuardianWatchdogCheck,
  PiGuardianWatchdogContext
} from "./guardianWatchdog.ts";

export type WatchdogAlertWriteResult = { alerts: number; error: string };

export async function writeGuardianWatchdogAlerts(
  db: RunnerDatabase,
  checks: PiGuardianWatchdogCheck[],
  context: PiGuardianWatchdogContext,
  options: PiGuardianDirectFeishuOptions | undefined
): Promise<WatchdogAlertWriteResult> {
  const alerts = writeAlerts(db, checks, context.nowText);
  try {
    await sendDirectFeishuAlerts(db, alerts, options, context.now);
    return { alerts: alerts.length, error: "" };
  } catch (error) {
    return { alerts: alerts.length, error: `direct_feishu: ${safeError(error)}` };
  }
}

function writeAlerts(
  db: RunnerDatabase,
  checks: PiGuardianWatchdogCheck[],
  seenAt: string
): PiGuardianAlert[] {
  const alerts: PiGuardianAlert[] = [];
  for (const check of checks) {
    if (check.ok || !check.alert_type) continue;
    alerts.push(upsertPiGuardianAlert(db, {
      alert_type: check.alert_type,
      evidence_json: check.evidence ?? {},
      issue_id: check.issue_id,
      message: check.message || `${check.component} unhealthy`,
      project_id: check.project_id,
      run_group_id: check.run_group_id,
      severity: check.severity || "urgent",
      watchdog_seen_at: seenAt
    }));
  }
  return alerts;
}

async function sendDirectFeishuAlerts(
  db: RunnerDatabase,
  alerts: PiGuardianAlert[],
  options: PiGuardianDirectFeishuOptions | undefined,
  now: Date
): Promise<void> {
  if (!options) return;
  for (const alert of alerts) {
    await sendDirectFeishuGuardianAlert(db, alert, { ...options, now: options.now ?? now });
  }
}

function safeError(error: unknown): string {
  return redactAuditText(error instanceof Error ? error.message : String(error));
}
