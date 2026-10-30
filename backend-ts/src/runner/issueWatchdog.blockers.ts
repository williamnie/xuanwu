import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { cleanString } from "../util/values.ts";
import { parsePayload } from "./issueWatchdog.queries.ts";

export function providerRuntimeBlocker(db: RunnerDatabase, provider: string): Record<string, unknown> {
  const row = db.sqlite.query<{
    event_id: number; issue_id: number; next_check_at: string; payload: string;
  }, [string]>(`
    select event.id as event_id, event.issue_id, i.auto_retry_next_at as next_check_at, event.payload
    from issue_events event
    join issues i on i.id=event.issue_id
    where event.type='issue.provider_deferred'
      and i.auto_retry_reason=?
    order by event.id desc limit 1
  `).get(`provider_infra_transient:${provider}`);
  if (!row) return { provider };
  return {
    event_id: row.event_id,
    issue_id: row.issue_id,
    next_check_at: row.next_check_at || cleanString(parsePayload(row.payload).next_check_at),
    provider
  };
}

export function activeCapacityBlockers(db: RunnerDatabase): Array<Record<string, unknown>> {
  return db.sqlite.query<{ id: number; project_id: string; status: string }, []>(`
    select distinct i.id, i.project_id, i.status
    from issues i left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    where (i.status='in_progress' or ir.id is not null)
      and not (ir.id is not null and exists (
        select 1 from issue_events event
        where event.issue_id=i.id and event.type='issue.provider_deferred'
          and event.created_at>=ir.started_at
      ))
    order by i.id limit 10
  `).all().map((row) => ({ issue_id: row.id, project_id: row.project_id, status: row.status }));
}

export function activeProjectBlockers(db: RunnerDatabase, projectID: string): Array<Record<string, unknown>> {
  const cwd = cleanString(getProject(db, projectID)?.cwd);
  return db.sqlite.query<{ id: number; project_id: string; status: string }, [string, string, string]>(`
    select distinct i.id, i.project_id, i.status
    from issues i
    join projects p on p.id=i.project_id
    left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    where (i.project_id=? or (?<>'' and trim(p.cwd)=?))
      and (i.status='in_progress' or ir.id is not null)
    order by i.id limit 10
  `).all(projectID, cwd, cwd).map((row) => ({
    issue_id: row.id,
    project_id: row.project_id,
    status: row.status
  }));
}
