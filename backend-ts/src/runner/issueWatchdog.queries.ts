import type { RunnerDatabase } from "../db/database.ts";
import { type ProjectLoopDecision } from "./projectLoop.ts";
import type { StaleTodoRow } from "./issueWatchdog.model.ts";

export function listStaleTodoWithoutRuntime(
  db: RunnerDatabase,
  cutoff: string,
  now: string,
  limit: number
): StaleTodoRow[] {
  return db.sqlite.query<StaleTodoRow, [string, string, number]>(`
    select i.id, i.project_id, i.title, i.status, i.created_at, i.updated_at,
           p.name as project_name, p.provider
    from issues i
    join projects p on p.id=i.project_id
    where p.auto_run=1
      and i.status='todo'
      and (
        coalesce(nullif(i.updated_at, ''), i.created_at) <= ?
        or (
          i.auto_retry_reason like 'provider_infra_transient:%'
          and i.auto_retry_next_at<>''
          and i.auto_retry_next_at<=?
        )
      )
      and not exists (
        select 1 from issue_runs ir where ir.issue_id=i.id and ir.ended_at=''
      )
      and not exists (
        select 1 from agent_sessions s
        where s.issue_id=i.id
          and lower(replace(replace(replace(s.status, '_', ''), '-', ''), ' ', ''))
            in ('active', 'busy', 'inprogress', 'running')
      )
    order by i.updated_at asc, i.created_at asc, i.id asc
    limit ?
  `).all(cutoff, now, limit);
}

export function uniqueProjectRows(rows: StaleTodoRow[]): StaleTodoRow[] {
  return [...new Map(rows.map((row) => [row.project_id, row])).values()];
}

export function rowFromDecision(candidate: StaleTodoRow, decision: ProjectLoopDecision): StaleTodoRow {
  const issue = decision.issue;
  if (!issue) return candidate;
  return {
    ...candidate,
    created_at: issue.created_at,
    id: issue.id,
    project_id: issue.project_id,
    provider: decision.provider || candidate.provider,
    status: issue.status,
    title: issue.title,
    updated_at: issue.updated_at
  };
}

export function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
