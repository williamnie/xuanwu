import type { RunnerDatabase } from "../../db/database.ts";
import {
  finalizeIssueRunPreparation,
  type ReservedIssueRun,
  type RunPreparationResult
} from "../../db/repositories/issueRuns.ts";
import { observeGitWorkspaceBaseline } from "./gitWorkspaceObservation.ts";
import { captureExecutionEvidenceContext, recordExecutionEvidenceContext } from "../acceptance/executionEvidenceContext.ts";

export async function prepareReservedIssueRun(
  db: RunnerDatabase,
  reservation: ReservedIssueRun,
  observe: typeof observeGitWorkspaceBaseline = observeGitWorkspaceBaseline
): Promise<RunPreparationResult> {
  const context = captureExecutionEvidenceContext(db, reservation.issue_id);
  const baseline = reservation.project_cwd
    ? await observe({ project_cwd: reservation.project_cwd, run_id: reservation.run_id })
    : null;
  const result = finalizeIssueRunPreparation(db, reservation, baseline);
  if (result.status === "ready") recordExecutionEvidenceContext(db, reservation.issue_id, reservation.run_id, "start", context);
  return result;
}
