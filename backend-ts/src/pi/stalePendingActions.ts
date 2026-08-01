import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, getPiAction, updatePiAction } from "../db/repositories/pi.ts";

type PendingActionRow = {
  action_type: string;
  created_at: string;
  id: string;
  issue_id: number;
  issue_status: string | null;
  payload_json: string;
  project_id: string;
  run_status: string | null;
  snoozed_until: string;
  source: string;
};

export type StalePendingAction = {
  action_id: string;
  action_type: string;
  issue_id: number;
  issue_status: string;
  project_id: string;
  reason: string;
  run_status: string;
  source: string;
};

export type StalePendingActionCleanupResult = {
  actions: StalePendingAction[];
  applied: boolean;
  audit_event_type: string;
  backup_path: string;
  dry_run: boolean;
  matched_count: number;
  updated_status: string;
};

type ApplyOptions = {
  backupDir?: string;
  now?: Date;
};

const AUDIT_EVENT_TYPE = "maintenance_stale_cleanup";
const STALE_STATUS = "rejected";
const SUPERVISOR_SOURCES = new Set(["pi_supervisor", "pi_supervisor_decision", "needs_user.escalate"]);
const SUPERVISOR_ACTIONS = new Set(["needs_user.escalate"]);
const EXCLUDED_ACTIONS = new Set(["issue.enqueue"]);
const TERMINAL_ISSUE_STATUSES = new Set(["cancelled", "done", "failed", "needs_user"]);
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "done", "failed"]);
const EXECUTABLE_ACTIONS = new Set([
  "agent.executor_assign",
  "agent.workflow_request",
  "issue.comment",
  "issue.acceptance_request",
  "issue.create",
  "issue.retry",
  "issue.retry_after",
  "issue.schedule_enqueue",
  "issue.state_repair",
  "issue.supervisor_decision",
  "needs_user.escalate",
  "session.resume_followup",
  "session.steer"
]);

export function dryRunStalePendingActions(db: RunnerDatabase, now = new Date()): StalePendingActionCleanupResult {
  const actions = findStalePendingActions(db, now);
  return cleanupResult(false, actions, "");
}

export function applyStalePendingActions(
  db: RunnerDatabase,
  options: ApplyOptions = {}
): StalePendingActionCleanupResult {
  const now = options.now ?? new Date();
  const actions = findStalePendingActions(db, now);
  const backupPath = backupDatabase(db, options.backupDir, now);
  db.transaction(() => {
    for (const action of actions) rejectStaleAction(db, action, backupPath);
  }).immediate();
  return cleanupResult(true, actions, backupPath);
}

function findStalePendingActions(db: RunnerDatabase, now: Date): StalePendingAction[] {
  return pendingRows(db).flatMap((row) => staleSummary(row, now));
}

function pendingRows(db: RunnerDatabase): PendingActionRow[] {
  return db.sqlite.query<PendingActionRow, []>(`
    select a.id, a.project_id, a.issue_id, a.action_type, a.source, a.payload_json,
      a.snoozed_until, a.created_at, i.status as issue_status,
      (
        select ir.status from issue_runs ir
        where ir.issue_id=a.issue_id order by ir.attempt desc limit 1
      ) as run_status
    from pi_actions a
    left join issues i on i.id=a.issue_id
    where a.status='pending'
    order by a.created_at asc, a.id asc
  `).all();
}

function staleSummary(row: PendingActionRow, now: Date): StalePendingAction[] {
  const reason = staleReason(row, now);
  return reason === "" ? [] : [{
    action_id: row.id,
    action_type: row.action_type,
    issue_id: row.issue_id,
    issue_status: row.issue_status ?? "",
    project_id: row.project_id,
    reason,
    run_status: row.run_status ?? "",
    source: row.source
  }];
}

function staleReason(row: PendingActionRow, now: Date): string {
  if (!isSupervisorAction(row) || EXCLUDED_ACTIONS.has(row.action_type)) return "";
  if (TERMINAL_ISSUE_STATUSES.has(row.issue_status ?? "")) return `terminal_issue:${row.issue_status}`;
  if (TERMINAL_RUN_STATUSES.has(row.run_status ?? "")) return `terminal_run:${row.run_status}`;
  if (isExpired(row, now) && !EXECUTABLE_ACTIONS.has(row.action_type)) return "expired_without_resolver";
  return "";
}

function isSupervisorAction(row: PendingActionRow): boolean {
  return SUPERVISOR_SOURCES.has(row.source) || SUPERVISOR_ACTIONS.has(row.action_type);
}

function isExpired(row: PendingActionRow, now: Date): boolean {
  return expiryValues(row).some((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now.getTime();
  });
}

function expiryValues(row: PendingActionRow): string[] {
  const payload = parsePayload(row.payload_json);
  return [
    row.snoozed_until,
    stringField(payload, "expires_at"),
    stringField(payload, "expiresAt"),
    stringField(payload, "expire_at")
  ].filter(Boolean);
}

function parsePayload(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function rejectStaleAction(db: RunnerDatabase, action: StalePendingAction, backupPath: string): void {
  const current = getPiAction(db, action.action_id);
  if (!current || current.status !== "pending") return;
  const updated = updatePiAction(db, current.id, {
    decided_by: "maintenance",
    result_json: JSON.stringify({ backup_path: backupPath, reason: action.reason, status: STALE_STATUS }),
    status: STALE_STATUS
  });
  createPiActionEvent(db, {
    action_id: updated.id,
    actor: "maintenance",
    decision: "reject_stale",
    event_type: AUDIT_EVENT_TYPE,
    issue_id: updated.issue_id,
    payload_json: JSON.stringify(action),
    project_id: updated.project_id,
    reason: action.reason,
    result_json: JSON.stringify({ backup_path: backupPath, status: STALE_STATUS })
  });
}

function backupDatabase(db: RunnerDatabase, backupDir: string | undefined, now: Date): string {
  const dir = clean(backupDir) || join(dirname(db.path), "backups");
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, `pi-actions-stale-pending-${stamp(now)}-${crypto.randomUUID().slice(0, 8)}.db`);
  db.sqlite.run("vacuum main into ?", [backupPath]);
  return backupPath;
}

function cleanupResult(
  applied: boolean,
  actions: StalePendingAction[],
  backupPath: string
): StalePendingActionCleanupResult {
  return {
    actions,
    applied,
    audit_event_type: AUDIT_EVENT_TYPE,
    backup_path: backupPath,
    dry_run: !applied,
    matched_count: actions.length,
    updated_status: STALE_STATUS
  };
}

function stamp(now: Date): string {
  return now.toISOString().replaceAll(/[:.]/g, "-");
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
