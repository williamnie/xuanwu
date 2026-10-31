import type { RunnerDatabase } from "../database.ts";

export type RemoteRun = {
  issue_id: number;
  issue_run_id: string;
  node_id: string;
  project_id: string;
  provider: string;
  run_ref: string;
};

export function recordRemoteRunStart(db: RunnerDatabase, run: RemoteRun, timestamp = new Date()): void {
  const now = timestamp.toISOString();
  db.sqlite.run(`insert or ignore into remote_runs
    (run_ref, node_id, issue_id, issue_run_id, project_id, provider, status, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  [run.run_ref, run.node_id, run.issue_id, run.issue_run_id, run.project_id, run.provider, now, now]);
}

export function finishRemoteRun(db: RunnerDatabase, runRef: string, timestamp = new Date()): void {
  db.sqlite.run("update remote_runs set status='finished', updated_at=? where run_ref=? and status='active'", [timestamp.toISOString(), runRef]);
}

export function listActiveRemoteRuns(db: RunnerDatabase, nodeId?: string): RemoteRun[] {
  const rows = nodeId === undefined
    ? db.sqlite.query<RemoteRun, []>(`select ${COLUMNS} from remote_runs where status='active' order by created_at`).all()
    : db.sqlite.query<RemoteRun, [string]>(`select ${COLUMNS} from remote_runs where status='active' and node_id=? order by created_at`).all(nodeId);
  return rows.map((row) => ({ ...row, issue_id: Number(row.issue_id) }));
}

export function hasActiveRemoteRun(db: RunnerDatabase, issueRunId: string): boolean {
  return Boolean(db.sqlite.query("select 1 from remote_runs where issue_run_id=? and status='active' limit 1").get(issueRunId));
}

const COLUMNS = "run_ref, node_id, issue_id, issue_run_id, project_id, provider";
