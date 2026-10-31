import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  countExistingIssueEvents,
  deleteIssueEventBatch,
  issueEventSnapshot,
  quickCheck
} from "../../db/repositories/eventMaintenance.ts";
import {
  DEFAULT_EVENT_RETENTION_CONFIG,
  EVENT_RETENTION_POLICY_VERSION,
  type EventRetentionConfig,
  type EventRetentionPolicyID,
  type RetentionHold
} from "../retentionPolicy.ts";
import type { CountMap, MaintenanceActor } from "./common.ts";
import {
  assertSnapshot,
  audit,
  batchSizeValue,
  databaseReport,
  existingDatabasePath,
  openReadonly,
  openWritable,
  positiveInteger,
  requireDiskSpace,
  requireWriteConfirmations,
  saveJSON,
  timestamp,
  validateActor,
  verifiedManifest,
  writeRequiredReport
} from "./common.ts";
import { sha256 } from "../../util/values.ts";
import {
  compactProjectionGate,
  parseDeleteEvidence,
  readCheckpoint,
  preflightDelete,
  newCheckpoint,
  verifyCheckpoint
} from "./deletionEvidence.ts";
import { type EventDeleteEvidence, EVENT_DELETE_EVIDENCE_SCHEMA_VERSION } from "./deletionModel.ts";
import { deleteReport } from "./deletionReport.ts";

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

export { restoreArchivedEvents } from "./deletionRestore.ts";
