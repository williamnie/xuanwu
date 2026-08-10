import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { getPiGuardianAlert, type PiGuardianAlert } from "../db/repositories/pi.ts";
import type { GuardianAlertDelivery } from "./guardianAlertDelivery.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";

export async function sendMissedDigestPendingFallback(
  db: RunnerDatabase,
  alertIds: string[],
  delivery: GuardianAlertDelivery | undefined
): Promise<void> {
  if (!delivery) return;
  for (const id of unique(alertIds)) {
    const alert = getPiGuardianAlert(db, id);
    if (!isMissedDigestPending(alert)) continue;
    await delivery.send(alert, { formatText: missedDigestText });
  }
}

function missedDigestText(alert: PiGuardianAlert): string {
  return [
    `【${SUPERVISOR_NOTIFICATION_PREFIX} · Guardian】通知摘要待处理`,
    `项目：${field(alert.project_id)}`,
    `级别：${severityLabel(alert.severity)}`,
    `时间：${field(alert.watchdog_seen_at)}`,
    "说明：摘要发送暂不可用或缺少可用目标，可能有通知未被汇总送达。",
    "请查看 Guardian 横幅和 Supervisor 恢复摘要；摘要管道恢复前，不会强行发送摘要。"
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
