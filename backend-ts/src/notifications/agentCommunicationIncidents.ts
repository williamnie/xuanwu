import type { RunnerDatabase } from "../db/database.ts";
import { resolvePiGuardianAlert, upsertPiGuardianAlert } from "../db/repositories/pi.ts";

const ALERT_TYPE = "notification_agent_failure";

// 复用持久化故障生命周期；发送幂等键绑定事件 ID，重启和跨时间窗口不会重复提醒。
export function agentCommunicationIncident(
  db: RunnerDatabase,
  input: { identity: string; projectID: string; failureCode: string; now: Date }
) {
  return upsertPiGuardianAlert(db, {
    alert_type: ALERT_TYPE,
    evidence_json: { failure_code: input.failureCode },
    message: input.failureCode,
    project_id: input.projectID,
    run_group_id: `notification-agent:${input.identity}`,
    severity: "watch",
    ui_visible: 0,
    watchdog_seen_at: input.now.toISOString()
  });
}

export function resolveAgentCommunicationIncident(db: RunnerDatabase, identity: string, now: Date): void {
  const rows = db.sqlite.query<{ id: string }, [string, string]>(`
    select id from pi_guardian_alerts where alert_type=? and run_group_id=?
      and status in ('open','acked','suppressed')
  `).all(ALERT_TYPE, `notification-agent:${identity}`);
  for (const row of rows) resolvePiGuardianAlert(db, row.id, {
    message: "notification Agent responded successfully",
    watchdog_seen_at: now.toISOString()
  });
}
