import type { RunnerDatabase } from "../db/database.ts";
import {
  listPiGuardianAlerts,
  resolvePiGuardianAlert,
} from "../db/repositories/pi.ts";
import type { PiGuardianWatchdogCheck, PiGuardianWatchdogComponent } from "./guardianWatchdog.ts";

export const ROUTABLE_INTENT_SQL = [
  "target_channel<>''",
  "target_chat_id<>''",
  "target_thread_id<>''",
  "target_message_id<>''",
  "conversation_id<>''",
  "run_group_id<>''",
  "sent_outbox_id>0",
  "error<>''"
].join(" or ");

const ALERT_TYPE_BY_COMPONENT: Partial<Record<PiGuardianWatchdogComponent, string>> = {
  approval: "approval_fast_path_error",
  coordinator: "coordinator_stalled",
  digest: "digest_flush_stalled",
  inbox: "guardian_inbox_stalled",
  outbox: "outbox_stalled",
  pi_runtime: "pi_runtime_down",
  scheduler: "scheduler_stalled"
};

export function resolveRecoveredAlerts(
  db: RunnerDatabase,
  checks: PiGuardianWatchdogCheck[],
  seenAt: string
): void {
  for (const check of checks) {
    if (!check.ok) continue;
    const alertType = ALERT_TYPE_BY_COMPONENT[check.component];
    if (!alertType) continue;
    for (const status of ["open", "acked"] as const) {
      for (const alert of listPiGuardianAlerts(db, { alertType, status })) {
        resolvePiGuardianAlert(db, alert.id, {
          message: `${check.component} recovered`,
          watchdog_seen_at: seenAt
        });
      }
    }
  }
}

export function suppressUnroutableLifecycleIntents(db: RunnerDatabase): void {
  db.sqlite.run(`
    update pi_notification_intents
    set decision='suppress', error='missing_feishu_link', state='suppressed', updated_at=?
    where kind like 'issue_%' and state in ('pending','ready') and decision='send_now'
      and not (${ROUTABLE_INTENT_SQL})
  `, [new Date().toISOString().replace(/\.\d{3}Z$/, "Z")]);
}
