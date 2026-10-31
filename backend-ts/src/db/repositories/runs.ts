import type { RunnerDatabase } from "../database.ts";
import {
  RUN_STATUSES,
  aggregateRunCost,
  type RunAttempt,
  type RunID,
  type RunStatus,
  type WorkID
} from "../../domain/run/contracts.ts";
import { cleanString } from "../../util/values.ts";
import {
  type RunListFilter,
  type RunView,
  type RunDetail,
  type RunRow,
  RUN_DETAIL_COLUMNS,
  type RunAttemptView,
  type AttemptRow
} from "./runsModel.ts";
import { runBaseQuery, candidateRunOrder, runOrder, CANDIDATE_RUN_STATUS_SQL } from "./runsQueries.ts";
import { listRunSummaryRows } from "./runsSummary.ts";
import { mapRunRow, unique, attemptContract, mapAttemptRow } from "./runsMapping.ts";

export function listRuns(db: RunnerDatabase, filter: RunListFilter): RunView[] {
  const query = runBaseQuery(filter);
  // 排序键与统一状态都可在 Run 层按最新 Attempt 点查求值，先取页再做完整投影。
  return listRunSummaryRows(db, {
    args: [...query.args, filter.limit, filter.offset],
    candidatePage: `${candidateRunOrder(filter)} limit ? offset ?`,
    candidateWhere: query.where,
    limit: "",
    order: runOrder(filter, "run"),
    selectedWhere: ""
  }).map((row) => mapRunRow(db, row, "summary"));
}

export function countRuns(db: RunnerDatabase, filter: Omit<RunListFilter, "limit" | "offset">): number {
  const query = runBaseQuery(filter);
  return db.sqlite.query<{ count: number }, Array<number | string>>(`
    select count(*) as count
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    ${query.where}
  `).get(...query.args)?.count ?? 0;
}

export function countRunsByStatus(db: RunnerDatabase): Record<RunStatus, number> {
  const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>;
  const rows = db.sqlite.query<{ count: number; status: string | null }, []>(`
    select unified_status as status, count(*) as count from (
      select ${CANDIDATE_RUN_STATUS_SQL} as unified_status from issue_runs run
    )
    group by unified_status
  `).all();
  for (const row of rows) {
    if (RUN_STATUSES.includes(row.status as RunStatus)) counts[row.status as RunStatus] = row.count;
  }
  return counts;
}

export function listLatestRunsForWorkIDs(db: RunnerDatabase, workIDs: WorkID[]): RunView[] {
  const requested = unique(workIDs.map(cleanString).filter(Boolean));
  if (requested.length === 0) return [];
  if (requested.length > 100) throw new Error("latest Runs query supports at most 100 Work ids");
  const placeholders = requested.map(() => "?").join(", ");
  return listRunSummaryRows(db, {
    args: requested,
    candidateWhere: `where run.work_id in (${placeholders})
      and not exists (
        select 1 from issue_runs newer
        where newer.work_id=run.work_id and newer.run_sequence>run.run_sequence
      )`,
    limit: "",
    order: runOrder({ order: "desc", sort: "updated_at" }, "run"),
    selectedWhere: ""
  }).map((row) => mapRunRow(db, row, "summary"));
}

export function getRun(db: RunnerDatabase, runID: RunID): RunDetail | null {
  const row = db.sqlite.query<RunRow, [string]>(`
    select ${RUN_DETAIL_COLUMNS}
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    left join run_attempts latest
      on latest.issue_run_id=run.id
      and latest.sequence=(select max(candidate.sequence) from run_attempts candidate where candidate.issue_run_id=run.id)
    where run.run_id=?
  `).get(runID);
  if (!row) return null;
  const run = mapRunRow(db, row);
  const attempts = listRunAttempts(db, run.id, run.legacy.id, run.legacy.error);
  const contractAttempts = attempts.map(attemptContract).filter((attempt): attempt is RunAttempt => attempt !== null);
  return {
    ...run,
    attempts,
    cost: contractAttempts.length === attempts.length ? aggregateRunCost(contractAttempts) : null
  };
}

function listRunAttempts(
  db: RunnerDatabase,
  runID: RunID,
  legacyID: string,
  runError: string
): RunAttemptView[] {
  return db.sqlite.query<AttemptRow, [string]>(`
    select attempt_id, run_id, sequence, kind, status, mapping_error, revision,
      provider, provider_invocation_ref, provider_session_id, provider_turn_id,
      agent_session_key, cost_json, started_at, ended_at, terminal_reason,
      terminal_source_ref, created_at, updated_at
    from run_attempts where issue_run_id=? order by sequence asc
  `).all(legacyID).map((row) => mapAttemptRow(row, runID, runError));
}

export type { RunListFilter } from "./runsModel.ts";
export type { RunAttemptView } from "./runsModel.ts";
export type { RunView } from "./runsModel.ts";
export type { RunDetail } from "./runsModel.ts";
