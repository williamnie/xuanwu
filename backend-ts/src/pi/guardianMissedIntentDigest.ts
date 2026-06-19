import { createHash } from "node:crypto";
import type { PiGuardianAlert, PiNotificationIntent } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";

type MissedDigestIssue = { bucket: string; issue_id: number; reason: string; status: string; title: string };

export type GuardianMissedOutageWindow = {
  alertIDs: string[]; alertTypes: string[]; components: string[]; endAt: string;
  keyEndAt: string; projectID: string; startAt: string;
};

export function missedDigestPayload(
  window: GuardianMissedOutageWindow,
  intents: PiNotificationIntent[],
  alerts: PiGuardianAlert[]
): Record<string, unknown> {
  const failed = intents.filter((intent) => intent.state === "failed" || intent.error !== "").length;
  return {
    active_count: Math.max(intents.length - failed, 0),
    alerts: alerts.map(alertPayload),
    completed_count: 0,
    failed_count: failed,
    issues: intents.map(intentIssuePayload).filter(hasIssueID),
    needs_user_count: alerts.filter((alert) => alert.severity === "urgent").length,
    outage_window: { ended_at: window.endAt, started_at: window.startAt },
    run_group_id: missedDigestScope(window),
    skipped_count: 0,
    total_count: intents.length + alerts.length,
    verification_count: 0
  };
}

export function missedDigestSummary(
  window: GuardianMissedOutageWindow,
  intents: PiNotificationIntent[],
  alerts: PiGuardianAlert[]
): string {
  return `missed notifications recovered for project ${window.projectID || "-"}: ` +
    `${intents.length} intent(s), ${alerts.length} alert(s)`;
}

export function missedDigestScope(window: GuardianMissedOutageWindow): string {
  return `missed-${safeKey(window.projectID || "global")}-${shortHash(window.alertIDs.join(","))}`;
}

export function missedFlushBucket(window: GuardianMissedOutageWindow): string {
  return `${window.startAt}..${window.keyEndAt}:${shortHash(window.alertTypes.join(","))}`;
}

export function missedAlertEvidence(window: GuardianMissedOutageWindow): Record<string, unknown> {
  return {
    alert_ids: window.alertIDs,
    alert_types: window.alertTypes,
    components: window.components,
    outage_window: { ended_at: window.endAt, started_at: window.startAt }
  };
}

function intentIssuePayload(intent: PiNotificationIntent): MissedDigestIssue {
  return {
    bucket: intent.requires_user ? "needs_user" : intent.state === "failed" || intent.error ? "failed" : "active",
    issue_id: intent.issue_id,
    reason: redactSensitiveText(intent.error || intent.summary),
    status: `${intent.kind}:${intent.state}`,
    title: ""
  };
}

function hasIssueID(item: MissedDigestIssue): boolean {
  return item.issue_id > 0;
}

function alertPayload(alert: PiGuardianAlert): Record<string, number | string> {
  return {
    alert_type: alert.alert_type,
    issue_id: alert.issue_id,
    message: redactSensitiveText(alert.message),
    severity: alert.severity,
    status: alert.status
  };
}

function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "global";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
