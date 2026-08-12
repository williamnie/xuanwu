import type { Database as SQLiteDatabase } from "bun:sqlite";

export type MaintenanceEventRow = {
  created_at: string;
  event_type: string;
  id: number;
  issue_id: number;
  issue_status: string;
  payload: string;
  project_id: string;
  raw_method: string;
  run_id: string;
  run_status: string;
};

export type IssueEventSnapshot = {
  first_event_id: number;
  issue_event_count: number;
  last_event_id: number;
  payload_bytes: number;
};

export type DatabaseSpaceStats = {
  auto_vacuum: number;
  freelist_count: number;
  page_count: number;
  page_size: number;
};

type EventRow = Omit<MaintenanceEventRow, "raw_method"> & { raw_method: unknown };
type NumericRow = Record<string, number | bigint | null>;

// Provider events are flushed asynchronously after a run ends. Keep the
// association bounded so an old run cannot absorb unrelated later events.
export function listMaintenanceEvents(
  sqlite: SQLiteDatabase,
  input: { afterID: number; before?: string; limit: number }
): MaintenanceEventRow[] {
  const beforeClause = input.before ? "and e.created_at < ?" : "";
  const args: Array<number | string> = [input.afterID];
  if (input.before) args.push(input.before);
  args.push(input.limit);
  return sqlite.query<EventRow, Array<number | string>>(`
    select e.id, e.issue_id, i.project_id, i.status as issue_status, e.type as event_type, e.payload, e.created_at,
      case when json_valid(e.payload) then coalesce(json_extract(e.payload, '$.raw_method'), '') else '' end as raw_method,
      coalesce(r.id, '') as run_id, coalesce(r.status, '') as run_status
    from issue_events e
    join issues i on i.id=e.issue_id
    left join issue_runs r on r.id=(
      select candidate.id from issue_runs candidate
      where candidate.issue_id=e.issue_id
        and julianday(candidate.started_at)<=julianday(e.created_at)
        and (candidate.ended_at='' or
          julianday(candidate.ended_at)>=julianday(e.created_at, '-15 minutes'))
      order by candidate.started_at desc, candidate.attempt desc limit 1
    )
    where e.id>? ${beforeClause}
    order by e.id asc limit ?
  `).all(...args).map(mapEventRow);
}

export function issueEventSnapshot(sqlite: SQLiteDatabase): IssueEventSnapshot {
  const row = sqlite.query<NumericRow, []>(`
    select count(*) as issue_event_count, coalesce(min(id), 0) as first_event_id,
      coalesce(max(id), 0) as last_event_id,
      coalesce(sum(length(cast(payload as blob))), 0) as payload_bytes
    from issue_events
  `).get() ?? {};
  return {
    first_event_id: integer(row.first_event_id),
    issue_event_count: integer(row.issue_event_count),
    last_event_id: integer(row.last_event_id),
    payload_bytes: integer(row.payload_bytes)
  };
}

export function databaseSpaceStats(sqlite: SQLiteDatabase): DatabaseSpaceStats {
  return {
    auto_vacuum: pragmaNumber(sqlite, "auto_vacuum"),
    freelist_count: pragmaNumber(sqlite, "freelist_count"),
    page_count: pragmaNumber(sqlite, "page_count"),
    page_size: pragmaNumber(sqlite, "page_size")
  };
}

export function quickCheck(sqlite: SQLiteDatabase): string {
  const rows = sqlite.query<Record<string, unknown>, []>("pragma quick_check").all();
  return rows.map((row) => String(Object.values(row)[0] ?? "")).join("; ");
}

export function currentIssueEventRows(sqlite: SQLiteDatabase, ids: number[]): MaintenanceEventRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return sqlite.query<EventRow, number[]>(`
    select e.id, e.issue_id, i.project_id, i.status as issue_status, e.type as event_type, e.payload, e.created_at,
      case when json_valid(e.payload) then coalesce(json_extract(e.payload, '$.raw_method'), '') else '' end as raw_method,
      coalesce(r.id, '') as run_id, coalesce(r.status, '') as run_status
    from issue_events e
    join issues i on i.id=e.issue_id
    left join issue_runs r on r.id=(
      select candidate.id from issue_runs candidate
      where candidate.issue_id=e.issue_id
        and julianday(candidate.started_at)<=julianday(e.created_at)
        and (candidate.ended_at='' or
          julianday(candidate.ended_at)>=julianday(e.created_at, '-15 minutes'))
      order by candidate.started_at desc, candidate.attempt desc limit 1
    )
    where e.id in (${placeholders}) order by e.id asc
  `).all(...ids).map(mapEventRow);
}

export function countExistingIssueEvents(sqlite: SQLiteDatabase, ids: number[]): number {
  let count = 0;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const placeholders = batch.map(() => "?").join(", ");
    count += sqlite.query<{ count: number }, number[]>(
      `select count(*) as count from issue_events where id in (${placeholders})`
    ).get(...batch)?.count ?? 0;
  }
  return count;
}

export function deleteIssueEventBatch(sqlite: SQLiteDatabase, ids: number[]): number {
  if (ids.length === 0) return 0;
  const remove = sqlite.transaction((eventIDs: number[]) => {
    const placeholders = eventIDs.map(() => "?").join(", ");
    const existing = sqlite.query<{ count: number }, number[]>(
      `select count(*) as count from issue_events where id in (${placeholders})`
    ).get(...eventIDs)?.count ?? 0;
    if (hasTable(sqlite, "event_summary_projection")) {
      sqlite.run(`delete from event_summary_projection where source='issue_events' and source_event_id in (${placeholders})`, eventIDs);
    }
    const result = sqlite.run(`delete from issue_events where id in (${placeholders})`, eventIDs);
    const changes = Number(result.changes);
    if (changes !== existing) throw new Error(`delete batch expected ${existing} existing rows, changed ${changes}`);
    return changes;
  });
  return remove.immediate(ids);
}

export function restoreIssueEventBatch(
  sqlite: SQLiteDatabase,
  rows: Array<Pick<MaintenanceEventRow, "created_at" | "event_type" | "id" | "issue_id" | "payload">>
): number {
  if (rows.length === 0) return 0;
  const insert = sqlite.query(`
    insert into issue_events (id, issue_id, type, payload, created_at) values (?, ?, ?, ?, ?)
  `);
  const restore = sqlite.transaction((items: typeof rows) => {
    for (const row of items) insert.run(row.id, row.issue_id, row.event_type, row.payload, row.created_at);
    return items.length;
  });
  return restore.immediate(rows);
}

export function recordMaintenanceAudit(
  sqlite: SQLiteDatabase,
  input: {
    actionID: string;
    actor: string;
    decision: string;
    eventType: string;
    reason: string;
    result: Record<string, unknown>;
  }
): void {
  if (!hasTable(sqlite, "pi_action_events")) throw new Error("pi_action_events is required for destructive maintenance audit");
  sqlite.run(`insert into pi_action_events (
    action_id, project_id, issue_id, conversation_id, event_type, actor, decision,
    reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at
  ) values (?, '', 0, '', ?, ?, ?, ?, '{}', ?, '', '', '', ?)`, [
    input.actionID,
    input.eventType,
    input.actor,
    input.decision,
    input.reason,
    JSON.stringify(input.result),
    new Date().toISOString()
  ]);
}

export function walCheckpoint(
  sqlite: SQLiteDatabase,
  mode: "passive" | "full" | "restart" | "truncate"
): { busy: number; checkpointed: number; log: number } {
  const row = sqlite.query<Record<string, number>, []>(`pragma wal_checkpoint(${mode})`).get() ?? {};
  const values = Object.values(row);
  return {
    busy: signedInteger(row.busy ?? values[0]),
    log: signedInteger(row.log ?? values[1]),
    checkpointed: signedInteger(row.checkpointed ?? values[2])
  };
}

export function runVacuum(
  sqlite: SQLiteDatabase,
  input: { enableIncremental: boolean; mode: "full" | "incremental"; pages?: number }
): void {
  if (input.mode === "full") {
    if (input.enableIncremental) sqlite.run("pragma auto_vacuum=incremental");
    sqlite.run("vacuum");
    return;
  }
  if (databaseSpaceStats(sqlite).auto_vacuum !== 2) {
    throw new Error("incremental vacuum requires auto_vacuum=INCREMENTAL; run full vacuum with --enable-incremental first");
  }
  if (input.pages === undefined) sqlite.run("pragma incremental_vacuum");
  else sqlite.run(`pragma incremental_vacuum(${input.pages})`);
}

function pragmaNumber(sqlite: SQLiteDatabase, name: string): number {
  const row = sqlite.query<Record<string, number>, []>(`pragma ${name}`).get();
  return integer(row?.[name] ?? Object.values(row ?? {})[0]);
}

function hasTable(sqlite: SQLiteDatabase, table: string): boolean {
  return Boolean(sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table));
}

function mapEventRow(row: EventRow): MaintenanceEventRow {
  return {
    id: integer(row.id),
    issue_id: integer(row.issue_id),
    issue_status: text(row.issue_status),
    project_id: text(row.project_id),
    event_type: text(row.event_type),
    payload: text(row.payload),
    created_at: text(row.created_at),
    raw_method: text(row.raw_method),
    run_id: text(row.run_id),
    run_status: text(row.run_status)
  };
}

function integer(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer row value: ${String(value)}`);
  return parsed;
}

function signedInteger(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid integer row value: ${String(value)}`);
  return parsed;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("invalid string row value");
  return value;
}
