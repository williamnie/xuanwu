import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  countExistingIssueEvents,
  currentIssueEventRows,
  issueEventSnapshot,
  quickCheck,
  restoreIssueEventBatch
} from "../../db/repositories/eventMaintenance.ts";
import type { ArchivedEventRow, DatabaseMeasurement, MaintenanceActor } from "./common.ts";
import {
  archiveRows,
  audit,
  batchSizeValue,
  databaseReport,
  existingDatabasePath,
  openReadonly,
  openWritable,
  positiveInteger,
  requireWriteConfirmations,
  rowChecksum,
  saveJSON,
  validateActor,
  verifiedManifest,
  writeRequiredReport
} from "./common.ts";
import { readCheckpoint, missingArchiveRows, newCheckpoint, verifyCheckpoint } from "./deletionEvidence.ts";
import { type MaintenanceCheckpoint } from "./deletionModel.ts";

export function restoreArchivedEvents(input: {
  actor: MaintenanceActor;
  apply?: boolean;
  archiveDir: string;
  batchSize?: number;
  checkpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  maxBatches?: number;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  validateActor(input.actor);
  const dbPath = existingDatabasePath(input.dbPath);
  const archiveDir = resolve(input.archiveDir);
  const manifest = verifiedManifest(archiveDir);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  try {
    const beforeMeasurement = databaseReport(dbPath, sqlite);
    const before = beforeMeasurement.snapshot;
    const checkpointPath = resolve(input.checkpointPath);
    let checkpoint = input.resume ? readCheckpoint(checkpointPath, "restore") : undefined;
    if (!checkpoint) {
      const missingIDs = missingArchiveRows(sqlite, archiveDir, manifest);
      checkpoint = newCheckpoint("restore", manifest.manifest_sha256, "", missingIDs);
    } else {
      verifyCheckpoint(checkpoint, manifest.manifest_sha256, "");
    }
    if (!input.apply) {
      const report = restoreReport(dbPath, beforeMeasurement, beforeMeasurement, checkpoint, false, false);
      writeRequiredReport(input.reportPath, report);
      return report;
    }
    requireWriteConfirmations(input);
    if (!input.resume && existsSync(checkpointPath)) throw new Error("checkpoint already exists; pass --resume or choose a new checkpoint path");
    saveJSON(checkpointPath, checkpoint);
    const remainingIDs = checkpoint.event_ids.slice(checkpoint.cursor);
    const missingAtStart = remainingIDs.length - countExistingIssueEvents(sqlite, remainingIDs);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.restore_started", "allow", { restore_rows: checkpoint.event_ids.length, manifest: manifest.manifest_sha256 });

    const wanted = new Set(checkpoint.event_ids.slice(checkpoint.cursor));
    const batchSize = batchSizeValue(input.batchSize);
    let pending: ArchivedEventRow[] = [];
    let batches = 0;
    for (const row of archiveRows(archiveDir, manifest)) {
      if (!wanted.has(row.id)) continue;
      pending.push(row);
      if (pending.length < batchSize) continue;
      restoreArchiveBatch(sqlite, pending);
      checkpoint.cursor += pending.length;
      pending = [];
      saveJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
        checkpoint.cursor < checkpoint.event_ids.length) {
        checkpoint.status = "paused";
        saveJSON(checkpointPath, checkpoint);
        audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
          "event_maintenance.restore_paused", "allow", { restored_rows: checkpoint.cursor });
        const paused = restoreReport(dbPath, beforeMeasurement, databaseReport(dbPath, sqlite), checkpoint, true, true);
        writeRequiredReport(input.reportPath, paused);
        return paused;
      }
    }
    if (pending.length > 0) {
      restoreArchiveBatch(sqlite, pending);
      checkpoint.cursor += pending.length;
    }
    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    saveJSON(checkpointPath, checkpoint);
    const after = issueEventSnapshot(sqlite);
    if (after.issue_event_count - before.issue_event_count !== missingAtStart) {
      throw new Error("post-restore row count does not match checkpoint");
    }
    if (missingArchiveRows(sqlite, archiveDir, manifest).length !== 0) {
      throw new Error("post-restore archive rows are still missing");
    }
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-restore quick_check failed: ${integrity}`);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.restore_completed", "allow", { restored_rows: checkpoint.cursor, quick_check: integrity });
    const report = restoreReport(dbPath, beforeMeasurement, databaseReport(dbPath, sqlite), checkpoint, true, false);
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

function restoreArchiveBatch(sqlite: Database, rows: ArchivedEventRow[]): number {
  const current = currentIssueEventRows(sqlite, rows.map((row) => row.id));
  const byID = new Map(current.map((row) => [row.id, row]));
  const missing = rows.filter((row) => {
    const existing = byID.get(row.id);
    if (!existing) return true;
    if (rowChecksum(existing, row.policy_id) !== row.row_sha256) {
      throw new Error(`restore target conflict for issue_events:${row.id}`);
    }
    return false;
  });
  return restoreIssueEventBatch(sqlite, missing);
}

function restoreReport(
  dbPath: string,
  before: DatabaseMeasurement,
  after: DatabaseMeasurement,
  checkpoint: MaintenanceCheckpoint,
  applied: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.event-maintenance-report.v1",
    operation: "restore",
    dry_run: !applied,
    paused,
    generated_at: new Date().toISOString(),
    database: { path: dbPath, before, after },
    restore_rows: checkpoint.event_ids.length,
    restored_rows: applied ? checkpoint.cursor : 0,
    checkpoint: { status: checkpoint.status, cursor: checkpoint.cursor, total: checkpoint.event_ids.length },
    source_of_truth: "issue_events"
  };
}
