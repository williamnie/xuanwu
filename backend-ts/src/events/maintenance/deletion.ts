import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  countExistingIssueEvents,
  currentIssueEventRows,
  deleteIssueEventBatch,
  issueEventSnapshot,
  quickCheck,
  restoreIssueEventBatch,
  type IssueEventSnapshot
} from "../../db/repositories/eventMaintenance.ts";
import {
  DEFAULT_EVENT_RETENTION_CONFIG,
  EVENT_RETENTION_POLICY_VERSION,
  evaluateEventRetention,
  validateEventRetentionConfig,
  type DestructiveGate,
  type EventRetentionConfig,
  type EventRetentionPolicyID,
  type RetentionHold,
  type RetentionReferenceState,
  type SummaryWatermark
} from "../retentionPolicy.ts";
import type { ArchivedEventRow, CountMap, DatabaseMeasurement, EventArchiveManifest, MaintenanceActor } from "./common.ts";
import {
  archiveRows, assertSnapshot, audit, batchSizeValue, databaseReport, existingDatabasePath, increment,
  openReadonly, openWritable, positiveInteger, readChunk, requireDiskSpace, requireWriteConfirmations,
  retainedEvent, rowChecksum, saveJSON, timestamp, validateActor, verifiedManifest, writeRequiredReport
} from "./common.ts";
import { sha256 } from "../../util/values.ts";

/** Event maintenance step 2: delete evidence, checkpointed deletion of archived rows, and restore from the archive. */

const EVENT_DELETE_EVIDENCE_SCHEMA_VERSION = "xuanwu.event-maintenance-delete-evidence.v1" as const;

const EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION = "xuanwu.event-maintenance-checkpoint.v1" as const;

type EventDeleteEvidence = {
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
    const gate = compactProjectionGate(sqlite);
    if (gate.readVersion !== "v2") throw new Error("consumer-zero requires compact projection read_version=v2");
    const compactLastID = gate.lastEventID;
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

function preflightDelete(
  sqlite: Database,
  archiveDir: string,
  manifest: EventArchiveManifest,
  evidence: EventDeleteEvidence,
  now: string
): { blockers: CountMap; eligibleIDs: number[] } {
  const gate = compactProjectionGate(sqlite);
  if (gate.readVersion !== "v2" || gate.lastEventID < manifest.source.snapshot.last_event_id) {
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

/** Consumer-zero gate: readers must be on the compact (v2) projection and its watermark must cover the archive. */
function compactProjectionGate(sqlite: Database): { lastEventID: number; readVersion: string } {
  const switchRow = sqlite.query<{ read_version: string }, []>(
    "select read_version from event_summary_projection_switch where projection_id='issue_events_summary'"
  ).get();
  const compact = sqlite.query<{ last_event_id: number }, []>(
    "select last_event_id from event_projection_watermarks where projection_id='issue_events_summary_v2'"
  ).get();
  return { lastEventID: Number(compact?.last_event_id ?? 0), readVersion: switchRow?.read_version ?? "" };
}
