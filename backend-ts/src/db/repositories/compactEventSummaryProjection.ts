import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { RunnerDatabase } from "../database.ts";
import { hydrateStoredIssueLogPayload } from "./issueEvents.ts";
import {
  EVENT_SUMMARY_SOURCE,
  eventProjectionStatus,
  listEventSummaryProjection,
  listSourceIssueEvents,
  type EventProjectionWatermark,
  type EventSummaryProjection,
  type EventSummaryProjectionFilter
} from "./eventSummaryProjection.ts";
import {
  projectSourceIssueEvent
} from "../../events/eventSummaryProjector.ts";

export const COMPACT_EVENT_SUMMARY_PROJECTION_ID = "issue_events_summary_v2";
export const COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION = "xuanwu.event-summary-projector.v2";
const SWITCH_ID = "issue_events_summary";
const DEFAULT_BATCH_SIZE = 500;

export type EventSummaryProjectionSwitch = {
  cutover_at: string;
  observation_expires_at: string;
  observation_started_at: string;
  read_version: "v1" | "v2";
  revision: number;
  updated_at: string;
};

type CompactRow = {
  created_at: string;
  event_type: string;
  issue_id: number;
  payload_codec: number;
  payload_ref: number;
  project_id: string;
  run_id: string;
  source_event_id: number;
  source_payload_bytes: number;
  source_sha256: Uint8Array;
  summary_payload: Uint8Array;
};

export function projectPendingCompactEventSummaries(
  db: RunnerDatabase,
  options: { batchSize?: number; maxBatches?: number } = {}
): { batches: number; paused: boolean; projected_rows: number; watermark: EventProjectionWatermark } {
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatches = options.maxBatches === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInteger(options.maxBatches, "maxBatches");
  let watermark = compactWatermark(db);
  if (watermark.projector_version !== COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION) {
    throw new Error(`compact event summary projection version mismatch: ${watermark.projector_version}; rebuild required`);
  }
  let batches = 0;
  let projectedRows = 0;
  let projectedRowCount = watermark.projected_row_count;
  const hasPendingRows = listSourceIssueEvents(db, {
    afterID: watermark.last_event_id,
    hydrateIssueLogs: false,
    limit: 1
  }).length > 0;
  if (!hasPendingRows) {
    return { batches, paused: false, projected_rows: projectedRows, watermark };
  }
  const runRefs = dictionaryRefs(db, "event_summary_projection_runs", "run_ref", "run_id");
  const typeRefs = dictionaryRefs(db, "event_summary_projection_types", "event_type_ref", "event_type");
  const projectRefs = dictionaryRefs(db, "event_summary_projection_projects", "project_ref", "project_id");
  const payloadRefs = payloadDictionaryRefs(db);
  const payloadHashes = new Map<string, string>();
  const storedReferenceEvents = new Set(db.sqlite.query<{ source_event_id: number }, []>(
    "select source_event_id from event_summary_projection_compat_modes where payload_mode='stored_reference'"
  ).all().map((row) => Number(row.source_event_id)));
  while (batches < maxBatches) {
    const rows = listSourceIssueEvents(db, {
      afterID: watermark.last_event_id,
      hydrateIssueLogs: false,
      limit: batchSize
    });
    if (rows.length === 0) break;
    const projectedAt = new Date().toISOString();
    db.transaction(() => {
      for (const source of rows) {
        const projected = projectCompactSourceIssueEvent(db, source, projectedAt, storedReferenceEvents);
        const runRef = dictionaryRef(db, "event_summary_projection_runs", "run_ref", "run_id", projected.run_id, runRefs);
        const typeRef = dictionaryRef(db, "event_summary_projection_types", "event_type_ref", "event_type", projected.event_type, typeRefs);
        const projectRef = dictionaryRef(db, "event_summary_projection_projects", "project_ref", "project_id", projected.project_id, projectRefs);
        const payloadRef = payloadDictionaryRef(db, projected.summary_payload, payloadRefs, payloadHashes);
        const result = db.sqlite.run(`
          insert into event_summary_projection_compact (
            source_event_id, issue_id, project_ref, run_ref, event_type_ref, payload_ref,
            source_payload_bytes, source_sha256, event_created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source_event_id) do update set
            issue_id=excluded.issue_id,
            project_ref=excluded.project_ref,
            run_ref=excluded.run_ref,
            event_type_ref=excluded.event_type_ref,
            payload_ref=excluded.payload_ref,
            source_payload_bytes=excluded.source_payload_bytes,
            source_sha256=excluded.source_sha256,
            event_created_at=excluded.event_created_at
          where event_summary_projection_compact.source_sha256<>excluded.source_sha256
        `, [
          projected.source_event_id,
          projected.issue_id,
          projectRef,
          runRef,
          typeRef,
          payloadRef,
          projected.source_payload_bytes,
          Buffer.from(projected.source_sha256, "hex"),
          projected.event_created_at
        ]);
        if (Number(result.changes) > 0 && projected.source_event_id > watermark.last_event_id) projectedRowCount += 1;
      }
      watermark = saveCompactWatermark(db, {
        lastEventID: rows.at(-1)!.id,
        projectedRowCount,
        updatedAt: projectedAt
      });
    }).immediate();
    batches += 1;
    projectedRows += rows.length;
  }
  const paused = listSourceIssueEvents(db, {
    afterID: watermark.last_event_id,
    hydrateIssueLogs: false,
    limit: 1
  }).length > 0;
  return { batches, paused, projected_rows: projectedRows, watermark };
}

export function clearCompactEventSummaryProjection(db: RunnerDatabase, at = new Date().toISOString()): void {
  db.transaction(() => {
    db.sqlite.run("delete from event_summary_projection_compact");
    db.sqlite.run("delete from event_summary_projection_payloads");
    db.sqlite.run("delete from event_summary_projection_projects");
    db.sqlite.run("delete from event_summary_projection_runs");
    db.sqlite.run("delete from event_summary_projection_types");
    saveCompactWatermark(db, { lastEventID: 0, projectedRowCount: 0, updatedAt: at });
  }).immediate();
}

export function compactProjectionStatus(db: RunnerDatabase): EventProjectionWatermark & {
  lag_rows: number;
  source_last_event_id: number;
  source_of_truth: typeof EVENT_SUMMARY_SOURCE;
  status: "ready" | "lagging";
} {
  const watermark = compactWatermark(db);
  const sourceLastEventID = Number(db.sqlite.query<{ value: number }, []>(
    "select coalesce(max(id), 0) as value from issue_events"
  ).get()?.value ?? 0);
  const lagRows = Number(db.sqlite.query<{ value: number }, [number]>(
    "select count(*) as value from issue_events where id>?"
  ).get(watermark.last_event_id)?.value ?? 0);
  return {
    ...watermark,
    lag_rows: lagRows,
    source_last_event_id: sourceLastEventID,
    source_of_truth: EVENT_SUMMARY_SOURCE,
    status: lagRows === 0 ? "ready" : "lagging"
  };
}

export function eventProjectionStatusForRead(db: RunnerDatabase): ReturnType<typeof eventProjectionStatus> {
  return getEventSummaryProjectionSwitch(db).read_version === "v2"
    ? compactProjectionStatus(db)
    : eventProjectionStatus(db);
}

export function listCompactEventSummaryProjection(
  db: RunnerDatabase,
  filter: EventSummaryProjectionFilter = {}
): EventSummaryProjection[] {
  const query = compactListQuery(filter);
  const payloads = new Map<number, string>();
  const rows = db.sqlite.query<CompactRow, Array<number | string>>(query.sql)
    .all(...query.args)
    .map((row) => mapCompactRow(row, payloads));
  return query.reverseResult ? rows.reverse() : rows;
}

export function listEventSummaryProjectionForRead(
  db: RunnerDatabase,
  filter: EventSummaryProjectionFilter = {},
  now = new Date()
): EventSummaryProjection[] {
  const state = getEventSummaryProjectionSwitch(db);
  const legacy = state.read_version === "v1" || observationActive(state, now)
    ? listEventSummaryProjection(db, filter)
    : undefined;
  const compact = state.read_version === "v2" || observationActive(state, now)
    ? listCompactEventSummaryProjection(db, filter)
    : undefined;
  if (legacy && compact) assertProjectionParity(legacy, compact);
  return state.read_version === "v2" ? compact! : legacy!;
}

export function eventSummaryTypeCountsForRead(
  db: RunnerDatabase,
  now = new Date()
): Array<{ count: number; event_type: string }> {
  const state = getEventSummaryProjectionSwitch(db);
  const readLegacy = () => db.sqlite.query<{ count: number; event_type: string }, []>(`
    select event_type, count(*) as count from event_summary_projection
    group by event_type order by count desc, event_type asc
  `).all();
  const readCompact = () => db.sqlite.query<{ count: number; event_type: string }, []>(`
    select t.event_type, count(*) as count
    from event_summary_projection_compact c
    join event_summary_projection_types t on t.event_type_ref=c.event_type_ref
    group by t.event_type order by count desc, t.event_type asc
  `).all();
  const legacy = state.read_version === "v1" || observationActive(state, now) ? readLegacy() : undefined;
  const compact = state.read_version === "v2" || observationActive(state, now) ? readCompact() : undefined;
  if (legacy && compact && JSON.stringify(legacy) !== JSON.stringify(compact)) {
    throw new Error("event summary projection parity conflict: event type counts differ");
  }
  return state.read_version === "v2" ? compact! : legacy!;
}

export function getEventSummaryProjectionSwitch(db: RunnerDatabase): EventSummaryProjectionSwitch {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`
    select read_version, observation_started_at, observation_expires_at,
      cutover_at, updated_at, revision
    from event_summary_projection_switch where projection_id=?
  `).get(SWITCH_ID);
  if (!row || (row.read_version !== "v1" && row.read_version !== "v2")) {
    throw new Error("event summary projection switch is missing or invalid");
  }
  return {
    cutover_at: String(row.cutover_at ?? ""),
    observation_expires_at: String(row.observation_expires_at ?? ""),
    observation_started_at: String(row.observation_started_at ?? ""),
    read_version: row.read_version,
    revision: Number(row.revision),
    updated_at: String(row.updated_at ?? "")
  };
}

export function updateEventSummaryProjectionSwitch(
  db: RunnerDatabase,
  input: Pick<EventSummaryProjectionSwitch, "cutover_at" | "observation_expires_at" | "observation_started_at" | "read_version"> & {
    expectedRevision: number;
    updatedAt: string;
  }
): EventSummaryProjectionSwitch {
  const result = db.sqlite.run(`
    update event_summary_projection_switch set
      read_version=?, observation_started_at=?, observation_expires_at=?,
      cutover_at=?, updated_at=?, revision=revision+1
    where projection_id=? and revision=?
  `, [
    input.read_version,
    input.observation_started_at,
    input.observation_expires_at,
    input.cutover_at,
    input.updatedAt,
    SWITCH_ID,
    input.expectedRevision
  ]);
  if (Number(result.changes) !== 1) throw new Error("event summary projection switch revision conflict");
  return getEventSummaryProjectionSwitch(db);
}

export function assertProjectionParity(
  legacy: EventSummaryProjection[],
  compact: EventSummaryProjection[]
): void {
  const comparable = (row: EventSummaryProjection) => ({
    ...row,
    projected_at: "",
    source: EVENT_SUMMARY_SOURCE
  });
  if (legacy.length !== compact.length) {
    throw new Error(`event summary projection parity conflict: row count ${legacy.length} != ${compact.length}`);
  }
  for (let index = 0; index < legacy.length; index += 1) {
    if (JSON.stringify(comparable(legacy[index]!)) !== JSON.stringify(comparable(compact[index]!))) {
      throw new Error(`event summary projection parity conflict at source event ${legacy[index]!.source_event_id}`);
    }
  }
}

function compactListQuery(filter: EventSummaryProjectionFilter) {
  const clauses = ["1=1"];
  const args: Array<number | string> = [];
  if (filter.issueID !== undefined) addIntegerFilter(clauses, args, "c.issue_id=?", filter.issueID);
  if (filter.projectID?.trim()) {
    clauses.push("pr.project_id=?");
    args.push(filter.projectID.trim());
  }
  const types = normalizedTypes(filter.types);
  const excluded = normalizedTypes(filter.excludeTypes);
  if (types.length > 0) addTypeFilter(clauses, args, "t.event_type", "in", types);
  if (excluded.length > 0) addTypeFilter(clauses, args, "t.event_type", "not in", excluded);
  if (filter.beforeID !== undefined) addIntegerFilter(clauses, args, "c.source_event_id<?", filter.beforeID);
  if (filter.afterID !== undefined) addIntegerFilter(clauses, args, "c.source_event_id>?", filter.afterID);
  const limit = normalizedLimit(filter.limit);
  const reverseResult = limit !== undefined && filter.afterID === undefined;
  const order = reverseResult ? "c.source_event_id desc" : "c.source_event_id asc";
  if (limit !== undefined) args.push(limit);
  return {
    args,
    reverseResult,
    sql: `select c.source_event_id, c.issue_id, c.payload_ref, pr.project_id, r.run_id,
      t.event_type, p.summary_payload, p.payload_codec, c.source_payload_bytes,
      c.source_sha256, c.event_created_at as created_at
      from event_summary_projection_compact c
      join event_summary_projection_projects pr on pr.project_ref=c.project_ref
      join event_summary_projection_runs r on r.run_ref=c.run_ref
      join event_summary_projection_types t on t.event_type_ref=c.event_type_ref
      join event_summary_projection_payloads p on p.payload_ref=c.payload_ref
      where ${clauses.join(" and ")}
      order by ${order}${limit === undefined ? "" : " limit ?"}`
  };
}

function mapCompactRow(row: CompactRow, payloads: Map<number, string>): EventSummaryProjection {
  const sourceHash = Buffer.from(row.source_sha256);
  if (sourceHash.byteLength !== 32) throw new Error("compact event summary source hash is invalid");
  const payloadRef = Number(row.payload_ref);
  let payload = payloads.get(payloadRef);
  if (payload === undefined) {
    payload = decodePayload(row.summary_payload, Number(row.payload_codec));
    payloads.set(payloadRef, payload);
  }
  const projected = projectSourceIssueEvent({
    created_at: String(row.created_at),
    event_type: String(row.event_type),
    id: Number(row.source_event_id),
    issue_id: Number(row.issue_id),
    payload,
    project_id: String(row.project_id),
    run_id: String(row.run_id)
  }, "");
  return {
    ...projected,
    projected_at: "",
    source_payload_bytes: Number(row.source_payload_bytes),
    source_sha256: sourceHash.toString("hex")
  };
}

function encodePayload(value: string): { bytes: Buffer; codec: 0 | 1 } {
  const raw = Buffer.from(value, "utf8");
  const compressed = deflateRawSync(raw, { level: 6 });
  return compressed.byteLength + 8 < raw.byteLength
    ? { bytes: compressed, codec: 1 }
    : { bytes: raw, codec: 0 };
}

function projectCompactSourceIssueEvent(
  db: RunnerDatabase,
  source: Parameters<typeof projectSourceIssueEvent>[0],
  projectedAt: string,
  storedReferenceEvents: Set<number>
): ReturnType<typeof projectSourceIssueEvent> {
  const stored = projectSourceIssueEvent(source, projectedAt);
  if (source.event_type !== "issue.log" || !source.payload.includes('"issue_log_artifact"')) return stored;
  if (storedReferenceEvents.has(source.id)) return stored;
  const legacy = db.sqlite.query<{ source_payload_bytes: number; source_sha256: string }, [number]>(`
    select source_payload_bytes, source_sha256 from event_summary_projection
    where source='issue_events' and source_event_id=?
  `).get(source.id);
  if (legacy && Number(legacy.source_payload_bytes) === stored.source_payload_bytes &&
      String(legacy.source_sha256) === stored.source_sha256) {
    db.sqlite.run(`insert or ignore into event_summary_projection_compat_modes (
      source_event_id, payload_mode, reason
    ) values (?, 'stored_reference', 'v1_source_identity')`, [source.id]);
    storedReferenceEvents.add(source.id);
    return stored;
  }
  return projectSourceIssueEvent({
    ...source,
    payload: hydrateStoredIssueLogPayload(db, source.payload)
  }, projectedAt);
}

function decodePayload(value: Uint8Array, codec: number): string {
  const bytes = Buffer.from(value);
  if (codec === 0) return bytes.toString("utf8");
  if (codec === 1) return inflateRawSync(bytes).toString("utf8");
  throw new Error(`unsupported compact event summary payload codec: ${codec}`);
}

function dictionaryRef(
  db: RunnerDatabase,
  table: "event_summary_projection_projects" | "event_summary_projection_runs" | "event_summary_projection_types",
  idColumn: "event_type_ref" | "project_ref" | "run_ref",
  valueColumn: "event_type" | "project_id" | "run_id",
  value: string,
  refs: Map<string, number>
): number {
  const known = refs.get(value);
  if (known !== undefined) return known;
  db.sqlite.run(`insert or ignore into ${table} (${valueColumn}) values (?)`, [value]);
  const ref = db.sqlite.query<{ ref: number }, [string]>(
    `select ${idColumn} as ref from ${table} where ${valueColumn}=?`
  ).get(value)?.ref;
  if (!Number.isSafeInteger(ref) || Number(ref) <= 0) throw new Error(`failed to resolve ${table} dictionary ref`);
  refs.set(value, Number(ref));
  return Number(ref);
}

function dictionaryRefs(
  db: RunnerDatabase,
  table: "event_summary_projection_projects" | "event_summary_projection_runs" | "event_summary_projection_types",
  idColumn: "event_type_ref" | "project_ref" | "run_ref",
  valueColumn: "event_type" | "project_id" | "run_id"
): Map<string, number> {
  const rows = db.sqlite.query<{ ref: number; value: string }, []>(
    `select ${idColumn} as ref, ${valueColumn} as value from ${table}`
  ).all();
  return new Map(rows.map((row) => [String(row.value), Number(row.ref)]));
}

function payloadDictionaryRefs(db: RunnerDatabase): Map<string, number> {
  const rows = db.sqlite.query<{ payload_key: Uint8Array; payload_ref: number }, []>(
    "select payload_ref, payload_key from event_summary_projection_payloads"
  ).all();
  return new Map(rows.map((row) => [Buffer.from(row.payload_key).toString("hex"), Number(row.payload_ref)]));
}

function payloadDictionaryRef(
  db: RunnerDatabase,
  payload: string,
  refs: Map<string, number>,
  hashes: Map<string, string>
): number {
  const digest = createHash("sha256").update(payload).digest();
  const payloadKey = digest.subarray(0, 16);
  const key = payloadKey.toString("hex");
  const fullHash = digest.toString("hex");
  const known = refs.get(key);
  if (known !== undefined) {
    const verifiedHash = hashes.get(key);
    if (verifiedHash !== undefined && verifiedHash !== fullHash) {
      throw new Error("compact event summary payload key collision");
    }
    if (verifiedHash === undefined) {
      assertPayloadDictionaryValue(db, known, payload);
      hashes.set(key, fullHash);
    }
    return known;
  }
  const encoded = encodePayload(payload);
  db.sqlite.run(`insert or ignore into event_summary_projection_payloads (
    payload_key, summary_payload, payload_codec
  ) values (?, ?, ?)`, [payloadKey, encoded.bytes, encoded.codec]);
  const ref = db.sqlite.query<{ payload_ref: number }, [Uint8Array]>(
    "select payload_ref from event_summary_projection_payloads where payload_key=?"
  ).get(payloadKey)?.payload_ref;
  if (!Number.isSafeInteger(ref) || Number(ref) <= 0) throw new Error("failed to resolve event summary payload dictionary ref");
  assertPayloadDictionaryValue(db, Number(ref), payload);
  refs.set(key, Number(ref));
  hashes.set(key, fullHash);
  return Number(ref);
}

function assertPayloadDictionaryValue(db: RunnerDatabase, payloadRef: number, expected: string): void {
  const row = db.sqlite.query<{ payload_codec: number; summary_payload: Uint8Array }, [number]>(`
    select summary_payload, payload_codec from event_summary_projection_payloads where payload_ref=?
  `).get(payloadRef);
  if (!row || decodePayload(row.summary_payload, Number(row.payload_codec)) !== expected) {
    throw new Error("compact event summary payload key collision");
  }
}

function compactWatermark(db: RunnerDatabase): EventProjectionWatermark {
  const row = db.sqlite.query<EventProjectionWatermark, [string]>(`
    select projection_id, source, projector_version, last_event_id, projected_row_count, updated_at
    from event_projection_watermarks where projection_id=?
  `).get(COMPACT_EVENT_SUMMARY_PROJECTION_ID);
  if (!row) throw new Error("compact event summary projection watermark is missing");
  return row;
}

function saveCompactWatermark(
  db: RunnerDatabase,
  input: { lastEventID: number; projectedRowCount: number; updatedAt: string }
): EventProjectionWatermark {
  db.sqlite.run(`update event_projection_watermarks set
    source=?, projector_version=?, last_event_id=?, projected_row_count=?, updated_at=?
    where projection_id=?`, [
    EVENT_SUMMARY_SOURCE,
    COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION,
    input.lastEventID,
    input.projectedRowCount,
    input.updatedAt,
    COMPACT_EVENT_SUMMARY_PROJECTION_ID
  ]);
  return compactWatermark(db);
}

function observationActive(state: EventSummaryProjectionSwitch, now: Date): boolean {
  if (!state.observation_started_at || !state.observation_expires_at) return false;
  const current = now.getTime();
  const started = Date.parse(state.observation_started_at);
  const expires = Date.parse(state.observation_expires_at);
  return Number.isFinite(started) && Number.isFinite(expires) && current >= started && current <= expires;
}

function addIntegerFilter(clauses: string[], args: Array<number | string>, sql: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("event projection cursor must be a positive integer");
  clauses.push(sql);
  args.push(value);
}

function addTypeFilter(
  clauses: string[],
  args: Array<number | string>,
  column: string,
  operator: "in" | "not in",
  values: string[]
): void {
  clauses.push(`${column} ${operator} (${values.map(() => "?").join(", ")})`);
  args.push(...values);
}

function normalizedTypes(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("事件摘要 limit 必须是 1 到 500 的整数");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
