import type { RunnerDatabase } from "../db/database.ts";
import { listPiGuardianAlerts, resolvePiGuardianAlert, upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import { WATCHDOG_ALERT_PREFIX, RUNTIME_MISMATCH_ALERT_PREFIX } from "./issueWatchdog.model.ts";
import type { StaleTodoRow, WatchdogState } from "./issueWatchdog.model.ts";

export function ensureWatchdogAttention(
  db: RunnerDatabase,
  row: StaleTodoRow,
  state: WatchdogState,
  now: Date
): boolean {
  const alertType = `${WATCHDOG_ALERT_PREFIX}${state.reason}`;
  const groupKey = attentionGroupKey(db, row.id, state.stateKey);
  const existing = listPiGuardianAlerts(db, { projectId: row.project_id, status: "open" })
    .some((alert) => alert.issue_id === row.id && alert.alert_type === alertType && alert.run_group_id === groupKey);
  if (existing) return false;
  upsertPiGuardianAlert(db, {
    alert_type: alertType,
    evidence_json: [`issue:${row.id}`, `watchdog_state:${state.stateKey}`],
    issue_id: row.id,
    message: watchdogAttentionMessage(row, state),
    project_id: row.project_id,
    run_group_id: groupKey,
    severity: "medium",
    watchdog_seen_at: now.toISOString()
  });
  return true;
}

export function attentionGroupKey(db: RunnerDatabase, issueID: number, stateKey: string): string {
  const row = db.sqlite.query<{ id: number }, [number, string]>(`
    select id from issue_events
    where issue_id=? and type in ('issue.watchdog_kicked', 'issue.watchdog_waiting')
      and json_valid(payload) and json_extract(payload, '$.state_key')=?
    order by id desc limit 1
  `).get(issueID, stateKey);
  return `${stateKey}:event:${row?.id ?? 0}`;
}

export function resolveChangedWatchdogAlerts(
  db: RunnerDatabase,
  row: StaleTodoRow,
  activeStateKey: string,
  now: Date
): void {
  for (const status of ["open", "acked"] as const) {
    for (const alert of listPiGuardianAlerts(db, { projectId: row.project_id, status })) {
      if (alert.issue_id !== row.id || !alert.alert_type.startsWith(WATCHDOG_ALERT_PREFIX) ||
        alert.run_group_id === activeStateKey) continue;
      resolvePiGuardianAlert(db, alert.id, {
        evidence_json: alert.evidence_json,
        message: `issue #${row.id} watchdog condition recovered`,
        watchdog_seen_at: now.toISOString()
      });
    }
  }
}

export function resolveInactiveWatchdogAlerts(db: RunnerDatabase, cutoff: string, now: Date): void {
  for (const status of ["open", "acked"] as const) {
    for (const alert of listPiGuardianAlerts(db, { status })) {
      if (!alert.alert_type.startsWith(WATCHDOG_ALERT_PREFIX) || alert.issue_id <= 0) continue;
      if (issueStillWatchdogCandidate(db, alert.issue_id, cutoff)) continue;
      resolvePiGuardianAlert(db, alert.id, {
        evidence_json: alert.evidence_json,
        message: `issue #${alert.issue_id} watchdog condition recovered`,
        watchdog_seen_at: now.toISOString()
      });
    }
  }
}

export function resolveInactiveRuntimeMismatchAlerts(db: RunnerDatabase, now: Date): void {
  for (const status of ["open", "acked"] as const) {
    for (const alert of listPiGuardianAlerts(db, { status })) {
      if (!alert.alert_type.startsWith(RUNTIME_MISMATCH_ALERT_PREFIX) || alert.issue_id <= 0) continue;
      if (runtimeMismatchStillActive(db, alert.issue_id)) continue;
      resolvePiGuardianAlert(db, alert.id, {
        evidence_json: alert.evidence_json,
        message: `issue #${alert.issue_id} runtime mismatch recovered`,
        watchdog_seen_at: now.toISOString()
      });
    }
  }
}

export function runtimeMismatchStillActive(db: RunnerDatabase, issueID: number): boolean {
  return db.sqlite.query<{ active: number }, [number]>(`
    select exists(
      select 1 from issues i
      join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
      join agent_sessions session on session.issue_id=i.id
        and session.provider_session_id=coalesce(nullif(ir.provider_session_id, ''), session.provider_session_id)
      where i.id=? and i.status='in_progress'
        and lower(replace(replace(replace(session.status, '_', ''), '-', ''), ' ', ''))
          in ('aborted','cancelled','completed','done','error','failed','stopped')
    ) as active
  `).get(issueID)?.active === 1;
}

export function issueStillWatchdogCandidate(db: RunnerDatabase, issueID: number, cutoff: string): boolean {
  return (db.sqlite.query<{ active: number }, [number, string]>(`
    select exists(
      select 1 from issues i join projects p on p.id=i.project_id
      where i.id=? and p.auto_run=1 and i.status='todo'
        and coalesce(nullif(i.updated_at, ''), i.created_at)<=?
        and not exists (select 1 from issue_runs ir where ir.issue_id=i.id and ir.ended_at='')
        and not exists (
          select 1 from agent_sessions s where s.issue_id=i.id
            and lower(replace(replace(replace(s.status, '_', ''), '-', ''), ' ', ''))
              in ('active', 'busy', 'inprogress', 'running')
        )
    ) as active
  `).get(issueID, cutoff)?.active ?? 0) === 1;
}

export function watchdogAttentionMessage(row: StaleTodoRow, state: WatchdogState): string {
  const next = state.nextCheckAt ? ` next_check_at=${state.nextCheckAt}` : "";
  return `issue #${row.id} watchdog wait: ${state.reason}; root_blocker=${JSON.stringify(state.rootBlocker)}.${next}`;
}
