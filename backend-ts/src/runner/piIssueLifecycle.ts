import type { RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";

export const PI_ISSUE_DECISION_EVENT = "issue.pi_lifecycle_decision.v1";

export type PiSemanticIssueStatus = "done" | "failed" | "needs_user";

/**
 * Issue 的语义终态只能从这个 Host 写入口落库。Provider 和巡检器只记录事实；
 * PI 给出决定后，Host 才把对应状态写进 Issue。
 */
export function applyPiSemanticIssueStatus(
  db: RunnerDatabase,
  issueID: number,
  input: {
    card_fingerprint: string;
    decision: string;
    reason: string;
    run_id: string;
    status: PiSemanticIssueStatus;
  }
): Issue {
  const current = getIssue(db, issueID);
  if (!current) throw new Error(`Issue #${issueID} not found`);
  if (current.status === input.status && alreadyApplied(db, issueID, input.card_fingerprint)) return current;
  if (current.status !== "in_progress") {
    throw new Error(`PI semantic decision requires in_progress; Issue is ${current.status}`);
  }
  return db.transaction(() => {
    const updated = updateIssue(db, issueID, {
      error: input.status === "failed" ? input.reason : "",
      status: input.status
    });
    recordIssueEvent(db, issueID, PI_ISSUE_DECISION_EVENT, {
      actor: { id: "pi", kind: "supervisor" },
      card_fingerprint: input.card_fingerprint,
      decision: input.decision,
      from_status: current.status,
      reason: input.reason,
      run_id: input.run_id,
      status: input.status
    });
    return updated;
  }).immediate();
}

function alreadyApplied(db: RunnerDatabase, issueID: number, fingerprint: string): boolean {
  return db.sqlite.query<{ count: number }, [number, string]>(`
    select count(*) as count from issue_events
    where issue_id=? and type='${PI_ISSUE_DECISION_EVENT}'
      and json_extract(payload, '$.card_fingerprint')=?
  `).get(issueID, fingerprint)?.count === 1;
}
