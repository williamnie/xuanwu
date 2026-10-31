import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { currentIssueEventRows } from "../../db/repositories/eventMaintenance.ts";
import { evaluateEventRetention, validateEventRetentionConfig } from "../retentionPolicy.ts";
import type { CountMap, EventArchiveManifest } from "./common.ts";
import { increment, readChunk, retainedEvent, rowChecksum } from "./common.ts";
import {
  type EventDeleteEvidence,
  EVENT_DELETE_EVIDENCE_SCHEMA_VERSION,
  type MaintenanceCheckpoint,
  EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION
} from "./deletionModel.ts";

export function preflightDelete(
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

export function missingArchiveRows(sqlite: Database, archiveDir: string, manifest: EventArchiveManifest): number[] {
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

export function parseDeleteEvidence(textValue: string, manifest: EventArchiveManifest, now: string): EventDeleteEvidence {
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

export function newCheckpoint(
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

export function readCheckpoint(path: string, operation: MaintenanceCheckpoint["operation"]): MaintenanceCheckpoint {
  if (!existsSync(path)) throw new Error("resume checkpoint does not exist");
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as MaintenanceCheckpoint;
  if (checkpoint.schema_version !== EVENT_MAINTENANCE_CHECKPOINT_SCHEMA_VERSION || checkpoint.operation !== operation) {
    throw new Error("maintenance checkpoint is incompatible");
  }
  if (checkpoint.status === "complete") throw new Error("maintenance checkpoint is already complete");
  return checkpoint;
}

export function verifyCheckpoint(checkpoint: MaintenanceCheckpoint, manifestHash: string, evidenceHash: string): void {
  if (checkpoint.archive_manifest_sha256 !== manifestHash || checkpoint.evidence_sha256 !== evidenceHash) {
    throw new Error("maintenance checkpoint inputs changed");
  }
  if (!Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0 || checkpoint.cursor > checkpoint.event_ids.length) {
    throw new Error("maintenance checkpoint cursor is invalid");
  }
}

/** Consumer-zero gate: readers must be on the compact (v2) projection and its watermark must cover the archive. */
export function compactProjectionGate(sqlite: Database): { lastEventID: number; readVersion: string } {
  const switchRow = sqlite.query<{ read_version: string }, []>(
    "select read_version from event_summary_projection_switch where projection_id='issue_events_summary'"
  ).get();
  const compact = sqlite.query<{ last_event_id: number }, []>(
    "select last_event_id from event_projection_watermarks where projection_id='issue_events_summary_v2'"
  ).get();
  return { lastEventID: Number(compact?.last_event_id ?? 0), readVersion: switchRow?.read_version ?? "" };
}
