import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { RunnerDatabase } from "../database.ts";
import { hydrateStoredIssueLogPayload } from "./issueEvents.ts";
import { EVENT_SUMMARY_SOURCE, type EventProjectionWatermark } from "./eventSummaryProjection.ts";
import { projectSourceIssueEvent } from "../../events/eventSummaryProjector.ts";
import {
  COMPACT_EVENT_SUMMARY_PROJECTION_ID,
  COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION
} from "./compactEventSummaryProjectionModel.ts";

function encodePayload(value: string): { bytes: Buffer; codec: 0 | 1 } {
  const raw = Buffer.from(value, "utf8");
  const compressed = deflateRawSync(raw, { level: 6 });
  return compressed.byteLength + 8 < raw.byteLength
    ? { bytes: compressed, codec: 1 }
    : { bytes: raw, codec: 0 };
}

export function projectCompactSourceIssueEvent(
  db: RunnerDatabase,
  source: Parameters<typeof projectSourceIssueEvent>[0],
  projectedAt: string,
  storedReferenceEvents: Set<number>
): ReturnType<typeof projectSourceIssueEvent> {
  const stored = projectSourceIssueEvent(source, projectedAt);
  if (source.event_type !== "issue.log" || !source.payload.includes('"issue_log_artifact"')) return stored;
  if (storedReferenceEvents.has(source.id)) return stored;
  if (db.sqlite.query<{ source_event_id: number }, [number]>(
    "select source_event_id from event_summary_projection_compat_modes where source_event_id=? and payload_mode='stored_reference'"
  ).get(source.id)) {
    storedReferenceEvents.add(source.id);
    return stored;
  }
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

export function decodePayload(value: Uint8Array, codec: number): string {
  const bytes = Buffer.from(value);
  if (codec === 0) return bytes.toString("utf8");
  if (codec === 1) return inflateRawSync(bytes).toString("utf8");
  throw new Error(`unsupported compact event summary payload codec: ${codec}`);
}

export function dictionaryRef(
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

export function payloadDictionaryRef(
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
  const existing = db.sqlite.query<{ payload_ref: number }, [Uint8Array]>(
    "select payload_ref from event_summary_projection_payloads where payload_key=?"
  ).get(payloadKey);
  if (existing) {
    assertPayloadDictionaryValue(db, Number(existing.payload_ref), payload);
    refs.set(key, Number(existing.payload_ref));
    hashes.set(key, fullHash);
    return Number(existing.payload_ref);
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

export function compactWatermark(db: RunnerDatabase): EventProjectionWatermark {
  const row = db.sqlite.query<EventProjectionWatermark, [string]>(`
    select projection_id, source, projector_version, last_event_id, projected_row_count, updated_at
    from event_projection_watermarks where projection_id=?
  `).get(COMPACT_EVENT_SUMMARY_PROJECTION_ID);
  if (!row) throw new Error("compact event summary projection watermark is missing");
  return row;
}

export function saveCompactWatermark(
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
