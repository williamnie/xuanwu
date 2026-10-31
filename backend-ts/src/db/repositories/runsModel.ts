import { type RunProgressProjection } from "./runProgress.ts";
import {
  type AttemptKind,
  type AttemptStatus,
  type RunCost,
  type RunID,
  type RunStatus,
  type RunTrigger,
  type WorkID
} from "../../domain/run/contracts.ts";
import { runStatusSql } from "./runsQueries.ts";

export type RunListFilter = {
  limit: number;
  offset: number;
  order?: "asc" | "desc";
  project_id?: string;
  providers?: string[];
  sort?: "created_at" | "provider" | "status" | "updated_at";
  statuses?: RunStatus[];
  work_id?: WorkID;
};

export type RunAttemptView = {
  agent_session_key: string;
  cost: RunCost | null;
  created_at: string;
  ended_at: string;
  id: string;
  kind: AttemptKind | null;
  links: Record<string, string>;
  mapping_errors: string[];
  provider_ref: {
    invocation_ref: string;
    observation_ref?: string;
    provider: string;
    session_ref?: string;
    turn_ref?: string;
  };
  revision: number;
  run_id: RunID;
  sequence: number;
  started_at: string;
  status: AttemptStatus | null;
  terminal?: { reason: string; source_ref: string };
  updated_at: string;
};

export type RunView = {
  attempt_count: number;
  cost: RunCost | null;
  created_at: string;
  ended_at: string;
  id: RunID;
  legacy: {
    error: string;
    id: string;
    status: string;
  };
  links: Record<string, string>;
  mapping_errors: string[];
  progress: RunProgressProjection & {
    attempt_id: string;
    attempt_sequence: number;
    attempt_status: AttemptStatus | null;
    phase: RunStatus | null;
    updated_at: string;
  };
  project_id: string;
  provider: string;
  revision: number;
  sequence: number;
  started_at: string;
  status: RunStatus | null;
  supersedes_run_id: RunID | null;
  terminal?: { reason: string; source_ref: string };
  trigger: RunTrigger | null;
  updated_at: string;
  work_id: WorkID;
  work_title: string;
};

export type RunDetail = RunView & { attempts: RunAttemptView[] };

export type RunRow = {
  attempt_count: number;
  ended_at: string;
  error: string;
  exit_reason: string;
  latest_attempt_id: string | null;
  latest_attempt_kind: string | null;
  latest_attempt_revision: number | null;
  latest_attempt_sequence: number | null;
  latest_attempt_status: string | null;
  latest_attempt_updated_at: string | null;
  legacy_id: string;
  legacy_status: string;
  project_id: string;
  provider: string;
  revision: number;
  run_id: string;
  run_sequence: number;
  started_at: string;
  supersedes_run_id: string | null;
  trigger: string | null;
  unified_status: string | null;
  work_id: string;
  work_title: string;
};

export type AttemptRow = {
  agent_session_key: string | null;
  attempt_id: string;
  cost_json: string;
  created_at: string;
  ended_at: string;
  kind: string;
  mapping_error: string;
  provider: string;
  provider_invocation_ref: string;
  provider_session_id: string;
  provider_turn_id: string;
  revision: number;
  run_id: string;
  sequence: number;
  started_at: string;
  status: string | null;
  terminal_reason: string;
  terminal_source_ref: string;
  updated_at: string;
};

export const RUN_DETAIL_COLUMNS = `
  run.id as legacy_id,
  run.run_id,
  run.work_id,
  run.run_sequence,
  run.status as legacy_status,
  run.provider,
  run.started_at,
  run.ended_at,
  run.exit_reason,
  run.error,
  issue.project_id,
  issue.title as work_title,
  latest.attempt_id as latest_attempt_id,
  latest.sequence as latest_attempt_sequence,
  latest.kind as latest_attempt_kind,
  latest.status as latest_attempt_status,
  latest.revision as latest_attempt_revision,
  latest.updated_at as latest_attempt_updated_at,
  (select count(*) from run_attempts child where child.issue_run_id=run.id) as attempt_count,
  coalesce((select max(cast(json_extract(event.payload, '$.after_revision') as integer))
    from issue_events event
    where event.issue_id=run.issue_id
      and event.type in ('run.lifecycle.intent.v1', 'run.lifecycle.outcome.v1',
      'run.lifecycle.run_materialized.v1', 'run.lifecycle.run_requested.v1')
      and json_valid(event.payload)
      and json_extract(event.payload, '$.run_id')=run.run_id), 0) as revision,
  (select json_extract(event.payload, '$.trigger') from issue_events event
    where event.issue_id=run.issue_id
      and event.type='run.lifecycle.run_materialized.v1'
      and json_valid(event.payload)
      and json_extract(event.payload, '$.run_id')=run.run_id
    order by event.id desc limit 1) as trigger,
  (select json_extract(event.payload, '$.supersedes_run_id') from issue_events event
    where event.issue_id=run.issue_id
      and event.type='run.lifecycle.run_materialized.v1'
      and json_valid(event.payload)
      and json_extract(event.payload, '$.run_id')=run.run_id
    order by event.id desc limit 1) as supersedes_run_id,
  ${runStatusSql("run", "latest")} as unified_status`;
