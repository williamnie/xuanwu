import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { quickCheck, type MaintenanceEventRow } from "../../db/repositories/eventMaintenance.ts";
import {
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
  EVENT_RETENTION_POLICY_VERSION,
  type ArchiveReceipt,
  type EventRetentionPolicyID
} from "../retentionPolicy.ts";
import type { ArchivedEventRow, EventArchiveManifest, MaintenanceActor } from "./common.ts";
import {
  archiveRows,
  atomicWrite,
  positiveInteger,
  rowChecksum,
  rowsChecksum,
  scopeKey,
  verifiedManifest,
  writeOptionalReport
} from "./common.ts";
import { sha256 } from "../../util/values.ts";

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

export function archiveRow(row: MaintenanceEventRow, policyID: EventRetentionPolicyID): ArchivedEventRow {
  return { ...row, policy_id: policyID, row_sha256: rowChecksum(row, policyID) };
}

export function addArchiveChunk(archiveDir: string, manifest: EventArchiveManifest, rows: ArchivedEventRow[]): void {
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

export function makeArchiveImmutable(archiveDir: string, manifest: EventArchiveManifest): void {
  for (const chunk of manifest.chunks) chmodSync(join(archiveDir, chunk.file), 0o400);
  chmodSync(join(archiveDir, "manifest.json"), 0o400);
}

export function rehearseArchiveRestore(
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

export function archiveReceipts(
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
