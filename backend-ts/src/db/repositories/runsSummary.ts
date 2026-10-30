import type { RunnerDatabase } from "../database.ts";
import { type RunRow } from "./runsModel.ts";
import { runStatusSql } from "./runsQueries.ts";

export function listRunSummaryRows(
  db: RunnerDatabase,
  query: {
    args: Array<number | string>;
    candidatePage?: string;
    candidateWhere: string;
    limit: string;
    order: string;
    selectedWhere: string;
  }
): RunRow[] {
  return db.sqlite.query<RunRow, Array<number | string>>(`
    with candidate_runs as materialized (
      select
        run.id as legacy_id,
        run.issue_id,
        run.run_id,
        run.work_id,
        run.run_sequence,
        run.status,
        run.status as legacy_status,
        run.provider,
        run.started_at,
        run.ended_at,
        run.exit_reason,
        run.error,
        issue.project_id,
        issue.title as work_title
      from issue_runs run
      join issues issue on issue.id=run.issue_id
      ${query.candidateWhere}
      ${query.candidatePage ?? ""}
    ),
    attempt_stats as materialized (
      select candidate.legacy_id as issue_run_id, count(*) as attempt_count, max(attempt.sequence) as latest_sequence
      from candidate_runs candidate
      cross join run_attempts attempt on attempt.run_id=candidate.run_id
      group by candidate.legacy_id
    ),
    ranked_runs as materialized (
      select
        candidate.*,
        latest.attempt_id as latest_attempt_id,
        latest.sequence as latest_attempt_sequence,
        latest.kind as latest_attempt_kind,
        latest.status as latest_attempt_status,
        latest.revision as latest_attempt_revision,
        latest.updated_at as latest_attempt_updated_at,
        coalesce(stats.attempt_count, 0) as attempt_count,
        ${runStatusSql("candidate", "latest")} as unified_status
      from candidate_runs candidate
      left join attempt_stats stats on stats.issue_run_id=candidate.legacy_id
      left join run_attempts latest
        on latest.run_id=candidate.run_id and latest.sequence=stats.latest_sequence
    ),
    selected_runs as materialized (
      select * from ranked_runs run
      ${query.selectedWhere}
      ${query.order}
      ${query.limit}
    ),
    lifecycle_rollup as materialized (
      select
        run.run_id,
        coalesce(max(cast(json_extract(event.payload, '$.after_revision') as integer)), 0) as revision,
        max(case when event.type='run.lifecycle.run_materialized.v1' then event.id end) as materialized_event_id
      from selected_runs run
      left join issue_events event
        on event.issue_id=run.issue_id
        and event.type in ('run.lifecycle.intent.v1', 'run.lifecycle.outcome.v1',
          'run.lifecycle.run_materialized.v1', 'run.lifecycle.run_requested.v1')
        and json_valid(event.payload)
        and json_extract(event.payload, '$.run_id')=run.run_id
      group by run.run_id
    )
    select
      run.legacy_id,
      run.run_id,
      run.work_id,
      run.run_sequence,
      run.legacy_status,
      run.provider,
      run.started_at,
      run.ended_at,
      run.exit_reason,
      run.error,
      run.project_id,
      run.work_title,
      run.latest_attempt_id,
      run.latest_attempt_sequence,
      run.latest_attempt_kind,
      run.latest_attempt_status,
      run.latest_attempt_revision,
      run.latest_attempt_updated_at,
      run.attempt_count,
      rollup.revision,
      json_extract(materialized.payload, '$.trigger') as trigger,
      json_extract(materialized.payload, '$.supersedes_run_id') as supersedes_run_id,
      run.unified_status
    from selected_runs run
    join lifecycle_rollup rollup on rollup.run_id=run.run_id
    left join issue_events materialized on materialized.id=rollup.materialized_event_id
    ${query.order}
  `).all(...query.args);
}
