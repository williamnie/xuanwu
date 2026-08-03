import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  databaseSpaceStats,
  countExistingIssueEvents,
  currentIssueEventRows,
  deleteIssueEventBatch,
  issueEventSnapshot,
  listMaintenanceEvents,
  quickCheck,
  recordMaintenanceAudit,
  restoreIssueEventBatch,
  runVacuum,
  walCheckpoint,
  type DatabaseSpaceStats,
  type IssueEventSnapshot,
  type MaintenanceEventRow
} from "../db/repositories/eventMaintenance.ts";
import { sqliteObjectUsage } from "../db/sqliteObjectUsage.ts";
import {
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
  DEFAULT_EVENT_RETENTION_CONFIG,
  EVENT_RETENTION_POLICY_VERSION,
  evaluateEventRetention,
  validateEventRetentionConfig,
  type ArchiveReceipt,
  type DestructiveGate,
  type EventRetentionConfig,
  type EventRetentionPolicyID,
  type RetainedEvent,
  type RetentionHold,
  type RetentionReferenceState,
  type SummaryWatermark
} from "./retentionPolicy.ts";

export const EVENT_ARCHIVE_SCHEMA_VERSION = "xuanwu.issue-events-archive.v1" as const;
export const EVENT_DELETE_EVIDENCE_SCHEMA_VERSION = "xuanwu.event-maintenance-delete-evidence.v1" as const;
export const EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION = "xuanwu.event-maintenance-checkpoint.v1" as const;

type MaintenanceActor = { actor: string; auditRef: string; reason: string };
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

export type EventDeleteEvidence = {
  archive_manifest_sha256: string;
  backup: { created_at: string; db_file: string; quick_check: "ok"; restored_at: string; verified_at: string };
  config: EventRetentionConfig;
  consumer_zero: { compact_last_event_id: number; projection_read_version: "v2"; verified_at: string };
  correlation_id: string;
  holds: RetentionHold[];
  schema_version: typeof EVENT_DELETE_EVIDENCE_SCHEMA_VERSION;
  scopes: Array<{
    destructive_gate: DestructiveGate;
    issue_id: number;
    policy_id: EventRetentionPolicyID;
    references: RetentionReferenceState;
    run_id: string;
    summary_watermark: SummaryWatermark;
  }>;
  source_snapshot: IssueEventSnapshot;
  writer_quiesce: { active_writers: 0; confirmed_by: string; verified_at: string };
};

type MaintenanceCheckpoint = {
  archive_manifest_sha256: string;
  blockers: CountMap;
  completed_at: string;
  created_at: string;
  cursor: number;
  evidence_sha256: string;
  event_ids: number[];
  operation: "delete" | "restore";
  schema_version: typeof EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION;
  status: "in_progress" | "paused" | "complete";
};

type CountMap = Record<string, number>;
type DatabaseMeasurement = {
  file_bytes: number;
  quick_check: string;
  snapshot: IssueEventSnapshot;
  space: DatabaseSpaceStats;
};

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

export function prepareEventDeleteEvidence(input: {
  actor: MaintenanceActor & { actorKind: "retention_worker" | "system" | "user" };
  archiveDir: string;
  backupDbPath: string;
  correlationID: string;
  dbPath: string;
  holdsPath?: string;
  now?: string;
  outputPath: string;
}): Record<string, unknown> {
  validateActor(input.actor);
  if (!input.correlationID.trim()) throw new Error("correlation id is required");
  const now = timestamp(input.now);
  const archiveDir = resolve(input.archiveDir);
  const manifest = verifiedManifest(archiveDir);
  const dbPath = existingDatabasePath(input.dbPath);
  const backupPath = existingDatabasePath(input.backupDbPath);
  if (dbPath === backupPath) throw new Error("backup must be a distinct recoverable database copy");
  const sqlite = openWritable(dbPath);
  const backup = openReadonly(backupPath);
  try {
    sqlite.transaction(() => sqlite.query("select 1").get()).immediate();
    assertSnapshot("archive", manifest.source.snapshot, issueEventSnapshot(sqlite));
    assertSnapshot("backup", manifest.source.snapshot, issueEventSnapshot(backup));
    if (quickCheck(backup) !== "ok") throw new Error("backup quick_check failed");
    const backupCreatedAt = statSync(backupPath).mtime.toISOString();
    if (Date.parse(now) - Date.parse(backupCreatedAt) > 24 * 60 * 60 * 1000) throw new Error("backup is older than 24 hours");
    const switchRow = sqlite.query<{ read_version: string }, []>(
      "select read_version from event_summary_projection_switch where projection_id='issue_events_summary'"
    ).get();
    const compact = sqlite.query<{ last_event_id: number }, []>(
      "select last_event_id from event_projection_watermarks where projection_id='issue_events_summary_v2'"
    ).get();
    if (switchRow?.read_version !== "v2") throw new Error("consumer-zero requires compact projection read_version=v2");
    const compactLastID = Number(compact?.last_event_id ?? 0);
    if (compactLastID < manifest.source.snapshot.last_event_id) throw new Error("compact projection watermark does not cover archive snapshot");
    const holds = input.holdsPath
      ? JSON.parse(readFileSync(resolve(input.holdsPath), "utf8")) as RetentionHold[]
      : [];
    if (!Array.isArray(holds)) throw new Error("holds file must contain a JSON array");
    const config = structuredClone(DEFAULT_EVENT_RETENTION_CONFIG) as unknown as EventRetentionConfig;
    config.execution_mode = "delete_enabled";
    config.execution_authorization = {
      actor_id: input.actor.actor,
      actor_kind: input.actor.actorKind,
      audit_event_ref: input.actor.auditRef,
      authorized_at: now,
      observation_window_ref: `consumer-zero:${input.correlationID}`,
      policy_version: EVENT_RETENTION_POLICY_VERSION,
      reason: input.actor.reason,
      restore_test_ref: `archive-restore:${manifest.manifest_sha256}`
    };
    const evidence: EventDeleteEvidence = {
      archive_manifest_sha256: manifest.manifest_sha256,
      backup: { created_at: backupCreatedAt, db_file: basename(backupPath), quick_check: "ok", restored_at: now, verified_at: now },
      config,
      consumer_zero: { compact_last_event_id: compactLastID, projection_read_version: "v2", verified_at: now },
      correlation_id: input.correlationID,
      holds,
      schema_version: EVENT_DELETE_EVIDENCE_SCHEMA_VERSION,
      scopes: manifest.receipts.map((receipt) => ({
        destructive_gate: {
          actor_id: input.actor.actor,
          actor_kind: input.actor.actorKind,
          audit_event_ref: input.actor.auditRef,
          decision: "allow",
          evaluated_at: now,
          policy_version: EVENT_RETENTION_POLICY_VERSION,
          reason: input.actor.reason
        },
        issue_id: receipt.issue_id,
        policy_id: receipt.policy_id as EventRetentionPolicyID,
        references: { handoff_evidence: false, unresolved_refs: [] },
        run_id: receipt.run_id,
        summary_watermark: {
          actor_id: input.actor.actor,
          audit_event_ref: input.actor.auditRef,
          contiguous: true,
          covered_through_event_id: receipt.through_event_id,
          issue_id: receipt.issue_id,
          policy_id: receipt.policy_id as EventRetentionPolicyID,
          policy_version: EVENT_RETENTION_POLICY_VERSION,
          reason: input.actor.reason,
          run_id: receipt.run_id,
          schema_version: "xuanwu.summary-watermark.v1",
          source: "issue_events",
          summary_ref: `event_summary_projection_compact:${receipt.issue_id}:${receipt.run_id}:${receipt.policy_id}`,
          summary_sha256: sha256(`${manifest.manifest_sha256}:${receipt.issue_id}:${receipt.run_id}:${receipt.policy_id}:${receipt.through_event_id}`),
          verified_at: now,
          verifier: "deterministic_retention_worker"
        }
      })),
      source_snapshot: manifest.source.snapshot,
      writer_quiesce: { active_writers: 0, confirmed_by: input.actor.actor, verified_at: now }
    };
    saveJSON(resolve(input.outputPath), evidence);
    return { operation: "prepare_delete_evidence", output: resolve(input.outputPath), scopes: evidence.scopes.length, evidence };
  } finally {
    backup.close();
    sqlite.close();
  }
}

export function deleteArchivedEvents(input: {
  apply?: boolean;
  archiveDir: string;
  batchSize?: number;
  checkpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  evidencePath: string;
  maxBatches?: number;
  now?: string;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  const now = timestamp(input.now);
  const dbPath = existingDatabasePath(input.dbPath);
  const archiveDir = resolve(input.archiveDir);
  const manifest = verifiedManifest(archiveDir);
  const evidenceText = readFileSync(resolve(input.evidencePath), "utf8");
  const evidence = parseDeleteEvidence(evidenceText, manifest, now);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  try {
    const beforeMeasurement = databaseReport(dbPath, sqlite);
    const before = beforeMeasurement.snapshot;
    const checkpointPath = resolve(input.checkpointPath);
    let checkpoint = input.resume ? readCheckpoint(checkpointPath, "delete") : undefined;
    let blockerCounts: CountMap = {};
    if (!checkpoint) {
      assertSnapshot("archive", manifest.source.snapshot, before);
      assertSnapshot("evidence", evidence.source_snapshot, before);
      const preflight = preflightDelete(sqlite, archiveDir, manifest, evidence, now);
      blockerCounts = preflight.blockers;
      checkpoint = newCheckpoint("delete", manifest.manifest_sha256, sha256(evidenceText), preflight.eligibleIDs, preflight.blockers);
    } else {
      verifyCheckpoint(checkpoint, manifest.manifest_sha256, sha256(evidenceText));
      blockerCounts = checkpoint.blockers;
    }

    if (!input.apply) {
      const report = deleteReport(dbPath, beforeMeasurement, beforeMeasurement, checkpoint, blockerCounts, false, false);
      writeRequiredReport(input.reportPath, report);
      return report;
    }
    requireWriteConfirmations(input);
    requireDiskSpace(dbPath, beforeMeasurement.file_bytes, "delete/vacuum worst-case copy");
    if (!input.resume && existsSync(checkpointPath)) throw new Error("checkpoint already exists; pass --resume or choose a new checkpoint path");
    saveJSON(checkpointPath, checkpoint);
    const authorization = evidence.config.execution_authorization!;
    const remainingIDs = checkpoint.event_ids.slice(checkpoint.cursor);
    const remainingAtStart = countExistingIssueEvents(sqlite, remainingIDs);
    audit(sqlite, authorization.audit_event_ref, authorization.actor_id, authorization.reason,
      "event_maintenance.delete_started", "allow", { eligible_rows: checkpoint.event_ids.length, manifest: manifest.manifest_sha256 });

    const batchSize = batchSizeValue(input.batchSize);
    let batches = 0;
    while (checkpoint.cursor < checkpoint.event_ids.length) {
      const ids = checkpoint.event_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      deleteIssueEventBatch(sqlite, ids);
      checkpoint.cursor += ids.length;
      checkpoint.status = "in_progress";
      saveJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
        checkpoint.cursor < checkpoint.event_ids.length) {
        checkpoint.status = "paused";
        saveJSON(checkpointPath, checkpoint);
        audit(sqlite, authorization.audit_event_ref, authorization.actor_id, authorization.reason,
          "event_maintenance.delete_paused", "allow", { deleted_rows: checkpoint.cursor });
        const paused = deleteReport(dbPath, beforeMeasurement, databaseReport(dbPath, sqlite), checkpoint, blockerCounts, true, true);
        writeRequiredReport(input.reportPath, paused);
        return paused;
      }
    }
    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    saveJSON(checkpointPath, checkpoint);
    const after = issueEventSnapshot(sqlite);
    if (before.issue_event_count - after.issue_event_count !== remainingAtStart) {
      throw new Error("post-delete row count does not match checkpoint");
    }
    if (countExistingIssueEvents(sqlite, checkpoint.event_ids) !== 0) {
      throw new Error("post-delete checkpoint rows still exist");
    }
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-delete quick_check failed: ${integrity}`);
    audit(sqlite, authorization.audit_event_ref, authorization.actor_id, authorization.reason,
      "event_maintenance.delete_completed", "allow", { deleted_rows: checkpoint.event_ids.length, quick_check: integrity });
    const report = deleteReport(dbPath, beforeMeasurement, databaseReport(dbPath, sqlite), checkpoint, blockerCounts, true, false);
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

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

export function checkpointEventDatabase(input: {
  actor: MaintenanceActor;
  apply?: boolean;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  mode: "passive" | "full" | "restart" | "truncate";
  reportPath: string;
}): Record<string, unknown> {
  validateActor(input.actor);
  const dbPath = existingDatabasePath(input.dbPath);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  try {
    const before = databaseReport(dbPath, sqlite);
    if (!input.apply) {
      const report = dbMaintenanceReport("checkpoint", dbPath, true, false, before, before, { mode: input.mode });
      writeRequiredReport(input.reportPath, report);
      return report;
    }
    requireWriteConfirmations(input);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.checkpoint_started", "allow", { mode: input.mode });
    const result = walCheckpoint(sqlite, input.mode);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.checkpoint_completed", "allow", result);
    const report = dbMaintenanceReport("checkpoint", dbPath, false, false, before, databaseReport(dbPath, sqlite), result);
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function vacuumEventDatabase(input: {
  actor: MaintenanceActor;
  apply?: boolean;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  enableIncremental?: boolean;
  mode: "full" | "incremental";
  pages?: number;
  reportPath: string;
}): Record<string, unknown> {
  validateActor(input.actor);
  const dbPath = existingDatabasePath(input.dbPath);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  try {
    const before = databaseReport(dbPath, sqlite);
    const details = { mode: input.mode, pages: input.pages ?? null, enable_incremental: Boolean(input.enableIncremental) };
    if (!input.apply) {
      const report = dbMaintenanceReport("vacuum", dbPath, true, false, before, before, details);
      writeRequiredReport(input.reportPath, report);
      return report;
    }
    requireWriteConfirmations(input);
    if (input.mode === "full") requireDiskSpace(dbPath, before.file_bytes, "full vacuum");
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.vacuum_started", "allow", details);
    runVacuum(sqlite, { mode: input.mode, pages: input.pages, enableIncremental: Boolean(input.enableIncremental) });
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-vacuum quick_check failed: ${integrity}`);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.vacuum_completed", "allow", { ...details, quick_check: integrity });
    const after = databaseReport(dbPath, sqlite);
    const targetBytes = 400 * 1024 * 1024;
    const report = dbMaintenanceReport("vacuum", dbPath, false, false, before, after, {
      ...details,
      quick_check: integrity,
      target: {
        maximum_bytes: targetBytes,
        passed: after.file_bytes <= targetBytes,
        ...(after.file_bytes > targetBytes ? { alert: "database remains above 400 MiB; inspect object_usage before any further deletion", object_usage: databaseObjectUsage(sqlite) } : {})
      }
    });
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

function preflightDelete(
  sqlite: Database,
  archiveDir: string,
  manifest: EventArchiveManifest,
  evidence: EventDeleteEvidence,
  now: string
): { blockers: CountMap; eligibleIDs: number[] } {
  const switchRow = sqlite.query<{ read_version: string }, []>(
    "select read_version from event_summary_projection_switch where projection_id='issue_events_summary'"
  ).get();
  const compact = sqlite.query<{ last_event_id: number }, []>(
    "select last_event_id from event_projection_watermarks where projection_id='issue_events_summary_v2'"
  ).get();
  if (switchRow?.read_version !== "v2" || Number(compact?.last_event_id ?? 0) < manifest.source.snapshot.last_event_id) {
    throw new Error("consumer-zero projection gate changed after evidence preparation");
  }
  const blockers: CountMap = {};
  const eligibleIDs: number[] = [];
  for (const chunk of manifest.chunks) {
    const archived = readChunk(archiveDir, chunk);
    const current = currentIssueEventRows(sqlite, archived.map((row) => row.id));
    if (current.length !== archived.length) throw new Error(`archive/source parity failed for ${chunk.file}`);
    const byID = new Map(current.map((row) => [row.id, row]));
    for (const archiveRowValue of archived) {
      const row = byID.get(archiveRowValue.id)!;
      if (rowChecksum(row, archiveRowValue.policy_id) !== archiveRowValue.row_sha256) {
        throw new Error(`archive/source checksum mismatch for issue_events:${row.id}`);
      }
      const scope = evidence.scopes.find((item) => item.issue_id === row.issue_id &&
        item.run_id === row.run_id && item.policy_id === archiveRowValue.policy_id);
      const receipt = manifest.receipts.find((item) => item.issue_id === row.issue_id &&
        item.run_id === row.run_id && item.policy_id === archiveRowValue.policy_id &&
        item.first_event_id <= row.id && item.through_event_id >= row.id);
      const evaluation = evaluateEventRetention({
        archive_receipt: receipt,
        config: evidence.config,
        destructive_gate: scope?.destructive_gate,
        event: retainedEvent(row),
        holds: evidence.holds,
        now,
        references: scope?.references,
        run: row.run_id ? { id: row.run_id, status: row.run_status } : undefined,
        summary_watermark: scope?.summary_watermark
      });
      if (evaluation.can_execute_delete) eligibleIDs.push(row.id);
      else for (const blocker of evaluation.blockers) increment(blockers, blocker);
    }
  }
  return { blockers, eligibleIDs };
}

function missingArchiveRows(sqlite: Database, archiveDir: string, manifest: EventArchiveManifest): number[] {
  const missing: number[] = [];
  for (const chunk of manifest.chunks) {
    const archived = readChunk(archiveDir, chunk);
    const current = currentIssueEventRows(sqlite, archived.map((row) => row.id));
    const byID = new Map(current.map((row) => [row.id, row]));
    for (const row of archived) {
      const existing = byID.get(row.id);
      if (!existing) missing.push(row.id);
      else if (rowChecksum(existing, row.policy_id) !== row.row_sha256) {
        throw new Error(`restore target conflict for issue_events:${row.id}`);
      }
    }
  }
  return missing;
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

function archiveRow(row: MaintenanceEventRow, policyID: EventRetentionPolicyID): ArchivedEventRow {
  return { ...row, policy_id: policyID, row_sha256: rowChecksum(row, policyID) };
}

function rowChecksum(row: MaintenanceEventRow, policyID: EventRetentionPolicyID): string {
  return sha256(JSON.stringify([
    row.id, row.issue_id, row.project_id, row.event_type, row.payload, row.created_at,
    row.raw_method, row.run_id, row.run_status, policyID
  ]));
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

function rowsChecksum(rows: ArchivedEventRow[]): string {
  return sha256(rows.map((row) => `${row.id}:${row.row_sha256}`).join("\n"));
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

function* archiveRows(archiveDir: string, manifest: EventArchiveManifest): Generator<ArchivedEventRow> {
  for (const chunk of manifest.chunks) yield* readChunk(archiveDir, chunk);
}

function readChunk(archiveDir: string, chunk: ArchiveChunk): ArchivedEventRow[] {
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

function verifiedManifest(archiveDir: string): EventArchiveManifest {
  const manifest = readManifest(join(archiveDir, "manifest.json"));
  if (manifest.status !== "complete" || !manifest.restore_rehearsal || manifest.restore_rehearsal.status !== "passed") {
    throw new Error("archive is not complete with a successful restore rehearsal");
  }
  if (manifest.manifest_sha256 !== manifestChecksum(manifest)) throw new Error("archive manifest checksum mismatch");
  for (const chunk of manifest.chunks) readChunk(archiveDir, chunk);
  return manifest;
}

function parseDeleteEvidence(textValue: string, manifest: EventArchiveManifest, now: string): EventDeleteEvidence {
  const evidence = JSON.parse(textValue) as EventDeleteEvidence;
  if (evidence.schema_version !== EVENT_DELETE_EVIDENCE_SCHEMA_VERSION) throw new Error("delete evidence schema_version is unsupported");
  if (evidence.archive_manifest_sha256 !== manifest.manifest_sha256) throw new Error("delete evidence archive checksum mismatch");
  const errors = validateEventRetentionConfig(evidence.config);
  if (errors.length > 0) throw new Error(`invalid delete evidence config: ${errors.join("; ")}`);
  if (evidence.config.execution_mode !== "delete_enabled") throw new Error("delete evidence must use execution_mode=delete_enabled");
  if (!Array.isArray(evidence.holds) || !Array.isArray(evidence.scopes)) throw new Error("delete evidence holds and scopes are required");
  if (!evidence.correlation_id?.trim()) throw new Error("delete evidence correlation_id is required");
  if (evidence.backup?.quick_check !== "ok" || !evidence.backup.db_file?.trim() ||
      !freshEvidence(evidence.backup.verified_at, now) || !freshEvidence(evidence.backup.restored_at, now)) {
    throw new Error("delete evidence requires a fresh verified and restored backup");
  }
  if (evidence.consumer_zero?.projection_read_version !== "v2" ||
      evidence.consumer_zero.compact_last_event_id < manifest.source.snapshot.last_event_id ||
      !freshEvidence(evidence.consumer_zero.verified_at, now)) {
    throw new Error("delete evidence consumer-zero projection gate is invalid");
  }
  if (evidence.writer_quiesce?.active_writers !== 0 || !evidence.writer_quiesce.confirmed_by?.trim() ||
      !freshEvidence(evidence.writer_quiesce.verified_at, now)) {
    throw new Error("delete evidence writer-quiesce gate is invalid");
  }
  return evidence;
}

function freshEvidence(value: string, now: string): boolean {
  const age = Date.parse(now) - Date.parse(value);
  return Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000;
}

function evaluateRow(row: MaintenanceEventRow, now: string) {
  return evaluateEventRetention({
    event: retainedEvent(row),
    now,
    run: row.run_id ? { id: row.run_id, status: row.run_status } : undefined
  });
}

function retainedEvent(row: MaintenanceEventRow): RetainedEvent {
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

function scanEvents(sqlite: Database, before: string | undefined, visit: (row: MaintenanceEventRow) => void): void {
  let afterID = 0;
  while (true) {
    const rows = listMaintenanceEvents(sqlite, { afterID, before, limit: 1000 });
    for (const row of rows) visit(row);
    if (rows.length < 1000) return;
    afterID = rows.at(-1)!.id;
  }
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

function manifestChecksum(manifest: EventArchiveManifest): string {
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

function newCheckpoint(
  operation: MaintenanceCheckpoint["operation"],
  manifestHash: string,
  evidenceHash: string,
  eventIDs: number[],
  blockers: CountMap = {}
): MaintenanceCheckpoint {
  return {
    archive_manifest_sha256: manifestHash,
    blockers,
    completed_at: "",
    created_at: new Date().toISOString(),
    cursor: 0,
    evidence_sha256: evidenceHash,
    event_ids: eventIDs,
    operation,
    schema_version: EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION,
    status: "in_progress"
  };
}

function readCheckpoint(path: string, operation: MaintenanceCheckpoint["operation"]): MaintenanceCheckpoint {
  if (!existsSync(path)) throw new Error("resume checkpoint does not exist");
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as MaintenanceCheckpoint;
  if (checkpoint.schema_version !== EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION || checkpoint.operation !== operation) {
    throw new Error("maintenance checkpoint is incompatible");
  }
  if (checkpoint.status === "complete") throw new Error("maintenance checkpoint is already complete");
  return checkpoint;
}

function verifyCheckpoint(checkpoint: MaintenanceCheckpoint, manifestHash: string, evidenceHash: string): void {
  if (checkpoint.archive_manifest_sha256 !== manifestHash || checkpoint.evidence_sha256 !== evidenceHash) {
    throw new Error("maintenance checkpoint inputs changed");
  }
  if (!Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0 || checkpoint.cursor > checkpoint.event_ids.length) {
    throw new Error("maintenance checkpoint cursor is invalid");
  }
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

function deleteReport(
  dbPath: string,
  before: DatabaseMeasurement,
  after: DatabaseMeasurement,
  checkpoint: MaintenanceCheckpoint,
  blockers: CountMap,
  applied: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.event-maintenance-report.v1",
    operation: "delete",
    dry_run: !applied,
    paused,
    generated_at: new Date().toISOString(),
    database: { path: dbPath, before, after },
    eligible_rows: checkpoint.event_ids.length,
    deleted_rows: applied ? checkpoint.cursor : 0,
    blockers,
    checkpoint: { status: checkpoint.status, cursor: checkpoint.cursor, total: checkpoint.event_ids.length },
    source_of_truth: "issue_events",
    rollback: "maintenance events restore"
  };
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

function dbMaintenanceReport(
  operation: "checkpoint" | "vacuum",
  dbPath: string,
  dryRun: boolean,
  paused: boolean,
  before: DatabaseMeasurement,
  after: DatabaseMeasurement,
  details: Record<string, unknown>
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.event-maintenance-report.v1",
    operation,
    dry_run: dryRun,
    paused,
    generated_at: new Date().toISOString(),
    database: { path: dbPath, before, after },
    details
  };
}

function databaseReport(path: string, sqlite: Database): DatabaseMeasurement {
  return {
    file_bytes: statSync(path).size,
    quick_check: quickCheck(sqlite),
    snapshot: issueEventSnapshot(sqlite),
    space: databaseSpaceStats(sqlite)
  };
}

function diskSpace(path: string, requiredBytes: number): { available_bytes: number; passed: boolean; required_bytes: number } {
  const stats = statfsSync(path);
  const available = Number(stats.bavail) * Number(stats.bsize);
  return { available_bytes: available, passed: available >= requiredBytes, required_bytes: requiredBytes };
}

function requireDiskSpace(path: string, requiredBytes: number, label: string): void {
  const check = diskSpace(path, requiredBytes);
  if (!check.passed) throw new Error(`${label} disk preflight failed: ${check.available_bytes} available, ${check.required_bytes} required`);
}

function databaseObjectUsage(sqlite: Database): Array<{ bytes: number; name: string }> {
  return sqliteObjectUsage(sqlite);
}

function audit(
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

function prepareArchiveDirectory(archiveDir: string, manifestPath: string, resume: boolean): void {
  if (existsSync(manifestPath) && !resume) throw new Error("archive manifest already exists; pass --resume to continue");
  if (!existsSync(manifestPath) && resume) throw new Error("archive manifest does not exist for --resume");
  mkdirSync(join(archiveDir, "chunks"), { recursive: true, mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  chmodSync(join(archiveDir, "chunks"), 0o700);
}

function readManifest(path: string): EventArchiveManifest {
  return JSON.parse(readFileSync(path, "utf8")) as EventArchiveManifest;
}

function writeOptionalReport(path: string | undefined, value: unknown): void {
  if (path) writeRequiredReport(path, value);
}

function writeRequiredReport(path: string, value: unknown): void {
  if (!path.trim()) throw new Error("--report is required");
  saveJSON(resolve(path), value);
}

function saveJSON(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWrite(path: string, value: string | Buffer): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function openReadonly(path: string): Database {
  const sqlite = new Database(path, { readonly: true, strict: true });
  sqlite.run("pragma query_only=on");
  return sqlite;
}

function openWritable(path: string): Database {
  const sqlite = new Database(path, { create: false, readwrite: true, strict: true });
  sqlite.run("pragma foreign_keys=on");
  return sqlite;
}

function existingDatabasePath(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`database file does not exist: ${absolute}`);
  return absolute;
}

function timestamp(value: string | undefined): string {
  const result = value?.trim() || new Date().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error(`invalid timestamp: ${result}`);
  return result;
}

function optionalTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return timestamp(value);
}

function validateActor(actor: MaintenanceActor): void {
  if (!actor.actor.trim() || !actor.reason.trim() || !actor.auditRef.trim()) {
    throw new Error("actor, reason, and audit ref are required");
  }
  if (actor.actor.trim().toLowerCase() === "llm") throw new Error("LLM cannot authorize maintenance writes");
}

function requireWriteConfirmations(input: { confirmBackupTested?: boolean; confirmNoActiveWriters?: boolean }): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
}

function assertSnapshot(label: string, expected: IssueEventSnapshot, actual: IssueEventSnapshot): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${label} source snapshot changed`);
}

function batchSizeValue(value: number | undefined): number {
  const result = value ?? 500;
  if (!Number.isSafeInteger(result) || result < 1 || result > 5000) throw new Error("batch size must be from 1 to 5000");
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function increment(counts: CountMap, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeKey(issueID: number, runID: string, policyID: EventRetentionPolicyID): string {
  return `${issueID}\u0000${runID}\u0000${policyID}`;
}
