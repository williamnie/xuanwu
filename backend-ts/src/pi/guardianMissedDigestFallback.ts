import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { getPiGuardianAlert, type PiGuardianAlert } from "../db/repositories/pi.ts";
import type { GuardianAlertDelivery } from "./guardianAlertDelivery.ts";
import {
  notificationPresentation,
  type NotificationPresentation
} from "../notifications/notificationPresentation.ts";

export async function sendMissedDigestPendingFallback(
  db: RunnerDatabase,
  alertIds: string[],
  delivery: GuardianAlertDelivery | undefined
): Promise<void> {
  if (!delivery) return;
  for (const id of unique(alertIds)) {
    const alert = getPiGuardianAlert(db, id);
    if (!isMissedDigestPending(alert)) continue;
    const presentation = notificationPresentation(db);
    await delivery.send(alert, { formatText: (current) => missedDigestText(current, presentation) });
  }
}

function missedDigestText(alert: PiGuardianAlert, presentation: NotificationPresentation): string {
  if (presentation.language === "en-US") {
    return [
      `${presentation.display_name}: A notification digest still needs attention.`,
      `Project: ${field(alert.project_id)}; severity: ${field(alert.severity)}; observed: ${field(alert.watchdog_seen_at)}.`,
      "The digest could not be delivered or has no valid target. Check Guardian and the Supervisor recovery summary."
    ].join("\n");
  }
  return [
    `${presentation.display_name}：有一份通知摘要还没送达。`,
    `项目 ${field(alert.project_id)}，级别 ${severityLabel(alert.severity)}，发现时间 ${field(alert.watchdog_seen_at)}。`,
    "摘要发送暂不可用或没有有效目标，请查看 Guardian 横幅和恢复摘要。"
  ].join("\n");
}

function isMissedDigestPending(alert: PiGuardianAlert | null): alert is PiGuardianAlert {
  return alert !== null && alert.alert_type === "missed_digest_pending";
}

function severityLabel(value: string): string {
  return value === "urgent" ? "紧急" : value === "watch" ? "关注" : field(value);
}

function field(value: string): string {
  const text = oneLine(value);
  return text === "" ? "-" : text;
}

function oneLine(value: string): string {
  return redactAuditText(value).replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
