import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  databaseSpaceStats,
  issueEventSnapshot,
  listMaintenanceEvents,
  quickCheck,
  recordMaintenanceAudit,
  type DatabaseSpaceStats,
  type IssueEventSnapshot,
  type MaintenanceEventRow
} from "../../db/repositories/eventMaintenance.ts";
import { sha256 } from "../../util/values.ts";
import {
  evaluateEventRetention,
  type ArchiveReceipt,
  type EventRetentionPolicyID,
  type RetainedEvent
} from "../retentionPolicy.ts";

/** Event maintenance shared contracts: archive manifest/row formats, retention evaluation, guarded file and DB I/O. */

export const EVENT_ARCHIVE_SCHEMA_VERSION = "xuanwu.issue-events-archive.v1" as const;

export type MaintenanceActor = { actor: string; auditRef: string; reason: string };

type ArchiveChunk = {
  compressed_bytes: number;
  file: string;
  first_event_id: number;
  payload_bytes: number;
  row_count: number;
  sha256: string;
  through_event_id: number;
};

export type ArchivedEventRow = MaintenanceEventRow & {
  policy_id: EventRetentionPolicyID;
  row_sha256: string;
};

export type EventArchiveManifest = {
  archive_ref: string;
  audit: MaintenanceActor;
  chunks: ArchiveChunk[];
  completed_at: string;
  created_at: string;
  manifest_sha256: string;
  policy_version: string;
  receipts: ArchiveReceipt[];
  restore_rehearsal: { checked_at: string; quick_check: string; restored_rows: number; status: "passed" } | null;
  scan_after_event_id: number;
  schema_version: typeof EVENT_ARCHIVE_SCHEMA_VERSION;
  selection: { before: string; now: string };
  source: {
    db_file: string;
    file_bytes: number;
    quick_check: string;
    snapshot: IssueEventSnapshot;
    space: DatabaseSpaceStats;
  };
  status: "in_progress" | "paused" | "complete";
  totals: { compressed_bytes: number; payload_bytes: number; rows: number };
  watermark: { first_event_id: number; row_count: number; rows_sha256: string; through_event_id: number };
  space_preflight: { available_bytes: number; passed: boolean; required_bytes: number };
};

export type CountMap = Record<string, number>;

export type DatabaseMeasurement = {
  file_bytes: number;
  quick_check: string;
  snapshot: IssueEventSnapshot;
  space: DatabaseSpaceStats;
};

export function rowChecksum(row: MaintenanceEventRow, policyID: EventRetentionPolicyID): string {
  return sha256(JSON.stringify([
    row.id, row.issue_id, row.project_id, row.event_type, row.payload, row.created_at,
    row.raw_method, row.run_id, row.run_status, policyID
  ]));
}

export function rowsChecksum(rows: ArchivedEventRow[]): string {
  return sha256(rows.map((row) => `${row.id}:${row.row_sha256}`).join("\n"));
}

export function* archiveRows(archiveDir: string, manifest: EventArchiveManifest): Generator<ArchivedEventRow> {
  for (const chunk of manifest.chunks) yield* readChunk(archiveDir, chunk);
}

export function readChunk(archiveDir: string, chunk: ArchiveChunk): ArchivedEventRow[] {
  const compressed = readFileSync(join(archiveDir, chunk.file));
  if (sha256(compressed) !== chunk.sha256) throw new Error(`archive chunk checksum mismatch: ${chunk.file}`);
  const rows = gunzipSync(compressed).toString("utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as ArchivedEventRow);
  if (rows.length !== chunk.row_count) throw new Error(`archive chunk row count mismatch: ${chunk.file}`);
  for (const row of rows) {
    if (rowChecksum(row, row.policy_id) !== row.row_sha256) throw new Error(`archive row checksum mismatch: issue_events:${row.id}`);
  }
  return rows;
}

export function verifiedManifest(archiveDir: string): EventArchiveManifest {
  const manifest = readManifest(join(archiveDir, "manifest.json"));
  if (manifest.status !== "complete" || !manifest.restore_rehearsal || manifest.restore_rehearsal.status !== "passed") {
    throw new Error("archive is not complete with a successful restore rehearsal");
  }
  if (manifest.manifest_sha256 !== manifestChecksum(manifest)) throw new Error("archive manifest checksum mismatch");
  for (const chunk of manifest.chunks) readChunk(archiveDir, chunk);
  return manifest;
}

export function evaluateRow(row: MaintenanceEventRow, now: string) {
  return evaluateEventRetention({
    event: retainedEvent(row),
    now,
    run: row.run_id ? { id: row.run_id, status: row.run_status } : undefined
  });
}

export function retainedEvent(row: MaintenanceEventRow): RetainedEvent {
  return {
    created_at: row.created_at,
    event_type: row.event_type,
    id: row.id,
    issue_id: row.issue_id,
    issue_status: row.issue_status,
    project_id: row.project_id,
    raw_method: row.raw_method,
    run_id: row.run_id || undefined,
    source: "issue_events"
  };
}

export function scanEvents(sqlite: Database, before: string | undefined, visit: (row: MaintenanceEventRow) => void): void {
  let afterID = 0;
  while (true) {
    const rows = listMaintenanceEvents(sqlite, { afterID, before, limit: 1000 });
    for (const row of rows) visit(row);
    if (rows.length < 1000) return;
    afterID = rows.at(-1)!.id;
  }
}

export function manifestChecksum(manifest: EventArchiveManifest): string {
  return sha256(JSON.stringify({
    archive_ref: manifest.archive_ref,
    audit: manifest.audit,
    chunks: manifest.chunks,
    policy_version: manifest.policy_version,
    receipts: manifest.receipts.map((receipt) => ({ ...receipt, manifest_sha256: "" })),
    restore_rehearsal: manifest.restore_rehearsal,
    scan_after_event_id: manifest.scan_after_event_id,
    schema_version: manifest.schema_version,
    selection: manifest.selection,
    source: manifest.source,
    totals: manifest.totals,
    watermark: manifest.watermark,
    space_preflight: manifest.space_preflight
  }));
}

export function databaseReport(path: string, sqlite: Database): DatabaseMeasurement {
  return {
    file_bytes: statSync(path).size,
    quick_check: quickCheck(sqlite),
    snapshot: issueEventSnapshot(sqlite),
    space: databaseSpaceStats(sqlite)
  };
}

export function diskSpace(path: string, requiredBytes: number): { available_bytes: number; passed: boolean; required_bytes: number } {
  const stats = statfsSync(path);
  const available = Number(stats.bavail) * Number(stats.bsize);
  return { available_bytes: available, passed: available >= requiredBytes, required_bytes: requiredBytes };
}

export function requireDiskSpace(path: string, requiredBytes: number, label: string): void {
  const check = diskSpace(path, requiredBytes);
  if (!check.passed) throw new Error(`${label} disk preflight failed: ${check.available_bytes} available, ${check.required_bytes} required`);
}

export function audit(
  sqlite: Database,
  actionID: string,
  actor: string,
  reason: string,
  eventType: string,
  decision: string,
  result: Record<string, unknown>
): void {
  recordMaintenanceAudit(sqlite, { actionID, actor, decision, eventType, reason, result });
}

export function readManifest(path: string): EventArchiveManifest {
  return JSON.parse(readFileSync(path, "utf8")) as EventArchiveManifest;
}

export function writeOptionalReport(path: string | undefined, value: unknown): void {
  if (path) writeRequiredReport(path, value);
}

export function writeRequiredReport(path: string, value: unknown): void {
  if (!path.trim()) throw new Error("--report is required");
  saveJSON(resolve(path), value);
}

export function saveJSON(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWrite(path: string, value: string | Buffer): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function openReadonly(path: string): Database {
  const sqlite = new Database(path, { readonly: true, strict: true });
  sqlite.run("pragma query_only=on");
  return sqlite;
}

export function openWritable(path: string): Database {
  const sqlite = new Database(path, { create: false, readwrite: true, strict: true });
  sqlite.run("pragma foreign_keys=on");
  return sqlite;
}

export function existingDatabasePath(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`database file does not exist: ${absolute}`);
  return absolute;
}

export function timestamp(value: string | undefined): string {
  const result = value?.trim() || new Date().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error(`invalid timestamp: ${result}`);
  return result;
}

export function optionalTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return timestamp(value);
}

export function validateActor(actor: MaintenanceActor): void {
  if (!actor.actor.trim() || !actor.reason.trim() || !actor.auditRef.trim()) {
    throw new Error("actor, reason, and audit ref are required");
  }
  if (actor.actor.trim().toLowerCase() === "llm") throw new Error("LLM cannot authorize maintenance writes");
}

export function requireWriteConfirmations(input: { confirmBackupTested?: boolean; confirmNoActiveWriters?: boolean }): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
}

export function assertSnapshot(label: string, expected: IssueEventSnapshot, actual: IssueEventSnapshot): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${label} source snapshot changed`);
}

export function batchSizeValue(value: number | undefined): number {
  const result = value ?? 500;
  if (!Number.isSafeInteger(result) || result < 1 || result > 5000) throw new Error("batch size must be from 1 to 5000");
  return result;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function increment(counts: CountMap, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}


export function scopeKey(issueID: number, runID: string, policyID: EventRetentionPolicyID): string {
  return `${issueID}\u0000${runID}\u0000${policyID}`;
}
