import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { issueEventSnapshot, quickCheck } from "../db/repositories/eventMaintenance.ts";
import { hydrateStoredIssueLogPayloadStrict, persistPlannedIssueLogArtifact } from "../db/repositories/issueEvents.ts";
import {
  type MaintenanceActor,
  nonNegativeInteger,
  DEFAULT_ISSUE_LOG_COMPACTION_MINIMUM_SAVINGS_BYTES,
  positiveInteger,
  sum
} from "./payloadCompactionServiceModel.ts";
import {
  existingDatabasePath,
  openDatabase,
  readCheckpoint,
  writeJSON,
  requireWriteAuthorization,
  saveJSON,
  audit,
  payloadRows,
  updatePayloadBatch,
  restorePayloadBatch
} from "./payloadCompactionServiceStorage.ts";
import {
  newCompactionCheckpoint,
  scanCompactionPlan,
  requiredPlan,
  newRestoreCheckpoint
} from "./payloadCompactionServicePlan.ts";
import {
  verifyCompactionCheckpoint,
  compactionReport,
  verifyRestoreCheckpoint,
  restoreReport
} from "./payloadCompactionServiceReports.ts";

export function compactHistoricalIssueLogPayloads(input: {
  actor?: MaintenanceActor;
  apply?: boolean;
  batchSize?: number;
  checkpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  maxBatches?: number;
  minimumSavingsBytes?: number;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  const dbPath = existingDatabasePath(input.dbPath);
  const checkpointPath = resolve(input.checkpointPath);
  const minimumSavingsBytes = nonNegativeInteger(
    input.minimumSavingsBytes ?? DEFAULT_ISSUE_LOG_COMPACTION_MINIMUM_SAVINGS_BYTES,
    "minimum savings bytes"
  );
  const sqlite = openDatabase(dbPath, Boolean(input.apply));
  try {
    const before = issueEventSnapshot(sqlite);
    const checkpoint = input.resume
      ? readCheckpoint(checkpointPath, "compact")
      : newCompactionCheckpoint(dbPath, before, scanCompactionPlan(sqlite, dbPath, minimumSavingsBytes), minimumSavingsBytes);
    verifyCompactionCheckpoint(checkpoint, dbPath, before, minimumSavingsBytes, Boolean(input.resume));

    if (!input.apply) {
      const report = compactionReport(dbPath, before, before, checkpoint, true, false);
      writeJSON(resolve(input.reportPath), report);
      return report;
    }

    requireWriteAuthorization(input.actor, input.confirmBackupTested, input.confirmNoActiveWriters);
    if (!input.resume && existsSync(checkpointPath)) {
      throw new Error("checkpoint already exists; pass --resume or choose a new checkpoint path");
    }
    saveJSON(checkpointPath, checkpoint);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.started", {
      candidate_rows: checkpoint.plan.candidate_rows,
      minimum_savings_bytes: minimumSavingsBytes
    });

    const batchSize = positiveInteger(input.batchSize ?? 250, "batch size");
    let batches = 0;
    while (checkpoint.cursor < checkpoint.event_ids.length) {
      const ids = checkpoint.event_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      const rows = payloadRows(sqlite, ids);
      if (rows.length !== ids.length) throw new Error("compaction candidate rows changed after checkpoint creation");
      const planned = rows.map((row) => ({
        id: row.id,
        plan: requiredPlan(row, minimumSavingsBytes)
      }));
      for (const item of planned) {
        if (persistPlannedIssueLogArtifact({ path: dbPath }, item.plan)) {
          checkpoint.applied.artifacts_created += 1;
          checkpoint.applied.artifact_bytes_created += item.plan.artifact.stored_bytes;
        }
      }
      updatePayloadBatch(sqlite, planned);
      checkpoint.applied.source_payload_bytes += sum(planned.map((item) => item.plan.original_bytes));
      checkpoint.applied.stored_payload_bytes += sum(planned.map((item) => item.plan.stored_bytes));
      checkpoint.cursor += planned.length;
      checkpoint.status = "in_progress";
      saveJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
        checkpoint.cursor < checkpoint.event_ids.length) {
        checkpoint.status = "paused";
        saveJSON(checkpointPath, checkpoint);
        audit(sqlite, input.actor!, "issue_log_payload_compaction.paused", { compacted_rows: checkpoint.cursor });
        const report = compactionReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, true);
        writeJSON(resolve(input.reportPath), report);
        return report;
      }
    }

    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    saveJSON(checkpointPath, checkpoint);
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-compaction quick_check failed: ${integrity}`);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.completed", {
      compacted_rows: checkpoint.cursor,
      quick_check: integrity
    });
    const report = compactionReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, false);
    writeJSON(resolve(input.reportPath), report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function restoreHistoricalIssueLogPayloads(input: {
  actor?: MaintenanceActor;
  apply?: boolean;
  batchSize?: number;
  checkpointPath: string;
  compactionCheckpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  maxBatches?: number;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  const dbPath = existingDatabasePath(input.dbPath);
  const sourcePath = resolve(input.compactionCheckpointPath);
  const source = readCheckpoint(sourcePath, "compact");
  const restoreIDs = source.event_ids.slice(0, source.cursor);
  const checkpointPath = resolve(input.checkpointPath);
  const sqlite = openDatabase(dbPath, Boolean(input.apply));
  try {
    const before = issueEventSnapshot(sqlite);
    const checkpoint = input.resume
      ? readCheckpoint(checkpointPath, "restore")
      : newRestoreCheckpoint(dbPath, before, sourcePath, restoreIDs, source.minimum_savings_bytes);
    verifyRestoreCheckpoint(checkpoint, dbPath, sourcePath, restoreIDs, Boolean(input.resume));

    if (!input.apply) {
      const report = restoreReport(dbPath, before, before, checkpoint, true, false);
      writeJSON(resolve(input.reportPath), report);
      return report;
    }

    requireWriteAuthorization(input.actor, input.confirmBackupTested, input.confirmNoActiveWriters);
    if (!input.resume && existsSync(checkpointPath)) {
      throw new Error("checkpoint already exists; pass --resume or choose a new checkpoint path");
    }
    saveJSON(checkpointPath, checkpoint);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.restore_started", {
      restore_rows: checkpoint.event_ids.length,
      source_checkpoint: sourcePath
    });

    const batchSize = positiveInteger(input.batchSize ?? 250, "batch size");
    let batches = 0;
    while (checkpoint.cursor < checkpoint.event_ids.length) {
      const ids = checkpoint.event_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      const rows = payloadRows(sqlite, ids);
      if (rows.length !== ids.length) throw new Error("restore candidate rows changed after checkpoint creation");
      const hydrated = rows.map((row) => ({
        id: row.id,
        original: hydrateStoredIssueLogPayloadStrict({ path: dbPath }, row.payload),
        stored: row.payload
      }));
      restorePayloadBatch(sqlite, hydrated);
      checkpoint.applied.source_payload_bytes += sum(hydrated.map((item) => Buffer.byteLength(item.original)));
      checkpoint.applied.stored_payload_bytes += sum(hydrated.map((item) => Buffer.byteLength(item.stored)));
      checkpoint.cursor += hydrated.length;
      checkpoint.status = "in_progress";
      saveJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
        checkpoint.cursor < checkpoint.event_ids.length) {
        checkpoint.status = "paused";
        saveJSON(checkpointPath, checkpoint);
        audit(sqlite, input.actor!, "issue_log_payload_compaction.restore_paused", { restored_rows: checkpoint.cursor });
        const report = restoreReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, true);
        writeJSON(resolve(input.reportPath), report);
        return report;
      }
    }

    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    saveJSON(checkpointPath, checkpoint);
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-restore quick_check failed: ${integrity}`);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.restore_completed", {
      quick_check: integrity,
      restored_rows: checkpoint.cursor
    });
    const report = restoreReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, false);
    writeJSON(resolve(input.reportPath), report);
    return report;
  } finally {
    sqlite.close();
  }
}
