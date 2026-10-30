import type { RunnerDatabase } from "../database.ts";
import { type NormalizedIssuePatch } from "./issueUpdatePatch.ts";

export function closeOpenIssueRun(db: RunnerDatabase, issue: NormalizedIssuePatch & { id?: number }, timestamp: string): void {
  const issueID = typeof issue.id === "number" ? issue.id : undefined;
  if (!issueID) return;
  db.sqlite.run(`update issue_runs set status=?,
    provider_session_id=case when provider_session_id='' then ? else provider_session_id end,
    provider_turn_id=case when provider_turn_id='' then ? else provider_turn_id end,
    codex_thread_id=?, codex_turn_id=?, ended_at=?, exit_reason=?, error=?
    where id=(select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1)`,
    [issue.status, issue.codex_thread_id, issue.codex_turn_id, issue.codex_thread_id,
      issue.codex_turn_id, timestamp, patchStatusExitReason(issue.status), issue.error, issueID]);
}

function patchStatusExitReason(status: string): string {
  if (status === "done" || status === "needs_user") return "pi_semantic_decision";
  if (status === "failed" || status === "cancelled") return status;
  return "status_changed";
}
