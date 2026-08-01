import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

const EMPTY_RUN_COST_JSON = JSON.stringify({
  money: { amount_micros: null, basis: "unavailable", currency: "" },
  pricing_refs: [],
  source_refs: [],
  usage: {
    cached_input_tokens: null,
    completeness: "unavailable",
    input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
    total_tokens: null
  }
});

export const runAttemptRelationsMigration: SqlMigration = {
  id: "042_run_attempt_relations",
  sql: "",
  apply(sqlite) {
    addGeneratedColumn(
      sqlite,
      "run_id",
      "text generated always as ('xw:run:issue_runs:' || id) virtual"
    );
    addGeneratedColumn(
      sqlite,
      "work_id",
      "text generated always as ('xw:work:issues:' || issue_id) virtual"
    );
    addGeneratedColumn(sqlite, "run_sequence", "integer generated always as (attempt) virtual");
    sqlite.run(runAttemptSchemaSql());
  }
};

function runAttemptSchemaSql(): string {
  return `
create unique index if not exists ux_issue_runs_run_id
  on issue_runs(run_id);

create unique index if not exists ux_issue_runs_run_legacy
  on issue_runs(run_id, id);

create unique index if not exists ux_issue_runs_work_sequence
  on issue_runs(work_id, run_sequence);

create table if not exists run_attempts (
  attempt_id text primary key,
  run_id text not null,
  issue_run_id text not null,
  sequence integer not null,
  kind text not null,
  status text,
  legacy_status text not null default '',
  mapping_error text not null default '',
  revision integer not null default 0,
  provider text not null,
  provider_invocation_ref text not null default '',
  provider_session_id text not null default '',
  provider_turn_id text not null default '',
  agent_session_key text,
  cost_json text not null default '${EMPTY_RUN_COST_JSON}',
  started_at text not null default '',
  ended_at text not null default '',
  terminal_reason text not null default '',
  terminal_source_ref text not null default '',
  created_at text not null,
  updated_at text not null,
  foreign key(run_id, issue_run_id) references issue_runs(run_id, id) on delete cascade,
  foreign key(agent_session_key) references agent_sessions(session_key) on delete set null,
  check(attempt_id = run_id || '~attempt:' || sequence),
  check(run_id glob 'xw:run:issue_runs:*'),
  check(sequence > 0),
  check(kind in ('initial', 'resume', 'recovery')),
  check(status is null or status in ('created', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  check((status is null and length(trim(mapping_error)) > 0) or (status is not null and mapping_error = '')),
  check(status is null or status = 'created' or length(trim(provider_invocation_ref)) > 0),
  check(revision >= 0),
  check(length(trim(provider)) > 0),
  check(json_valid(cost_json)),
  check(length(trim(created_at)) > 0),
  check(length(trim(updated_at)) > 0)
);

create unique index if not exists ux_run_attempts_run_sequence
  on run_attempts(run_id, sequence);

create unique index if not exists ux_run_attempts_provider_invocation
  on run_attempts(run_id, provider, provider_invocation_ref)
  where provider_invocation_ref <> '';

create index if not exists idx_run_attempts_agent_session
  on run_attempts(agent_session_key, run_id, sequence);

create index if not exists idx_run_attempts_provider_session
  on run_attempts(provider, provider_session_id, provider_turn_id);

insert into run_attempts (
  attempt_id, run_id, issue_run_id, sequence, kind, status, legacy_status,
  mapping_error, provider, provider_invocation_ref, provider_session_id,
  provider_turn_id, agent_session_key, started_at, ended_at, terminal_reason,
  terminal_source_ref, created_at, updated_at
)
select
  run.run_id || '~attempt:1', run.run_id, run.id, 1, 'initial',
  ${mappedAttemptStatus("run.status")},
  run.status,
  ${mappingError("run.status")},
  run.provider,
  run.id,
  ${providerSessionID("run")},
  ${providerTurnID("run")},
  ${agentSessionKey("run")},
  run.started_at,
  run.ended_at,
  ${terminalReason("run")},
  ${terminalSourceRef("run")},
  run.started_at,
  coalesce(nullif(run.ended_at, ''), run.started_at)
from issue_runs run;

create trigger if not exists trg_issue_runs_run_attempt_insert
after insert on issue_runs
begin
  insert into run_attempts (
    attempt_id, run_id, issue_run_id, sequence, kind, status, legacy_status,
    mapping_error, provider, provider_invocation_ref, provider_session_id,
    provider_turn_id, agent_session_key, started_at, ended_at, terminal_reason,
    terminal_source_ref, created_at, updated_at
  ) values (
    new.run_id || '~attempt:1', new.run_id, new.id, 1, 'initial',
    ${mappedAttemptStatus("new.status")},
    new.status,
    ${mappingError("new.status")},
    new.provider,
    new.id,
    ${providerSessionID("new")},
    ${providerTurnID("new")},
    ${agentSessionKey("new")},
    new.started_at,
    new.ended_at,
    ${terminalReason("new")},
    ${terminalSourceRef("new")},
    new.started_at,
    coalesce(nullif(new.ended_at, ''), new.started_at)
  );
end;

create trigger if not exists trg_issue_runs_run_attempt_update
after update of status, provider, provider_session_id, provider_turn_id,
  codex_thread_id, codex_turn_id, started_at, ended_at, exit_reason, error
on issue_runs
begin
  update run_attempts set
    status=${mappedAttemptStatus("new.status")},
    legacy_status=new.status,
    mapping_error=${mappingError("new.status")},
    provider=new.provider,
    provider_invocation_ref=new.id,
    provider_session_id=${providerSessionID("new")},
    provider_turn_id=${providerTurnID("new")},
    agent_session_key=${agentSessionKey("new")},
    started_at=new.started_at,
    ended_at=new.ended_at,
    terminal_reason=${terminalReason("new")},
    terminal_source_ref=${terminalSourceRef("new")},
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  where issue_run_id=new.id
    and sequence=1
    and not exists (
      select 1 from run_attempts later
      where later.run_id=new.run_id and later.sequence > 1
    );
end;

create trigger if not exists trg_agent_sessions_run_attempt_link_insert
after insert on agent_sessions
begin
  update run_attempts set agent_session_key=new.session_key
  where provider=new.provider
    and provider_session_id=new.provider_session_id
    and provider_session_id <> '';
end;

create trigger if not exists trg_agent_sessions_run_attempt_link_update
after update of provider, provider_session_id on agent_sessions
begin
  update run_attempts set agent_session_key=new.session_key
  where provider=new.provider
    and provider_session_id=new.provider_session_id
    and provider_session_id <> '';
end;
`;
}

function addGeneratedColumn(
  sqlite: SQLiteDatabase,
  name: string,
  definition: string
): void {
  if (tableColumns(sqlite, "issue_runs").has(name)) return;
  sqlite.run(`alter table issue_runs add column ${name} ${definition}`);
}

function tableColumns(sqlite: SQLiteDatabase, table: string): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>(`pragma table_xinfo(${table})`).all().map((row) => row.name));
}

function mappedAttemptStatus(status: string): string {
  return `case ${status}
    when 'in_progress' then 'running'
    when 'succeeded' then 'succeeded'
    when 'failed' then 'failed'
    when 'cancelled' then 'cancelled'
    else null
  end`;
}

function mappingError(status: string): string {
  return `case when ${status} in ('in_progress', 'succeeded', 'failed', 'cancelled')
    then '' else 'unsupported legacy issue_run status: ' || ${status} end`;
}

function providerSessionID(alias: string): string {
  return `coalesce(nullif(${alias}.provider_session_id, ''), nullif(${alias}.codex_thread_id, ''), '')`;
}

function providerTurnID(alias: string): string {
  return `coalesce(nullif(${alias}.provider_turn_id, ''), nullif(${alias}.codex_turn_id, ''), '')`;
}

function agentSessionKey(alias: string): string {
  const sessionID = providerSessionID(alias);
  return `(select session.session_key from agent_sessions session
    where session.session_key=${alias}.provider || ':' || ${sessionID}
    limit 1)`;
}

function terminalReason(alias: string): string {
  return `case when ${mappedAttemptStatus(`${alias}.status`)} in ('succeeded', 'failed', 'cancelled')
    then coalesce(nullif(${alias}.exit_reason, ''), 'legacy issue_run ' || ${alias}.status)
    else '' end`;
}

function terminalSourceRef(alias: string): string {
  return `case when ${mappedAttemptStatus(`${alias}.status`)} in ('succeeded', 'failed', 'cancelled')
    then 'issue_runs:' || ${alias}.id else '' end`;
}
