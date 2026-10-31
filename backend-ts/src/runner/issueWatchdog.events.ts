import type { RunnerDatabase } from "../db/database.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";
import type { IssueWatchdogInput, StaleTodoRow } from "./issueWatchdog.model.ts";

export function publishNeedsUser(
  input: IssueWatchdogInput,
  row: StaleTodoRow,
  now: Date,
  diagnosis: "todo_without_session",
  stateKey: string
): boolean {
  return publishPiNeedsUserNotification({
    actionID: `${stateKey}:${diagnosis}`,
    bus: input.bus,
    database: input.database,
    diagnosis,
    issue: { id: row.id, project_id: row.project_id, status: row.status, title: row.title },
    message: `issue #${row.id} 停在 todo，watchdog kick 后仍没有 open run 或 active session。`,
    nextStep: "请检查 runner loop/provider 状态；恢复后 retry 或重新触发项目执行。",
    now,
    project: { id: row.project_id, name: row.project_name },
    provider: row.provider
  }) !== null;
}

export function lastWatchdogKickAt(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ created_at: string }, [number]>(`
    select created_at from issue_events
    where issue_id=? and type='issue.watchdog_kicked'
    order by created_at desc, id desc limit 1
  `).get(issueID)?.created_at ?? "";
}

export function watchdogKickAttempts(db: RunnerDatabase, issueID: number, stateKey: string): number {
  return db.sqlite.query<{ count: number }, [number, string]>(`
    select count(*) as count from issue_events
    where issue_id=? and type='issue.watchdog_kicked'
      and json_valid(payload) and json_extract(payload, '$.state_key')=?
  `).get(issueID, stateKey)?.count ?? 0;
}

export function recordWatchdogEvent(
  db: RunnerDatabase,
  issueID: number,
  type: "issue.watchdog_kicked" | "issue.watchdog_needs_user" |
    "issue.watchdog_runtime_mismatch" | "issue.watchdog_waiting",
  payload: Record<string, unknown>,
  now: Date
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), now.toISOString()]
  );
}
