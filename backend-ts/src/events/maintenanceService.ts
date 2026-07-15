import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
import {
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
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
};

export type EventDeleteEvidence = {
  archive_manifest_sha256: string;
  config: EventRetentionConfig;
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

    const rehearsal = rehearseArchiveRestore(archiveDir, manifest);
    manifest.restore_rehearsal = rehearsal.result;
    manifest.receipts = archiveReceipts(manifest, rehearsal.scopes, input.actor, archiveDir);
    manifest.manifest_sha256 = manifestChecksum(manifest);
    manifest.receipts = manifest.receipts.map((receipt) => ({ ...receipt, manifest_sha256: manifest.manifest_sha256 }));
    manifest.completed_at = new Date().toISOString();
    manifest.status = "complete";
    saveJSON(manifestPath, manifest);
    const report = archiveReport(dbPath, manifest, false);
    writeRequiredReport(input.reportPath, report);
    return report;
  } finally {
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
  const evidence = parseDeleteEvidence(evidenceText, manifest);
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
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.vacuum_started", "allow", details);
    runVacuum(sqlite, { mode: input.mode, pages: input.pages, enableIncremental: Boolean(input.enableIncremental) });
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-vacuum quick_check failed: ${integrity}`);
    audit(sqlite, input.actor.auditRef, input.actor.actor, input.actor.reason,
      "event_maintenance.vacuum_completed", "allow", { ...details, quick_check: integrity });
    const report = dbMaintenanceReport("vacuum", dbPath, false, false, before, databaseReport(dbPath, sqlite), {
      ...details, quick_check: integrity
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
        item.run_id === row.run_id && item.first_event_id <= row.id && item.through_event_id >= row.id);
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

function parseDeleteEvidence(textValue: string, manifest: EventArchiveManifest): EventDeleteEvidence {
  const evidence = JSON.parse(textValue) as EventDeleteEvidence;
  if (evidence.schema_version !== EVENT_DELETE_EVIDENCE_SCHEMA_VERSION) throw new Error("delete evidence schema_version is unsupported");
  if (evidence.archive_manifest_sha256 !== manifest.manifest_sha256) throw new Error("delete evidence archive checksum mismatch");
  const errors = validateEventRetentionConfig(evidence.config);
  if (errors.length > 0) throw new Error(`invalid delete evidence config: ${errors.join("; ")}`);
  if (evidence.config.execution_mode !== "delete_enabled") throw new Error("delete evidence must use execution_mode=delete_enabled");
  if (!Array.isArray(evidence.holds) || !Array.isArray(evidence.scopes)) throw new Error("delete evidence holds and scopes are required");
  return evidence;
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
    totals: { compressed_bytes: 0, payload_bytes: 0, rows: 0 }
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
    totals: manifest.totals
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
