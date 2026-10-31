import type { RunnerDatabase } from "../../db/database.ts";
import { findImConversationStateByConversationID } from "../../db/repositories/imConversationState.ts";
import { getPiRunGroup, listPiGuardianAlerts, listPiNotificationIntents, resolvePiGuardianAlert, upsertPiGuardianAlert, type PiGuardianAlert, type PiNotificationIntent } from "../../db/repositories/pi.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { PiGuardianWatchdogComponent } from "./guardianWatchdog.ts";
import { missedAlertEvidence, type GuardianMissedOutageWindow } from "./guardianMissedIntentDigest.ts";
import { cleanString } from "../../util/values.ts";
import { MissedDigestInput, DigestTarget, OUTAGE_ALERT_COMPONENTS } from "./guardianMissedIntentSweep.ts";
import { boundedLimit, unique, latestText, earliestText, evidenceOldestAt, inWindow } from "./guardianMissedIntentValues.ts";

export function outageWindows(alerts: PiGuardianAlert[], nowText: string, limit: unknown): GuardianMissedOutageWindow[] {
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

export function missedIntents(
  db: RunnerDatabase,
  window: GuardianMissedOutageWindow,
  limit: unknown
): PiNotificationIntent[] {
  return listPiNotificationIntents(db, { projectId: window.projectID })
    .filter((intent) => isMissedIntent(intent, window))
    .slice(0, boundedLimit(limit));
}

export function isMissedIntent(intent: PiNotificationIntent, window: GuardianMissedOutageWindow): boolean {
  if (intent.kind === "digest") return false;
  if (!inWindow(intent.created_at, window) && !inWindow(intent.updated_at, window)) return false;
  if (["sent", "suppressed", "cancelled"].includes(intent.state)) return false;
  if (intent.error !== "") return true;
  if (["pending", "ready", "failed"].includes(intent.state)) return true;
  return intent.flush_after_at !== "" && Date.parse(intent.flush_after_at) <= Date.parse(window.endAt);
}

export function markMissedDigestPending(
  db: RunnerDatabase,
  window: GuardianMissedOutageWindow,
  reason: string
): PiGuardianAlert {
  return upsertPiGuardianAlert(db, {
    alert_type: "missed_digest_pending",
    evidence_json: { ...missedAlertEvidence(window), reason: redactSensitiveText(reason) },
    message: `missed digest pending for project ${window.projectID || "-"}: ${reason}`,
    project_id: window.projectID,
    run_group_id: `missed-digest-pending:${window.projectID || "global"}`,
    severity: "watch",
    watchdog_seen_at: window.endAt
  });
}

export function digestTarget(
  db: RunnerDatabase,
  input: MissedDigestInput,
  fallbackConnectorID: string
): DigestTarget {
  const intent = input.intents.find(hasTargetFields);
  const groupConversation = input.alerts.map((alert) => getPiRunGroup(db, alert.run_group_id)?.origin_conversation_id ?? "")
    .find((conversationID) => conversationID !== "") ?? "";
  const fallback = latestDigestTarget(db, input.window.projectID);
  const conversationID = intent?.conversation_id || groupConversation || fallback.conversation_id;
  return {
    conversation_id: conversationID,
    target_chat_id: intent?.target_chat_id || fallback.target_chat_id,
    target_channel: intent?.target_channel || fallback.target_channel ||
      findImConversationStateByConversationID(db, conversationID)?.connector_id || fallbackConnectorID,
    target_message_id: intent?.target_message_id || fallback.target_message_id,
    target_thread_id: intent?.target_thread_id || fallback.target_thread_id
  };
}

export function latestDigestTarget(db: RunnerDatabase, projectID: string): DigestTarget {
  const condition = projectID === "" ? "" : "and project_id=?";
  const args = projectID === "" ? [] : [projectID];
  const row = db.sqlite.query<Record<string, unknown>, string[]>(`
    select conversation_id, target_channel, target_chat_id, target_message_id, target_thread_id
    from pi_notification_intents
    where target_channel<>'' ${condition}
      and (conversation_id<>'' or target_chat_id<>'' or target_message_id<>'' or target_thread_id<>'')
    order by updated_at desc, created_at desc, id desc limit 1
  `).get(...args);
  return {
    conversation_id: cleanString(row?.conversation_id),
    target_chat_id: cleanString(row?.target_chat_id),
    target_channel: cleanString(row?.target_channel),
    target_message_id: cleanString(row?.target_message_id),
    target_thread_id: cleanString(row?.target_thread_id)
  };
}

export function resolvePendingDigestAlerts(db: RunnerDatabase, projectID: string, nowText: string): void {
  for (const status of ["open", "acked"]) {
    for (const alert of listPiGuardianAlerts(db, {
      alertType: "missed_digest_pending",
      projectId: projectID,
      status
    }).filter((item) => item.project_id === projectID)) {
      resolvePiGuardianAlert(db, alert.id, {
        evidence_json: { event: "guardian.missed_digest_target_recovered", resolved_at: nowText },
        message: "missed digest target recovered",
        watchdog_seen_at: nowText
      });
    }
  }
}

export function hasTargetFields(intent: PiNotificationIntent): boolean {
  return intent.conversation_id !== "" || intent.target_chat_id !== "" ||
    intent.target_message_id !== "" || intent.target_thread_id !== "";
}

export function hasRecoveryDigest(db: RunnerDatabase, runGroupID: string, flushBucket: string): boolean {
  return listPiNotificationIntents(db, { kind: "digest", runGroupId: runGroupID })
    .some((intent) => intent.flush_reason === "recovery" && intent.flush_bucket === flushBucket);
}

export function targetMissing(target: DigestTarget): boolean {
  return target.conversation_id === "" && target.target_chat_id === "" &&
    target.target_message_id === "" && target.target_thread_id === "";
}

export function windowAlerts(alerts: PiGuardianAlert[], window: GuardianMissedOutageWindow): PiGuardianAlert[] {
  return alerts.filter((alert) => alert.project_id === window.projectID && window.alertIDs.includes(alert.id));
}

export function outageComponent(alert: PiGuardianAlert): PiGuardianWatchdogComponent | undefined {
  return OUTAGE_ALERT_COMPONENTS[alert.alert_type];
}
