import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { listMaintenanceEvents } from "../../db/repositories/eventMaintenance.ts";
import type { CountMap, MaintenanceActor } from "./common.ts";
import {
  archiveRows,
  batchSizeValue,
  databaseReport,
  evaluateRow,
  existingDatabasePath,
  increment,
  manifestChecksum,
  openReadonly,
  optionalTimestamp,
  positiveInteger,
  readManifest,
  rowsChecksum,
  saveJSON,
  scanEvents,
  timestamp,
  validateActor,
  writeOptionalReport,
  writeRequiredReport
} from "./common.ts";
import { prepareArchiveDirectory, newManifest, verifyResumeManifest, archiveReport } from "./archiveManifest.ts";
import {
  archiveRow,
  addArchiveChunk,
  rehearseArchiveRestore,
  archiveReceipts,
  makeArchiveImmutable
} from "./archiveVerification.ts";

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

export { verifyEventArchive } from "./archiveVerification.ts";
