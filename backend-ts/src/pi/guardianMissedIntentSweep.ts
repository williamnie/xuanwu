import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiNotificationIntent,
  getPiRunGroup,
  listPiGuardianAlerts,
  listPiNotificationIntents,
  updatePiNotificationIntent,
  upsertPiGuardianAlert,
  type PiGuardianAlert,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type {
  PiGuardianWatchdogComponent,
  PiGuardianWatchdogSummary
} from "./guardianWatchdog.ts";
import {
  missedAlertEvidence,
  missedDigestPayload,
  missedDigestScope,
  missedDigestSummary,
  missedFlushBucket,
  type GuardianMissedOutageWindow
} from "./guardianMissedIntentDigest.ts";

export type GuardianMissedIntentSweepInput = {
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

type DigestTarget = {
  conversation_id: string; target_chat_id: string; target_message_id: string;
  target_thread_id: string;
};
type MissedDigestInput = {
  alerts: PiGuardianAlert[]; intents: PiNotificationIntent[]; window: GuardianMissedOutageWindow;
};
type SweepContext = { db: RunnerDatabase; nowText: string; result: GuardianMissedIntentSweepResult };

const DEFAULT_LIMIT = 50;
const DIGEST_CHANNEL = "feishu";
const OUTAGE_ALERT_COMPONENTS: Record<string, PiGuardianWatchdogComponent> = {
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
    writeMissedDigest({ db, nowText, result }, { alerts: openAlerts, intents, window });
  }
  return result;
}

function writeMissedDigest(context: SweepContext, input: MissedDigestInput): void {
  const { db, nowText, result } = context;
  const { alerts, intents, window } = input;
  const digestScope = missedDigestScope(window);
  const flushBucket = missedFlushBucket(window);
  const existing = hasRecoveryDigest(db, digestScope, flushBucket);
  const target = digestTarget(db, input);
  try {
    createPiNotificationIntent(db, {
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
      target_channel: DIGEST_CHANNEL
    });
    if (!existing) result.summaries += 1;
    if (targetMissing(target)) {
      const alert = markMissedDigestPending(db, window, "missing_digest_target");
      result.pendingAlertIds.push(alert.id);
      result.pending += 1;
    } else {
      markMissedIntentsCovered(db, intents);
    }
  } catch (error) {
    result.errors += 1;
    const alert = markMissedDigestPending(db, window, safeError(error));
    result.pendingAlertIds.push(alert.id);
    result.pending += 1;
  }
}

function markMissedIntentsCovered(db: RunnerDatabase, intents: PiNotificationIntent[]): void {
  for (const intent of intents) {
    if (["aggregated", "sent", "suppressed", "cancelled"].includes(intent.state)) continue;
    updatePiNotificationIntent(db, intent.id, { state: "aggregated" });
  }
}

function recoveredOutageAlerts(
  db: RunnerDatabase,
  watchdog: PiGuardianWatchdogSummary | undefined
): PiGuardianAlert[] {
  const recovered = recoveredComponents(watchdog);
  return [
    ...listPiGuardianAlerts(db, { status: "open" }),
    ...listPiGuardianAlerts(db, { status: "acked" })
  ]
    .filter((alert) => outageComponent(alert) !== undefined)
    .filter((alert) => recovered.size === 0 || recovered.has(outageComponent(alert)!));
}

function recoveredComponents(watchdog: PiGuardianWatchdogSummary | undefined): Set<PiGuardianWatchdogComponent> {
  if (!watchdog) return new Set();
  return new Set(watchdog.checks.filter((check) => check.ok).map((check) => check.component));
}

function digestPipelineAvailable(watchdog: PiGuardianWatchdogSummary | undefined): boolean {
  if (!watchdog) return true;
  return !watchdog.checks.some((check) => !check.ok && ["coordinator", "digest", "outbox"].includes(check.component));
}

function outageWindows(alerts: PiGuardianAlert[], nowText: string, limit: unknown): GuardianMissedOutageWindow[] {
  const groups = new Map<string, PiGuardianAlert[]>();
  for (const alert of alerts) groups.set(alert.project_id, [...(groups.get(alert.project_id) ?? []), alert]);
  return [...groups.entries()].slice(0, boundedLimit(limit)).map(([projectID, rows]) => ({
    alertIDs: rows.map((alert) => alert.id).sort(),
    alertTypes: unique(rows.map((alert) => alert.alert_type)),
    components: unique(rows.map((alert) => outageComponent(alert) ?? "")),
    endAt: nowText,
    keyEndAt: latestText(rows.map((alert) => alert.watchdog_seen_at)) || nowText,
    projectID,
    startAt: earliestText(rows.flatMap((alert) => [alert.created_at, evidenceOldestAt(alert)])) || nowText
  }));
}

function missedIntents(
  db: RunnerDatabase,
  window: GuardianMissedOutageWindow,
  limit: unknown
): PiNotificationIntent[] {
  return listPiNotificationIntents(db, { projectId: window.projectID })
    .filter((intent) => isMissedIntent(intent, window))
    .slice(0, boundedLimit(limit));
}

function isMissedIntent(intent: PiNotificationIntent, window: GuardianMissedOutageWindow): boolean {
  if (intent.kind === "digest") return false;
  if (!inWindow(intent.created_at, window) && !inWindow(intent.updated_at, window)) return false;
  if (["sent", "suppressed", "cancelled"].includes(intent.state)) return false;
  if (intent.error !== "") return true;
  if (["pending", "ready", "failed"].includes(intent.state)) return true;
  return intent.flush_after_at !== "" && Date.parse(intent.flush_after_at) <= Date.parse(window.endAt);
}

function markMissedDigestPending(
  db: RunnerDatabase,
  window: GuardianMissedOutageWindow,
  reason: string
): PiGuardianAlert {
  return upsertPiGuardianAlert(db, {
    alert_type: "missed_digest_pending",
    evidence_json: { ...missedAlertEvidence(window), reason: redactSensitiveText(reason) },
    message: `missed digest pending for project ${window.projectID || "-"}: ${reason}`,
    project_id: window.projectID,
    run_group_id: missedDigestScope(window),
    severity: "watch",
    watchdog_seen_at: window.endAt
  });
}

function digestTarget(
  db: RunnerDatabase,
  input: MissedDigestInput
): DigestTarget {
  const intent = input.intents.find(hasTargetFields);
  const groupConversation = input.alerts.map((alert) => getPiRunGroup(db, alert.run_group_id)?.origin_conversation_id ?? "")
    .find((conversationID) => conversationID !== "") ?? "";
  return {
    conversation_id: intent?.conversation_id || groupConversation,
    target_chat_id: intent?.target_chat_id ?? "",
    target_message_id: intent?.target_message_id ?? "",
    target_thread_id: intent?.target_thread_id ?? ""
  };
}

function hasTargetFields(intent: PiNotificationIntent): boolean {
  return intent.conversation_id !== "" || intent.target_chat_id !== "" ||
    intent.target_message_id !== "" || intent.target_thread_id !== "";
}

function hasRecoveryDigest(db: RunnerDatabase, runGroupID: string, flushBucket: string): boolean {
  return listPiNotificationIntents(db, { kind: "digest", runGroupId: runGroupID })
    .some((intent) => intent.flush_reason === "recovery" && intent.flush_bucket === flushBucket);
}

function targetMissing(target: DigestTarget): boolean {
  return target.conversation_id === "" && target.target_chat_id === "" &&
    target.target_message_id === "" && target.target_thread_id === "";
}

function windowAlerts(alerts: PiGuardianAlert[], window: GuardianMissedOutageWindow): PiGuardianAlert[] {
  return alerts.filter((alert) => alert.project_id === window.projectID && window.alertIDs.includes(alert.id));
}

function outageComponent(alert: PiGuardianAlert): PiGuardianWatchdogComponent | undefined {
  return OUTAGE_ALERT_COMPONENTS[alert.alert_type];
}

function evidenceOldestAt(alert: PiGuardianAlert): string {
  const evidence = parseRecord(alert.evidence_json);
  return text(evidence.oldest_created_at) || text(evidence.created_at) || text(evidence.deadline_at);
}

function inWindow(value: string, window: GuardianMissedOutageWindow): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(window.startAt) && time <= Date.parse(window.endAt);
}

function earliestText(values: string[]): string {
  return values.filter(validDate).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? "";
}

function latestText(values: string[]): string {
  return values.filter(validDate).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "";
}

function validDate(value: string): boolean {
  return value !== "" && Number.isFinite(Date.parse(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 200) : DEFAULT_LIMIT;
}

function iso(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function emptyResult(): GuardianMissedIntentSweepResult {
  return {
    errors: 0,
    missedIntents: 0,
    openAlerts: 0,
    pending: 0,
    pendingAlertIds: [],
    scannedAlerts: 0,
    skipped: 0,
    summaries: 0,
    windows: 0
  };
}
