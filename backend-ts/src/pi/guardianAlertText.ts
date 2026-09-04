import type { PiGuardianAlert } from "../db/repositories/pi.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";
import { guardianAlertPresentation, type GuardianAlertPresentation } from "./guardianAlertPresentation.ts";
import type { NotificationPresentation } from "../notifications/notificationPresentation.ts";

export function formatGuardianAlertText(
  alert: PiGuardianAlert,
  now = new Date(),
  presentation: GuardianAlertPresentation = guardianAlertPresentation(alert, now),
  voice?: Pick<NotificationPresentation, "display_name" | "language">
): string {
  const speaker = voice?.display_name || SUPERVISOR_NOTIFICATION_PREFIX;
  if (voice?.language === "en-US") {
    return [
      `${speaker}: ${oneLine(presentation.title)}`,
      `What happened: ${oneLine(presentation.description)}`,
      `Affected area: ${oneLine(presentation.location)}`,
      `What I did: ${oneLine(presentation.pi_action)}`,
      `What you need to do: ${oneLine(presentation.user_action)}`,
      `Current state: ${oneLine(presentation.state_label)}`,
      `Technical reference: ${field(alert.alert_type)} · ${field(alert.id)}`
    ].join("\n");
  }
  return [
    `${speaker}：${oneLine(presentation.title)}`,
    `发生了什么：${oneLine(presentation.description)}`,
    `影响位置：${oneLine(presentation.location)}`,
    `PI 处理：${oneLine(presentation.pi_action)}`,
    `需要你处理：${oneLine(presentation.user_action)}`,
    `当前状态：${oneLine(presentation.state_label)}`,
    `首次发现：${beijingTime(presentation.first_seen_at)}`,
    `最近确认：${beijingTime(presentation.last_seen_at)}`,
    `技术信息：${field(alert.alert_type)} · ${field(alert.id)}`
  ].join("\n");
}

function field(value: string): string {
  const text = oneLine(value);
  return text === "" ? "-" : text;
}

function oneLine(value: string): string {
  return redactAuditText(value).replace(/\s+/g, " ").trim();
}

function beijingTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return field(value);
  return `${new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ")}（北京时间）`;
}
