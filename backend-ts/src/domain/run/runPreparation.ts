import type { RunnerDatabase } from "../../db/database.ts";
import {
  finalizeIssueRunPreparation,
  type ReservedIssueRun,
  type RunPreparationResult
} from "../../db/repositories/issueRuns.ts";
import { observeGitWorkspaceBaseline } from "./gitWorkspaceObservation.ts";

export async function prepareReservedIssueRun(
  db: RunnerDatabase,
  reservation: ReservedIssueRun,
  observe: typeof observeGitWorkspaceBaseline = observeGitWorkspaceBaseline
): Promise<RunPreparationResult> {
  const baseline = reservation.project_cwd
    ? await observe({ project_cwd: reservation.project_cwd, run_id: reservation.run_id })
    : null;
  return finalizeIssueRunPreparation(db, reservation, baseline);
}
