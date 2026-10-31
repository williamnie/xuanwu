import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EVENT_RETENTION_POLICY_VERSION } from "../retentionPolicy.ts";
import type { DatabaseMeasurement, EventArchiveManifest, MaintenanceActor } from "./common.ts";
import { EVENT_ARCHIVE_SCHEMA_VERSION, assertSnapshot, diskSpace, readChunk } from "./common.ts";
import { sha256 } from "../../util/values.ts";

export function newManifest(
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

export function verifyResumeManifest(
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

export function archiveReport(dbPath: string, manifest: EventArchiveManifest, paused: boolean): Record<string, unknown> {
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

export function prepareArchiveDirectory(archiveDir: string, manifestPath: string, resume: boolean): void {
  if (existsSync(manifestPath) && !resume) throw new Error("archive manifest already exists; pass --resume to continue");
  if (!existsSync(manifestPath) && resume) throw new Error("archive manifest does not exist for --resume");
  mkdirSync(join(archiveDir, "chunks"), { recursive: true, mode: 0o700 });
  chmodSync(archiveDir, 0o700);
  chmodSync(join(archiveDir, "chunks"), 0o700);
}
