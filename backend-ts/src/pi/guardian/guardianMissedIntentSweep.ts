import type { RunnerDatabase } from "../../db/database.ts";
import { createPiNotificationIntent, listPiGuardianAlerts, updatePiNotificationIntent, type PiGuardianAlert, type PiNotificationIntent } from "../../db/repositories/pi.ts";
import { guardianComponentRecovered } from "./guardianWatchdogMaintenance.ts";
import type { PiGuardianWatchdogComponent, PiGuardianWatchdogSummary } from "./guardianWatchdog.ts";
import { missedDigestPayload, missedDigestScope, missedDigestSummary, missedFlushBucket, type GuardianMissedOutageWindow } from "./guardianMissedIntentDigest.ts";
import { cleanString } from "../../util/values.ts";
import { missedIntents, outageWindows, windowAlerts, markMissedDigestPending, hasRecoveryDigest, digestTarget, targetMissing, resolvePendingDigestAlerts, outageComponent } from "./guardianMissedIntentQueries.ts";
import { iso, emptyResult, safeError } from "./guardianMissedIntentValues.ts";

export type GuardianMissedIntentSweepInput = {
  fallbackConnectorID?: string;
  limit?: number;
  now?: Date | string;
  watchdog?: PiGuardianWatchdogSummary;
};

export type GuardianMissedIntentSweepResult = {
  errors: number;
  missedIntents: number;
  openAlerts: number;
  pending: number;
  pendingAlertIds: string[];
  scannedAlerts: number;
  skipped: number;
  summaries: number;
  windows: number;
};

export type DigestTarget = {
  conversation_id: string; target_chat_id: string; target_message_id: string;
  target_channel: string; target_thread_id: string;
};

export type MissedDigestInput = {
  alerts: PiGuardianAlert[]; intents: PiNotificationIntent[]; window: GuardianMissedOutageWindow;
};

export type SweepContext = { db: RunnerDatabase; nowText: string; result: GuardianMissedIntentSweepResult };

export const DEFAULT_LIMIT = 50;

export const OUTAGE_ALERT_COMPONENTS: Record<string, PiGuardianWatchdogComponent> = {
  approval_fast_path_error: "approval",
  coordinator_stalled: "coordinator",
  digest_flush_stalled: "digest",
  guardian_inbox_stalled: "inbox",
  outbox_stalled: "outbox",
  pi_runtime_down: "pi_runtime",
  scheduler_stalled: "scheduler"
};

export function runGuardianMissedIntentSweepOnce(
  db: RunnerDatabase,
  input: GuardianMissedIntentSweepInput = {}
): GuardianMissedIntentSweepResult {
  const nowText = iso(input.now);
  const result = emptyResult();
  const alerts = recoveredOutageAlerts(db, input.watchdog);
  const digestAvailable = digestPipelineAvailable(input.watchdog);
  result.scannedAlerts = alerts.length;
  for (const window of outageWindows(alerts, nowText, input.limit)) {
    result.windows += 1;
    const intents = missedIntents(db, window, input.limit);
    const openAlerts = windowAlerts(alerts, window);
    result.missedIntents += intents.length;
    result.openAlerts += openAlerts.length;
    if (intents.length === 0 && openAlerts.length === 0) {
      result.skipped += 1;
      continue;
    }
    if (!digestAvailable) {
      const alert = markMissedDigestPending(db, window, "digest_pipeline_unavailable");
      result.pendingAlertIds.push(alert.id);
      result.pending += 1;
      result.skipped += 1;
      continue;
    }
    writeMissedDigest(
      { db, nowText, result },
      { alerts: openAlerts, intents, window },
      cleanString(input.fallbackConnectorID)
    );
  }
  return result;
}

export function writeMissedDigest(context: SweepContext, input: MissedDigestInput, fallbackConnectorID: string): void {
  const { db, nowText, result } = context;
  const { alerts, intents, window } = input;
  const digestScope = missedDigestScope(window);
  const flushBucket = missedFlushBucket(window);
  const existing = hasRecoveryDigest(db, digestScope, flushBucket);
  const target = digestTarget(db, input, fallbackConnectorID);
  try {
    const digest = createPiNotificationIntent(db, {
      ...target,
      flush_bucket: flushBucket,
      flush_reason: "recovery",
      kind: "digest",
      payload_json: missedDigestPayload(window, intents, alerts),
      project_id: window.projectID,
      ready_at: nowText,
      run_group_id: digestScope,
      source_event_type: "guardian.missed_intent_sweep",
      state: "ready",
      summary: missedDigestSummary(window, intents, alerts),
      target_channel: target.target_channel
    });
    if (!targetMissing(target) && targetMissing(digest)) {
      updatePiNotificationIntent(db, digest.id, {
        ...target,
        state: "ready",
        target_channel: target.target_channel
      });
    }
    if (!existing) result.summaries += 1;
    if (targetMissing(target)) {
      const alert = markMissedDigestPending(db, window, "missing_digest_target");
      result.pendingAlertIds.push(alert.id);
      result.pending += 1;
    } else {
      markMissedIntentsCovered(db, intents);
      resolvePendingDigestAlerts(db, window.projectID, nowText);
    }
  } catch (error) {
    result.errors += 1;
    const alert = markMissedDigestPending(db, window, safeError(error));
    result.pendingAlertIds.push(alert.id);
    result.pending += 1;
  }
}

export function markMissedIntentsCovered(db: RunnerDatabase, intents: PiNotificationIntent[]): void {
  for (const intent of intents) {
    if (["aggregated", "sent", "suppressed", "cancelled"].includes(intent.state)) continue;
    updatePiNotificationIntent(db, intent.id, { state: "aggregated" });
  }
}

export function recoveredOutageAlerts(
  db: RunnerDatabase,
  watchdog: PiGuardianWatchdogSummary | undefined
): PiGuardianAlert[] {
  return [
    ...listPiGuardianAlerts(db, { status: "open" }),
    ...listPiGuardianAlerts(db, { status: "acked" })
  ]
    .filter((alert) => outageComponent(alert) !== undefined)
    .filter((alert) => guardianComponentRecovered(watchdog?.checks ?? [], outageComponent(alert)!, alert.project_id))
    .map((alert) => ({ ...alert, status: "resolved" as const, message: `${outageComponent(alert)} recovered` }));
}

export function digestPipelineAvailable(watchdog: PiGuardianWatchdogSummary | undefined): boolean {
  if (!watchdog) return true;
  return !watchdog.checks.some((check) => !check.ok && ["coordinator", "digest", "outbox"].includes(check.component));
}
