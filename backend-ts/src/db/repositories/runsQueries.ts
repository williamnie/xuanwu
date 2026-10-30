import { type RunStatus } from "../../domain/run/contracts.ts";
import { type RunListFilter } from "./runsModel.ts";
import { addFilter, addListFilter, unique } from "./runsMapping.ts";

export function runBaseQuery(filter: Omit<RunListFilter, "limit" | "offset">): {
  args: Array<number | string>;
  where: string;
} {
  const clauses: string[] = [];
  const args: Array<number | string> = [];
  addFilter(clauses, args, "run.work_id=?", filter.work_id);
  addFilter(clauses, args, "issue.project_id=?", filter.project_id);
  addListFilter(clauses, args, "run.provider", filter.providers);
  const statuses = unique(filter.statuses ?? []);
  if (statuses.length > 0) {
    // legacy 前提可走索引收窄候选，统一状态表达式再精确判定 recovering/running。
    const legacy = legacyStatusesFor(statuses);
    // 单值写成等式，才能命中 status='in_progress' 的部分索引。
    clauses.push(legacy.length === 0 ? "0"
      : legacy.length === 1 ? `run.status='${legacy[0]}'`
        : `run.status in (${legacy.map((status) => `'${status}'`).join(", ")})`);
    clauses.push(`${CANDIDATE_RUN_STATUS_SQL} in (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  return { args, where: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "" };
}

/** 统一状态只在 in_progress 时依赖最新 Attempt；终态直接由 legacy 状态映射，避免投影全部 Attempt 历史。 */
export const CANDIDATE_RUN_STATUS_SQL = `case
    when run.status='in_progress' then coalesce((
      select 'recovering' from run_attempts latest
      where latest.issue_run_id=run.id
        and latest.sequence=(select max(attempt.sequence) from run_attempts attempt where attempt.issue_run_id=run.id)
        and latest.kind='recovery' and latest.status in ('created', 'failed', 'interrupted')
    ), 'running')
    when run.status='succeeded' then 'succeeded'
    when run.status='failed' then 'failed'
    when run.status='cancelled' then 'cancelled'
    else null end`;

function legacyStatusesFor(statuses: RunStatus[]): string[] {
  const legacy = new Set<string>();
  for (const status of statuses) {
    if (status === "running" || status === "recovering") legacy.add("in_progress");
    else if (status === "succeeded" || status === "failed" || status === "cancelled") legacy.add(status);
  }
  return [...legacy].sort();
}

/** 与 runOrder 同序，但只依赖 issue_runs 列与按 issue_run_id 点查的最新 Attempt，可在投影前分页。 */
export function candidateRunOrder(filter: Pick<RunListFilter, "order" | "sort">): string {
  if (filter.sort === "provider" || filter.sort === "created_at") return runOrder(filter, "run");
  const direction = filter.order === "asc" ? "asc" : "desc";
  if (filter.sort === "status") return `order by ${CANDIDATE_RUN_STATUS_SQL} ${direction}, run.run_id asc`;
  return `order by coalesce(nullif(run.ended_at, ''), (
    select latest.updated_at from run_attempts latest
    where latest.issue_run_id=run.id order by latest.sequence desc limit 1
  ), run.started_at) ${direction}, run.run_id asc`;
}

export function runOrder(filter: Pick<RunListFilter, "order" | "sort">, run = "run", latest = "latest"): string {
  const direction = filter.order === "asc" ? "asc" : "desc";
  if (filter.sort === "provider") return `order by ${run}.provider ${direction}, ${run}.run_id asc`;
  if (filter.sort === "status") return `order by ${run}.unified_status ${direction}, ${run}.run_id asc`;
  if (filter.sort === "created_at") return `order by ${run}.started_at ${direction}, ${run}.run_id asc`;
  const latestUpdatedAt = run === "run" ? `${run}.latest_attempt_updated_at` : `${latest}.updated_at`;
  return `order by coalesce(nullif(${run}.ended_at, ''), ${latestUpdatedAt}, ${run}.started_at) ${direction}, ${run}.run_id asc`;
}

export function runStatusSql(run: string, latest: string): string {
  return `case
    when ${run}.status='in_progress'
      and ${latest}.kind='recovery'
      and ${latest}.status in ('created', 'failed', 'interrupted') then 'recovering'
    when ${run}.status='in_progress' then 'running'
    when ${run}.status='succeeded' then 'succeeded'
    when ${run}.status='failed' then 'failed'
    when ${run}.status='cancelled' then 'cancelled'
    else null end`;
}
