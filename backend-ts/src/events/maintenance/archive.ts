import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { listMaintenanceEvents, quickCheck, type MaintenanceEventRow } from "../../db/repositories/eventMaintenance.ts";
import {
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
  EVENT_RETENTION_POLICY_VERSION,
  type ArchiveReceipt,
  type EventRetentionPolicyID
} from "../retentionPolicy.ts";
import type { ArchivedEventRow, CountMap, DatabaseMeasurement, EventArchiveManifest, MaintenanceActor } from "./common.ts";
import {
  EVENT_ARCHIVE_SCHEMA_VERSION, archiveRows, assertSnapshot, atomicWrite, batchSizeValue, databaseReport,
  diskSpace, evaluateRow, existingDatabasePath, increment, manifestChecksum, openReadonly, optionalTimestamp,
  positiveInteger, readChunk, readManifest, rowChecksum, rowsChecksum, saveJSON, scanEvents, scopeKey, timestamp,
  validateActor, verifiedManifest, writeOptionalReport, writeRequiredReport
} from "./common.ts";
import { sha256 } from "../../util/values.ts";

/** Event maintenance step 1: dry-run report, chunked gzip archive with restore rehearsal, and archive verification. */

export function previewEventMaintenance(input: {
  before?: string;
  dbPath: string;
  now?: string;
  reportPath?: string;
}): Record<string, unknown> {
  const now = timestamp(input.now);
  const before = optionalTimestamp(input.before);
  const dbPath = existingDatabasePath(input.dbPath);
  const sqlite = openReadonly(dbPath);
  try {
    const classifications: CountMap = {};
    const actions: CountMap = {};
    const blockers: CountMap = {};
    let scannedRows = 0;
    let scannedPayloadBytes = 0;
    scanEvents(sqlite, before, (row) => {
      const evaluation = evaluateRow(row, now);
      increment(classifications, evaluation.classification.policy_id);
      increment(actions, evaluation.action);
      for (const blocker of evaluation.blockers) increment(blockers, blocker);
      scannedRows += 1;
      scannedPayloadBytes += Buffer.byteLength(row.payload);
    });
    const report = {
      schema_version: "xuanwu.event-maintenance-report.v1",
      operation: "report",
      dry_run: true,
      generated_at: new Date().toISOString(),
      database: databaseReport(dbPath, sqlite),
      selection: { before: before ?? "", now },
      scanned: { rows: scannedRows, payload_bytes: scannedPayloadBytes },
      classifications,
      actions,
      blockers,
      source_of_truth: "issue_events",
      destructive_changes: false
    };
    writeOptionalReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function archiveEventMaintenance(input: {
  actor: MaintenanceActor;
  archiveDir: string;
  batchSize?: number;
  before?: string;
  dbPath: string;
  maxBatches?: number;
  now?: string;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  validateActor(input.actor);
  const dbPath = existingDatabasePath(input.dbPath);
  const archiveDir = resolve(input.archiveDir);
  const batchSize = batchSizeValue(input.batchSize);
  const manifestPath = join(archiveDir, "manifest.json");
  prepareArchiveDirectory(archiveDir, manifestPath, Boolean(input.resume));
  const existingManifest = existsSync(manifestPath) ? readManifest(manifestPath) : undefined;
  const now = timestamp(input.now ?? existingManifest?.selection.now);
  const before = optionalTimestamp(input.before ?? existingManifest?.selection.before);
  const sqlite = openReadonly(dbPath);
  try {
    const source = databaseReport(dbPath, sqlite);
    const snapshot = source.snapshot;
    let manifest = existingManifest ?? newManifest(dbPath, archiveDir, source, now, before, input.actor);
    if (!manifest.space_preflight.passed) throw new Error(
      `archive disk preflight failed: ${manifest.space_preflight.available_bytes} available, ${manifest.space_preflight.required_bytes} required`
    );
    verifyResumeManifest(manifest, { dbPath, source, now, before, actor: input.actor });
    manifest.status = "in_progress";
    saveJSON(manifestPath, manifest);

    let batches = 0;
    let exhausted = false;
    while (!exhausted) {
      const rows = listMaintenanceEvents(sqlite, {
        afterID: manifest.scan_after_event_id,
        before,
        limit: batchSize
      });
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const archived = rows.flatMap((row) => {
        const evaluation = evaluateRow(row, now);
        return evaluation.action === "archive" ? [archiveRow(row, evaluation.classification.policy_id)] : [];
      });
      if (archived.length > 0) addArchiveChunk(archiveDir, manifest, archived);
      manifest.scan_after_event_id = rows.at(-1)!.id;
      saveJSON(manifestPath, manifest);
      batches += 1;
      exhausted = rows.length < batchSize;
      if (!exhausted && input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches")) {
        manifest.status = "paused";
        saveJSON(manifestPath, manifest);
        const paused = archiveReport(dbPath, manifest, true);
        writeRequiredReport(input.reportPath, paused);
        return paused;
      }
    }

    const archivedRows = [...archiveRows(archiveDir, manifest)];
    manifest.watermark = {
      first_event_id: archivedRows[0]?.id ?? 0,
      row_count: archivedRows.length,
      rows_sha256: rowsChecksum(archivedRows),
      through_event_id: archivedRows.at(-1)?.id ?? 0
    };
    const rehearsal = rehearseArchiveRestore(archiveDir, manifest);
    manifest.restore_rehearsal = rehearsal.result;
    manifest.receipts = archiveReceipts(manifest, rehearsal.scopes, input.actor, archiveDir);
    manifest.manifest_sha256 = manifestChecksum(manifest);
    manifest.receipts = manifest.receipts.map((receipt) => ({ ...receipt, manifest_sha256: manifest.manifest_sha256 }));
    manifest.completed_at = new Date().toISOString();
    manifest.status = "complete";
    saveJSON(manifestPath, manifest);
    makeArchiveImmutable(archiveDir, manifest);
    const report = archiveReport(dbPath, manifest, false);
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function verifyEventArchive(input: {
  archiveDir: string;
  reportPath?: string;
  sampleSize?: number;
}): Record<string, unknown> {
  const archiveDir = resolve(input.archiveDir);
  const manifest = verifiedManifest(archiveDir);
  const rows = [...archiveRows(archiveDir, manifest)];
  const sampleSize = Math.min(rows.length, positiveInteger(input.sampleSize ?? 10, "sample size"));
  const report = {
    schema_version: "xuanwu.event-archive-verification.v1",
    operation: "verify_archive",
    verified: true,
    manifest_sha256: manifest.manifest_sha256,
    rows: rows.length,
    rows_sha256: rowsChecksum(rows),
    watermark: manifest.watermark,
    restore_rehearsal: manifest.restore_rehearsal,
    samples: deterministicSamples(rows, sampleSize).map((row) => ({ id: row.id, row_sha256: row.row_sha256 }))
  };
  writeOptionalReport(input.reportPath, report);
  return report;
}

function archiveRow(row: MaintenanceEventRow, policyID: EventRetentionPolicyID): ArchivedEventRow {
  return { ...row, policy_id: policyID, row_sha256: rowChecksum(row, policyID) };
}

function addArchiveChunk(archiveDir: string, manifest: EventArchiveManifest, rows: ArchivedEventRow[]): void {
  const index = manifest.chunks.length + 1;
  const file = `chunks/${String(index).padStart(6, "0")}.jsonl.gz`;
  const content = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const compressed = gzipSync(content, { level: 9 });
  const target = join(archiveDir, file);
  atomicWrite(target, compressed);
  manifest.chunks.push({
    compressed_bytes: compressed.byteLength,
    file,
    first_event_id: rows[0].id,
    payload_bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0),
    row_count: rows.length,
    sha256: sha256(compressed),
    through_event_id: rows.at(-1)!.id
  });
  manifest.totals.rows += rows.length;
  manifest.totals.compressed_bytes += compressed.byteLength;
  manifest.totals.payload_bytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
}

function deterministicSamples(rows: ArchivedEventRow[], count: number): ArchivedEventRow[] {
  if (count === 0) return [];
  if (count === 1) return [rows[0]!];
  const indexes = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.floor(index * (rows.length - 1) / (count - 1)));
  }
  return [...indexes].map((index) => rows[index]!);
}

function makeArchiveImmutable(archiveDir: string, manifest: EventArchiveManifest): void {
  for (const chunk of manifest.chunks) chmodSync(join(archiveDir, chunk.file), 0o400);
  chmodSync(join(archiveDir, "manifest.json"), 0o400);
}

function rehearseArchiveRestore(
  archiveDir: string,
  manifest: EventArchiveManifest
): {
  result: EventArchiveManifest["restore_rehearsal"] & {};
  scopes: Map<string, { first: number; issueID: number; policyID: EventRetentionPolicyID; rows: number; runID: string; through: number }>;
} {
  const restored = new Database(":memory:", { strict: true });
  restored.run(`create table issue_events (
    id integer primary key, issue_id integer not null, type text not null,
    payload text not null, created_at text not null, row_sha256 text not null
  )`);
  const insert = restored.query("insert into issue_events values (?, ?, ?, ?, ?, ?)");
  const scopes = new Map<string, { first: number; issueID: number; policyID: EventRetentionPolicyID; rows: number; runID: string; through: number }>();
  let restoredRows = 0;
  try {
    for (const row of archiveRows(archiveDir, manifest)) {
      insert.run(row.id, row.issue_id, row.event_type, row.payload, row.created_at, row.row_sha256);
      restoredRows += 1;
      const key = scopeKey(row.issue_id, row.run_id, row.policy_id);
      const scope = scopes.get(key) ?? {
        first: row.id, issueID: row.issue_id, policyID: row.policy_id, rows: 0, runID: row.run_id, through: row.id
      };
      scope.first = Math.min(scope.first, row.id);
      scope.through = Math.max(scope.through, row.id);
      scope.rows += 1;
      scopes.set(key, scope);
    }
    const count = Number(restored.query<{ count: number }, []>("select count(*) as count from issue_events").get()?.count ?? 0);
    const integrity = quickCheck(restored);
    if (count !== manifest.totals.rows || restoredRows !== manifest.totals.rows || integrity !== "ok") {
      throw new Error("archive restore rehearsal did not reproduce all rows");
    }
    return {
      result: { checked_at: new Date().toISOString(), quick_check: integrity, restored_rows: restoredRows, status: "passed" },
      scopes
    };
  } finally {
    restored.close();
  }
}

function archiveReceipts(
  manifest: EventArchiveManifest,
  scopes: ReturnType<typeof rehearseArchiveRestore>["scopes"],
  actor: MaintenanceActor,
  archiveDir: string
): ArchiveReceipt[] {
  const restoredAt = manifest.restore_rehearsal!.checked_at;
  return [...scopes.values()].map((scope) => ({
    actor_id: actor.actor,
    archive_ref: `file:${resolve(archiveDir)}`,
    audit_event_ref: actor.auditRef,
    contiguous: true,
    first_event_id: scope.first,
    issue_id: scope.issueID,
    manifest_sha256: manifest.manifest_sha256,
    policy_id: scope.policyID,
    policy_version: EVENT_RETENTION_POLICY_VERSION,
    reason: actor.reason,
    restored_at: restoredAt,
    row_count: scope.rows,
    run_id: scope.runID,
    schema_version: ARCHIVE_RECEIPT_SCHEMA_VERSION,
    source: "issue_events",
    through_event_id: scope.through,
    verified_at: restoredAt,
    verifier: "deterministic_retention_worker"
  }));
}

function newManifest(
  dbPath: string,
  archiveDir: string,
  source: DatabaseMeasurement,
  now: string,
  before: string | undefined,
  actor: MaintenanceActor
): EventArchiveManifest {
  return {
    archive_ref: `file:${archiveDir}`,
    audit: actor,
    chunks: [],
    completed_at: "",
    created_at: new Date().toISOString(),
    manifest_sha256: "",
    policy_version: EVENT_RETENTION_POLICY_VERSION,
    receipts: [],
    restore_rehearsal: null,
    scan_after_event_id: 0,
    schema_version: EVENT_ARCHIVE_SCHEMA_VERSION,
    selection: { before: before ?? "", now },
    source: { db_file: basename(dbPath), ...source },
    status: "in_progress",
    totals: { compressed_bytes: 0, payload_bytes: 0, rows: 0 },
    watermark: { first_event_id: 0, row_count: 0, rows_sha256: sha256(""), through_event_id: 0 },
    space_preflight: diskSpace(archiveDir, source.file_bytes * 2)
  };
}

function verifyResumeManifest(
  manifest: EventArchiveManifest,
  expected: { actor: MaintenanceActor; before?: string; dbPath: string; now: string; source: DatabaseMeasurement }
): void {
  if (manifest.schema_version !== EVENT_ARCHIVE_SCHEMA_VERSION || manifest.policy_version !== EVENT_RETENTION_POLICY_VERSION) {
    throw new Error("archive manifest version mismatch");
  }
  if (manifest.status === "complete") throw new Error("archive is already complete");
  if (manifest.source.db_file !== basename(expected.dbPath) || manifest.selection.now !== expected.now ||
    manifest.selection.before !== (expected.before ?? "") || JSON.stringify(manifest.audit) !== JSON.stringify(expected.actor)) {
    throw new Error("resume arguments do not match archive manifest");
  }
  assertSnapshot("archive resume", manifest.source.snapshot, expected.source.snapshot);
  if (manifest.source.file_bytes !== expected.source.file_bytes || manifest.source.quick_check !== expected.source.quick_check ||
    JSON.stringify(manifest.source.space) !== JSON.stringify(expected.source.space)) {
    throw new Error("archive resume database measurement changed");
  }
  for (const chunk of manifest.chunks) readChunk(resolve(manifest.archive_ref.replace(/^file:/, "")), chunk);
}

function archiveReport(dbPath: string, manifest: EventArchiveManifest, paused: boolean): Record<string, unknown> {
  return {
    schema_version: "xuanwu.event-maintenance-report.v1",
    operation: "archive",
    dry_run: false,
    paused,
    generated_at: new Date().toISOString(),
    database: { path: dbPath, ...manifest.source },
    archive: {
      ref: manifest.archive_ref,
      manifest_sha256: manifest.manifest_sha256,
      chunks: manifest.chunks.length,
      compressed_bytes: manifest.totals.compressed_bytes,
      rows: manifest.totals.rows,
      payload_bytes: manifest.totals.payload_bytes,
      restore_rehearsal: manifest.restore_rehearsal,
      status: manifest.status
    },
    source_of_truth: "issue_events",
    archive_role: "shadow_archive",
    source_rows_deleted: 0
  };
}

function prepareArchiveDirectory(archiveDir: string, manifestPath: string, resume: boolean): void {
  if (existsSync(manifestPath) && !resume) throw new Error("archive manifest already exists; pass --resume to continue");
  if (!existsSync(manifestPath) && resume) throw new Error("archive manifest does not exist for --resume");
  mkdirSync(join(archiveDir, "chunks"), { recursive: true, mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  chmodSync(join(archiveDir, "chunks"), 0o700);
}
