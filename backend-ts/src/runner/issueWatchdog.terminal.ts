import type { RunnerDatabase } from "../db/database.ts";
import { listPiGuardianAlerts, upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";
import { DEFAULT_LIMIT, RUNTIME_MISMATCH_ALERT_PREFIX } from "./issueWatchdog.model.ts";
import type { IssueWatchdogInput, IssueWatchdogSummary, StaleTodoRow } from "./issueWatchdog.model.ts";
import { positiveInteger, boundedLimit } from "./issueWatchdog.values.ts";
import { recordWatchdogEvent } from "./issueWatchdog.events.ts";

export function handleTerminalSessionMismatches(
  input: IssueWatchdogInput,
  summary: IssueWatchdogSummary,
  now: Date,
  cutoff: string
): void {
  const rows = terminalSessionMismatchRows(
    input.database,
    cutoff,
    positiveInteger(input.limit, DEFAULT_LIMIT)
  );
  summary.candidates += rows.length;
  summary.scanned += rows.length;
  for (const row of rows) {
    const stateKey = `runtime-mismatch:${row.id}:${row.updated_at}`;
    const alertType = `${RUNTIME_MISMATCH_ALERT_PREFIX}terminal_session_open_run`;
    const existing = listPiGuardianAlerts(input.database, { projectId: row.project_id, status: "open" })
      .some((alert) => alert.issue_id === row.id && alert.alert_type === alertType && alert.run_group_id === stateKey);
    if (!existing) {
      upsertPiGuardianAlert(input.database, {
        alert_type: alertType,
        evidence_json: [`issue:${row.id}`, "diagnosis:in_progress_session_ended"],
        issue_id: row.id,
        message: `issue #${row.id} 的 Provider Session 已结束，但 Issue/Run 仍为 in_progress。`,
        project_id: row.project_id,
        run_group_id: stateKey,
        severity: "high",
        watchdog_seen_at: now.toISOString()
      });
      recordWatchdogEvent(input.database, row.id, "issue.watchdog_runtime_mismatch", {
        diagnosis: "in_progress_session_ended",
        state_key: stateKey
      }, now);
      summary.attentioned += 1;
    }
    const notification = publishPiNeedsUserNotification({
      actionID: stateKey,
      bus: input.bus,
      database: input.database,
      diagnosis: "in_progress_session_ended",
      issue: {
        id: row.id,
        project_id: row.project_id,
        status: row.status,
        title: row.title
      },
      message: "Provider Session 已结束，但 Runner 没有完成状态对账，自动队列仍被占用。",
      nextStep: "PI 将继续尝试状态修复；若告警持续，请检查最近的 Supervisor 决策和恢复动作。",
      now,
      project: { id: row.project_id, name: row.project_name },
      provider: row.provider
    });
    if (notification) summary.escalated += 1;
  }
}

export function terminalSessionMismatchRows(
  db: RunnerDatabase,
  cutoff: string,
  limit: number
): StaleTodoRow[] {
  return db.sqlite.query<StaleTodoRow, [string]>(`
    select distinct i.id, i.project_id, p.name as project_name, i.title, i.status,
      coalesce(nullif(ir.provider, ''), p.provider) as provider,
      i.created_at, i.updated_at
    from issues i
    join projects p on p.id=i.project_id and p.auto_run=1
    join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    join agent_sessions session on session.issue_id=i.id
      and session.provider=coalesce(nullif(ir.provider, ''), session.provider)
      and session.provider_session_id=coalesce(nullif(ir.provider_session_id, ''), session.provider_session_id)
    where i.status='in_progress'
      and lower(replace(replace(replace(session.status, '_', ''), '-', ''), ' ', ''))
        in ('aborted','cancelled','completed','done','error','failed','stopped')
      and session.updated_at<=?
    order by session.updated_at asc, i.id asc limit ${boundedLimit(limit)}
  `).all(cutoff);
}
