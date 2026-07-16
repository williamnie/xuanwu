import type { RunnerDatabase } from "../database.ts";
import {
  rebuildRunProgressProjection,
  type RunProgressProjection
} from "./runProgress.ts";
import {
  ATTEMPT_KINDS,
  ATTEMPT_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  aggregateRunCost,
  type AttemptKind,
  type AttemptStatus,
  type RunAttempt,
  type RunCost,
  type RunID,
  type RunStatus,
  type RunTrigger,
  type WorkID
} from "../../domain/run/contracts.ts";

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

type RunRow = {
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

type AttemptRow = {
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

const RUN_COLUMNS = `
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
    where event.type in ('run.lifecycle.intent.v1', 'run.lifecycle.outcome.v1',
      'run.lifecycle.run_materialized.v1', 'run.lifecycle.run_requested.v1')
      and json_valid(event.payload)
      and json_extract(event.payload, '$.run_id')=run.run_id), 0) as revision,
  (select json_extract(event.payload, '$.trigger') from issue_events event
    where event.type='run.lifecycle.run_materialized.v1'
      and json_valid(event.payload)
      and json_extract(event.payload, '$.run_id')=run.run_id
    order by event.id desc limit 1) as trigger,
  (select json_extract(event.payload, '$.supersedes_run_id') from issue_events event
    where event.type='run.lifecycle.run_materialized.v1'
      and json_valid(event.payload)
      and json_extract(event.payload, '$.run_id')=run.run_id
    order by event.id desc limit 1) as supersedes_run_id,
  ${runStatusSql("run", "latest")} as unified_status`;

export function listRuns(db: RunnerDatabase, filter: RunListFilter): RunView[] {
  const query = runQuery(filter);
  return db.sqlite.query<RunRow, Array<number | string>>(`
    select ${RUN_COLUMNS}
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    left join run_attempts latest
      on latest.issue_run_id=run.id
      and latest.sequence=(select max(candidate.sequence) from run_attempts candidate where candidate.issue_run_id=run.id)
    ${query.where}
    ${runOrder(filter)}
    limit ? offset ?
  `).all(...query.args, filter.limit, filter.offset).map((row) => mapRunRow(db, row, 0));
}

export function countRuns(db: RunnerDatabase, filter: Omit<RunListFilter, "limit" | "offset">): number {
  const query = runQuery(filter);
  return db.sqlite.query<{ count: number }, Array<number | string>>(`
    select count(*) as count
    from issue_runs run
    join issues issue on issue.id=run.issue_id
    left join run_attempts latest
      on latest.issue_run_id=run.id
      and latest.sequence=(select max(candidate.sequence) from run_attempts candidate where candidate.issue_run_id=run.id)
    ${query.where}
  `).get(...query.args)?.count ?? 0;
}

export function getRun(db: RunnerDatabase, runID: RunID): RunDetail | null {
  const row = db.sqlite.query<RunRow, [string]>(`
    select ${RUN_COLUMNS}
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

function runQuery(filter: Omit<RunListFilter, "limit" | "offset">): {
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
    clauses.push(`${runStatusSql("run", "latest")} in (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  return { args, where: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "" };
}

function runOrder(filter: Pick<RunListFilter, "order" | "sort">): string {
  const direction = filter.order === "asc" ? "asc" : "desc";
  if (filter.sort === "provider") return `order by run.provider ${direction}, run.run_id asc`;
  if (filter.sort === "status") return `order by unified_status ${direction}, run.run_id asc`;
  if (filter.sort === "created_at") return `order by run.started_at ${direction}, run.run_id asc`;
  return `order by coalesce(nullif(run.ended_at, ''), latest.updated_at, run.started_at) ${direction}, run.run_id asc`;
}

function runStatusSql(run: string, latest: string): string {
  return `case
    when ${run}.status='in_progress'
      and ${latest}.kind='recovery'
      and ${latest}.status in ('created', 'failed', 'interrupted') then 'recovering'
    when ${run}.status='in_progress' then 'running'
    when ${run}.status in ('pending_verification', 'done') then 'succeeded'
    when ${run}.status='failed' then 'failed'
    when ${run}.status='cancelled' then 'cancelled'
    else null end`;
}

function mapRunRow(db: RunnerDatabase, row: RunRow, timelineLimit?: number): RunView {
  const id = row.run_id as RunID;
  const workID = row.work_id as WorkID;
  const status = RUN_STATUSES.includes(row.unified_status as RunStatus) ? row.unified_status as RunStatus : null;
  const attemptStatus = ATTEMPT_STATUSES.includes(row.latest_attempt_status as AttemptStatus)
    ? row.latest_attempt_status as AttemptStatus
    : null;
  const trigger = RUN_TRIGGERS.includes(row.trigger as RunTrigger)
    ? row.trigger as RunTrigger
    : row.run_sequence === 1 ? "initial" : null;
  const updatedAt = clean(row.ended_at) || clean(row.latest_attempt_updated_at) || row.started_at;
  const progress = rebuildRunProgressProjection(db, id, {
    ...(timelineLimit === undefined ? {} : { timelineLimit })
  });
  if (!progress) throw new Error(`Run progress projection source is missing: ${id}`);
  const mappingErrors = [
    ...(status ? [] : [`unsupported legacy issue_run status: ${row.legacy_status}`]),
    ...(row.latest_attempt_id && !attemptStatus ? [`latest Attempt status is unmapped: ${row.latest_attempt_status ?? "null"}`] : []),
    ...(trigger ? [] : ["Run trigger is unavailable for legacy Run without materialization audit"])
  ];
  const terminal = status && ["succeeded", "failed", "cancelled"].includes(status) && row.ended_at
    ? {
        reason: clean(row.exit_reason) || clean(row.error) || `legacy issue_run ${row.legacy_status}`,
        source_ref: `issue_runs:${row.legacy_id}`
      }
    : undefined;
  return {
    attempt_count: row.attempt_count,
    cost: null,
    created_at: row.started_at,
    ended_at: row.ended_at,
    id,
    legacy: { error: row.error, id: row.legacy_id, status: row.legacy_status },
    links: runLinks(id, workID, row.project_id, row.legacy_id, row.latest_attempt_id),
    mapping_errors: mappingErrors,
    progress: {
      ...progress,
      attempt_id: row.latest_attempt_id ?? "",
      attempt_sequence: row.latest_attempt_sequence ?? 0,
      attempt_status: attemptStatus,
      phase: status,
      updated_at: progress.updated_at || updatedAt
    },
    project_id: row.project_id,
    provider: row.provider,
    revision: row.revision,
    sequence: row.run_sequence,
    started_at: row.started_at,
    status,
    supersedes_run_id: clean(row.supersedes_run_id) ? row.supersedes_run_id as RunID : null,
    ...(terminal ? { terminal } : {}),
    trigger,
    updated_at: progress.updated_at || updatedAt,
    work_id: workID,
    work_title: row.work_title
  };
}

function mapAttemptRow(row: AttemptRow, runID: RunID, runError: string): RunAttemptView {
  const status = ATTEMPT_STATUSES.includes(row.status as AttemptStatus) ? row.status as AttemptStatus : null;
  const kind = ATTEMPT_KINDS.includes(row.kind as AttemptKind) ? row.kind as AttemptKind : null;
  const cost = parseRunCost(row.cost_json);
  const sessionRef = clean(row.provider_session_id);
  const terminal = status && ["succeeded", "failed", "cancelled", "interrupted"].includes(status) && row.ended_at
    ? {
        reason: clean(row.terminal_reason) || runError || `${status} Attempt`,
        source_ref: clean(row.terminal_source_ref) || `run_attempts:${row.attempt_id}`
      }
    : undefined;
  return {
    agent_session_key: clean(row.agent_session_key),
    cost: cost.value,
    created_at: row.created_at,
    ended_at: row.ended_at,
    id: row.attempt_id,
    kind,
    links: {
      run: `/api/runs/${encodeURIComponent(runID)}`,
      ...(sessionRef ? { provider_session: `/api/sessions/${encodeURIComponent(`${row.provider}:${sessionRef}`)}` } : {})
    },
    mapping_errors: [
      ...(clean(row.mapping_error) ? [row.mapping_error] : []),
      ...(status ? [] : [`Attempt status is unmapped: ${row.status ?? "null"}`]),
      ...(kind ? [] : [`Attempt kind is unmapped: ${row.kind}`]),
      ...(cost.error ? [cost.error] : [])
    ],
    provider_ref: {
      invocation_ref: row.provider_invocation_ref,
      provider: row.provider,
      ...(sessionRef ? { observation_ref: `${row.provider}:${sessionRef}`, session_ref: sessionRef } : {}),
      ...(clean(row.provider_turn_id) ? { turn_ref: row.provider_turn_id } : {})
    },
    revision: row.revision,
    run_id: runID,
    sequence: row.sequence,
    started_at: row.started_at,
    status,
    ...(terminal ? { terminal } : {}),
    updated_at: row.updated_at
  };
}

function attemptContract(attempt: RunAttemptView): RunAttempt | null {
  if (!attempt.status || !attempt.kind || !attempt.cost) return null;
  return {
    cost: attempt.cost,
    created_at: attempt.created_at,
    ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}),
    id: attempt.id as RunAttempt["id"],
    kind: attempt.kind,
    provider_ref: attempt.provider_ref,
    revision: attempt.revision,
    run_id: attempt.run_id,
    sequence: attempt.sequence,
    ...(attempt.started_at ? { started_at: attempt.started_at } : {}),
    status: attempt.status,
    ...(attempt.terminal ? { terminal: attempt.terminal } : {}),
    updated_at: attempt.updated_at
  };
}

function parseRunCost(value: string): { error: string; value: RunCost | null } {
  try {
    const cost = JSON.parse(value) as RunCost;
    if (!cost || typeof cost !== "object" || !cost.usage || !cost.money ||
      !Array.isArray(cost.pricing_refs) || !Array.isArray(cost.source_refs)) {
      return { error: "Attempt cost_json does not match the RunCost contract", value: null };
    }
    return { error: "", value: cost };
  } catch {
    return { error: "Attempt cost_json is not valid JSON", value: null };
  }
}

function runLinks(
  runID: RunID,
  workID: WorkID,
  projectID: string,
  legacyID: string,
  attemptID: string | null
): Record<string, string> {
  const issueID = Number(workID.slice("xw:work:issues:".length));
  const baseEvents = `/api/issues/${issueID}/events`;
  return {
    self: `/api/runs/${encodeURIComponent(runID)}`,
    work: `/api/works/${encodeURIComponent(workID)}`,
    project: `/api/projects/${encodeURIComponent(projectID)}`,
    issue: `/api/issues/${issueID}`,
    logs: `${baseEvents}?type=issue.log`,
    evidence: `/api/evidence?run_id=${encodeURIComponent(runID)}`,
    lifecycle_audit: `${baseEvents}?type=run.lifecycle.intent.v1,run.lifecycle.outcome.v1,run.lifecycle.run_requested.v1,run.lifecycle.run_materialized.v1`,
    legacy_run: `/api/issues/${issueID}/runs#${encodeURIComponent(legacyID)}`,
    ...(attemptID ? { current_attempt: `/api/runs/${encodeURIComponent(runID)}#${encodeURIComponent(attemptID)}` } : {})
  };
}

function addFilter(
  clauses: string[],
  args: Array<number | string>,
  expression: string,
  value: string | undefined
): void {
  const text = clean(value);
  if (!text) return;
  clauses.push(expression);
  args.push(text);
}

function addListFilter(
  clauses: string[],
  args: Array<number | string>,
  column: string,
  values: string[] | undefined
): void {
  const requested = unique(values ?? []);
  if (requested.length === 0) return;
  clauses.push(`${column} in (${requested.map(() => "?").join(", ")})`);
  args.push(...requested);
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))] as T[];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
