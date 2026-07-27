import type { RunnerDatabase } from "../db/database.ts";
import { recordMaintenanceAudit } from "../db/repositories/eventMaintenance.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { PI_MANAGER_CYCLE_TITLE } from "../db/repositories/pi.ts";
import type { StaleProcessReconciliation } from "../providers/codex/processLifecycle.ts";

export const STALE_SESSION_RECONCILIATION_EVENT = "agent_session.stale_reconciled.v1";

type ActiveSessionRow = {
  issue_id: number;
  project_id: string;
  provider: string;
  provider_session_id: string;
  session_key: string;
  status: string;
};
type ActiveManagerConversationSummary = { count: number; ids: string[] };

export type StaleSessionReconciliationResult = {
  active_owner_sessions: number;
  audit_action_id: string;
  process_reconciliation: StaleProcessReconciliation;
  stale_manager_conversations_closed: number;
  stale_sessions_closed: number;
};
type StaleSessionReconciliationOptions = { reconcileManagerConversations?: boolean };
export type StaleManagerCycleReconciliationResult = {
  audit_action_id: string;
  stale_manager_conversations_closed: number;
};

export function reconcileStaleAgentSessions(
  db: RunnerDatabase,
  processReconciliation: StaleProcessReconciliation,
  now = new Date(),
  options: StaleSessionReconciliationOptions = {}
): StaleSessionReconciliationResult {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows = activeSessions(db);
  const stale = rows.filter((row) => !hasOpenRunOwner(db, row));
  const staleManagerConversations = options.reconcileManagerConversations === false
    ? { count: 0, ids: [] }
    : activeManagerConversations(db);
  const actionID = `runner-startup-session-reconciliation:${timestamp}:${process.pid}`;
  const apply = db.transaction((items: ActiveSessionRow[], conversations: ActiveManagerConversationSummary) => {
    for (const row of items) closeStaleSession(db, row, timestamp);
    if (conversations.count > 0) closeStaleManagerConversations(db, timestamp);
    for (const [issueID, sessions] of sessionsByIssue(db, items)) {
      recordIssueEvent(db, issueID, STALE_SESSION_RECONCILIATION_EVENT, {
        action_id: actionID,
        previous_statuses: [...new Set(sessions.map((session) => session.status))],
        process_reconciliation: processReconciliation.action,
        reason: "runner_startup_without_live_provider_owner",
        session_keys: sessions.map((session) => session.session_key)
      });
    }
    recordMaintenanceAudit(db.sqlite, {
      actionID,
      actor: "runner-startup-reconciler",
      decision: items.length > 0 || conversations.count > 0 || processReconciliation.action === "killed" ? "applied" : "noop",
      eventType: STALE_SESSION_RECONCILIATION_EVENT,
      reason: "reconcile persisted active sessions with live process ownership and open Issue Runs",
      result: {
        active_owner_sessions: rows.length - items.length,
        process_reconciliation: processReconciliation,
        stale_manager_conversation_ids: conversations.ids,
        stale_manager_conversation_ids_truncated: conversations.count > conversations.ids.length,
        stale_manager_conversations_closed: conversations.count,
        stale_session_keys: items.map((row) => row.session_key),
        stale_sessions_closed: items.length
      }
    });
  });
  apply.immediate(stale, staleManagerConversations);
  return {
    active_owner_sessions: rows.length - stale.length,
    audit_action_id: actionID,
    process_reconciliation: processReconciliation,
    stale_manager_conversations_closed: staleManagerConversations.count,
    stale_sessions_closed: stale.length
  };
}

export function reconcileStaleManagerCycleConversations(
  db: RunnerDatabase,
  now = new Date()
): StaleManagerCycleReconciliationResult {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const conversations = activeManagerConversations(db);
  const actionID = `agentic-startup-manager-cycle-reconciliation:${timestamp}:${process.pid}`;
  db.transaction(() => {
    if (conversations.count > 0) closeStaleManagerConversations(db, timestamp);
    recordMaintenanceAudit(db.sqlite, {
      actionID,
      actor: "agentic-startup-reconciler",
      decision: conversations.count > 0 ? "applied" : "noop",
      eventType: STALE_SESSION_RECONCILIATION_EVENT,
      reason: "terminalize manager cycles left active by a previous Agentic Worker process",
      result: {
        stale_manager_conversation_ids: conversations.ids,
        stale_manager_conversation_ids_truncated: conversations.count > conversations.ids.length,
        stale_manager_conversations_closed: conversations.count
      }
    });
  }).immediate();
  return { audit_action_id: actionID, stale_manager_conversations_closed: conversations.count };
}

function activeSessions(db: RunnerDatabase): ActiveSessionRow[] {
  return db.sqlite.query<ActiveSessionRow, []>(`
    select session_key, provider, provider_session_id, project_id, issue_id, status
    from agent_sessions
    where lower(status) in ('running', 'inprogress', 'active')
    order by session_key asc
  `).all();
}

function activeManagerConversations(db: RunnerDatabase): ActiveManagerConversationSummary {
  const count = db.sqlite.query<{ count: number }, [string]>(`
    select count(*) as count from pi_conversations
    where title=? and status='active'
  `).get(PI_MANAGER_CYCLE_TITLE)?.count ?? 0;
  const ids = db.sqlite.query<{ id: string }, [string]>(`
    select id from pi_conversations
    where title=? and status='active'
    order by id asc limit 50
  `).all(PI_MANAGER_CYCLE_TITLE).map((row) => row.id);
  return { count, ids };
}

function closeStaleManagerConversations(
  db: RunnerDatabase,
  timestamp: string
): void {
  db.sqlite.run(`
    update pi_conversations set status='interrupted', updated_at=?
    where title=? and status='active'
  `, [timestamp, PI_MANAGER_CYCLE_TITLE]);
}

function hasOpenRunOwner(db: RunnerDatabase, session: ActiveSessionRow): boolean {
  if (session.issue_id <= 0) return false;
  return (db.sqlite.query<{ owned: number }, [number, string, string]>(`
    select 1 as owned
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    where run.issue_id=? and run.ended_at='' and issue.status='in_progress'
      and lower(coalesce(nullif(run.provider, ''), 'codex'))=lower(?)
      and run.provider_session_id=?
    limit 1
  `).get(session.issue_id, session.provider, session.provider_session_id)?.owned ?? 0) === 1;
}

function closeStaleSession(db: RunnerDatabase, session: ActiveSessionRow, timestamp: string): void {
  db.sqlite.run(`
    update agent_sessions
    set status='interrupted',
      raw_ref=json_set(case when json_valid(raw_ref) then raw_ref else '{}' end,
        '$.lifecycle_reconciliation', json(?)),
      updated_at=?
    where session_key=? and lower(status) in ('running', 'inprogress', 'active')
  `, [JSON.stringify({ at: timestamp, reason: "runner_startup_without_live_provider_owner" }), timestamp, session.session_key]);
}

function sessionsByIssue(db: RunnerDatabase, sessions: ActiveSessionRow[]): Map<number, ActiveSessionRow[]> {
  const grouped = new Map<number, ActiveSessionRow[]>();
  for (const session of sessions) {
    if (session.issue_id <= 0 || !issueExists(db, session.issue_id)) continue;
    const rows = grouped.get(session.issue_id) ?? [];
    rows.push(session);
    grouped.set(session.issue_id, rows);
  }
  return grouped;
}

function issueExists(db: RunnerDatabase, issueID: number): boolean {
  return Boolean(db.sqlite.query<{ id: number }, [number]>("select id from issues where id=?").get(issueID));
}
