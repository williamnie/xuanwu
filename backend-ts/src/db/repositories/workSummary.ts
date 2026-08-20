import type { RunnerDatabase } from "../database.ts";
import { WORK_STATUSES, type WorkStatus } from "../../domain/work/contracts.ts";

export const WORK_SUMMARY_CONTRACT = "xuanwu.work-summary.v1" as const;
export const WORK_SUMMARY_PROJECT_CAP = 128;
export const OPERATIONAL_WORK_STATUSES = ["triage", "todo", "in_progress", "needs_user", "failed"] as const;
export const HISTORY_WORK_STATUSES = ["done", "cancelled"] as const;

export type WorkStatusCounts = Record<WorkStatus, number> & {
  history: number;
  operational: number;
  total: number;
  unknown_status_count: number;
};
export type WorkSummary = {
  activity: { guarding: number };
  counts: WorkStatusCounts;
  project_count: number;
  project_counts?: Array<{ counts: WorkStatusCounts; project_id: string }>;
  scope: { project_id: string };
};
export type WorkSummaryInput = { includeProjects: boolean; projectId?: string };

type SummaryRow = { guarding: unknown; normalized_status: unknown; project_id: unknown; total: unknown };

export class WorkSummaryCapacityError extends Error {
  constructor(readonly projectCount: number) {
    super(`Project summary capacity exceeded (${projectCount} > ${WORK_SUMMARY_PROJECT_CAP})`);
    this.name = "WorkSummaryCapacityError";
  }
}

export function readWorkSummary(db: RunnerDatabase, input: WorkSummaryInput): WorkSummary {
  const projectID = String(input.projectId ?? "").trim();
  const read = db.transaction(() => {
    const projectIDs = projectID
      ? [projectID]
      : db.sqlite.query<{ id: string }, []>("select id from projects order by id").all().map((row) => row.id);
    if (input.includeProjects && projectIDs.length > WORK_SUMMARY_PROJECT_CAP) {
      throw new WorkSummaryCapacityError(projectIDs.length);
    }
    const rows = db.sqlite.query<SummaryRow, string[]>(`
      select project_id,
        case when status='pending_verification' then 'needs_user' else status end as normalized_status,
        count(*) as total,
        sum(case when status='in_progress' and (
          instr(lower(title), 'verifier') > 0 or instr(lower(title), 'verify') > 0 or
          instr(lower(title), 'guardian') > 0 or instr(lower(title), 'guard') > 0 or
          instr(lower(title), 'supervisor') > 0 or instr(lower(title), 'quality') > 0 or
          instr(lower(title), 'gate') > 0 or instr(title, '验证') > 0 or
          instr(title, '守护') > 0 or instr(title, '门禁') > 0
        ) then 1 else 0 end) as guarding
      from issues
      ${projectID ? "where project_id = ?" : ""}
      group by project_id, normalized_status
    `).all(...(projectID ? [projectID] : []));
    return { projectIDs, rows };
  });
  const snapshot = read();
  const perProject = new Map(snapshot.projectIDs.map((id) => [id, { activity: 0, counts: emptyWorkStatusCounts() }]));
  const global = emptyWorkStatusCounts();
  let guarding = 0;
  for (const row of snapshot.rows) {
    const count = nonNegativeCount(row.total);
    const project = perProject.get(String(row.project_id));
    applyStatusCount(global, String(row.normalized_status), count);
    if (project) applyStatusCount(project.counts, String(row.normalized_status), count);
    const guardingCount = nonNegativeCount(row.guarding);
    guarding += guardingCount;
    if (project) project.activity += guardingCount;
  }
  finalizeCounts(global);
  for (const item of perProject.values()) finalizeCounts(item.counts);
  return {
    activity: { guarding },
    counts: global,
    project_count: snapshot.projectIDs.length,
    ...(input.includeProjects && !projectID ? {
      project_counts: snapshot.projectIDs.map((id) => ({ counts: perProject.get(id)!.counts, project_id: id }))
    } : {}),
    scope: { project_id: projectID }
  };
}

export function emptyWorkStatusCounts(): WorkStatusCounts {
  return {
    cancelled: 0,
    done: 0,
    failed: 0,
    history: 0,
    in_progress: 0,
    needs_user: 0,
    operational: 0,
    todo: 0,
    total: 0,
    triage: 0,
    unknown_status_count: 0
  };
}

function applyStatusCount(counts: WorkStatusCounts, status: string, count: number): void {
  if (WORK_STATUSES.includes(status as WorkStatus)) counts[status as WorkStatus] += count;
  else counts.unknown_status_count += count;
}
function finalizeCounts(counts: WorkStatusCounts): void {
  counts.operational = OPERATIONAL_WORK_STATUSES.reduce((total, status) => total + counts[status], 0);
  counts.history = HISTORY_WORK_STATUSES.reduce((total, status) => total + counts[status], 0);
  counts.total = counts.operational + counts.history + counts.unknown_status_count;
}
function nonNegativeCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
