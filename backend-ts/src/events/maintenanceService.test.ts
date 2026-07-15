import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_DELETE_EVIDENCE_SCHEMA_VERSION,
  archiveEventMaintenance,
  checkpointEventDatabase,
  deleteArchivedEvents,
  restoreArchivedEvents,
  vacuumEventDatabase,
  type EventArchiveManifest,
  type EventDeleteEvidence
} from "./maintenanceService.ts";
import {
  DEFAULT_EVENT_RETENTION_CONFIG,
  EVENT_RETENTION_POLICY_VERSION,
  SUMMARY_WATERMARK_SCHEMA_VERSION,
  type EventRetentionConfig,
  type EventRetentionPolicyID
} from "./retentionPolicy.ts";

const roots: string[] = [];
const NOW = "2026-07-16T00:00:00Z";
const ACTOR = { actor: "operator-1", auditRef: "pi_action_events:maintenance-test-1", reason: "database copy rehearsal" };

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("event maintenance service", () => {
  test("archives with resume, deletes gated rows in batches, vacuums, and restores exact source rows", () => {
    const root = mkdtempSync(join(tmpdir(), "event-maintenance-"));
    roots.push(root);
    const sourcePath = join(root, "runner-source.db");
    const dbPath = join(root, "runner-copy.db");
    createFixture(sourcePath);
    copyFileSync(sourcePath, dbPath);
    const expectedRows = readEventRows(sourcePath);
    const archiveDir = join(root, "archive");

    const pausedArchive = archiveEventMaintenance({
      actor: ACTOR,
      archiveDir,
      batchSize: 1,
      dbPath,
      maxBatches: 1,
      now: NOW,
      reportPath: join(root, "archive-paused.json")
    });
    expect(pausedArchive).toMatchObject({ operation: "archive", paused: true, source_rows_deleted: 0 });

    const archiveReport = archiveEventMaintenance({
      actor: ACTOR,
      archiveDir,
      batchSize: 1,
      dbPath,
      reportPath: join(root, "archive.json"),
      resume: true
    });
    expect(archiveReport).toMatchObject({
      operation: "archive",
      paused: false,
      archive: { rows: 3, status: "complete", restore_rehearsal: { status: "passed", restored_rows: 3 } }
    });
    expect(Number((archiveReport.archive as Record<string, unknown>).compressed_bytes)).toBeGreaterThan(0);
    expect(Number((archiveReport.archive as Record<string, unknown>).compressed_bytes)).toBeLessThan(600_000);
    expect(readEventRows(dbPath)).toEqual(expectedRows);

    const manifest = JSON.parse(readFileSync(join(archiveDir, "manifest.json"), "utf8")) as EventArchiveManifest;
    const evidencePath = join(root, "delete-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(deleteEvidence(manifest)));
    const deleteCheckpoint = join(root, "delete-checkpoint.json");
    const deleteDryRun = deleteArchivedEvents({
      archiveDir,
      checkpointPath: deleteCheckpoint,
      dbPath,
      evidencePath,
      now: NOW,
      reportPath: join(root, "delete-dry-run.json")
    });
    expect(deleteDryRun).toMatchObject({ dry_run: true, eligible_rows: 2, deleted_rows: 0 });
    expect(deleteDryRun.blockers).toMatchObject({ source_deletion_disabled: 1 });
    expect(readEventRows(dbPath)).toEqual(expectedRows);

    const preDeleteBytes = statSync(dbPath).size;
    const pausedDelete = deleteArchivedEvents({
      apply: true,
      archiveDir,
      batchSize: 1,
      checkpointPath: deleteCheckpoint,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      evidencePath,
      maxBatches: 1,
      now: NOW,
      reportPath: join(root, "delete-paused.json")
    });
    expect(pausedDelete).toMatchObject({ dry_run: false, paused: true, deleted_rows: 1 });
    expect(readEventRows(dbPath).map((row) => row.id)).toEqual([1, 3, 4]);
    rewindCheckpoint(deleteCheckpoint);
    const deleteReport = deleteArchivedEvents({
      apply: true,
      archiveDir,
      batchSize: 1,
      checkpointPath: deleteCheckpoint,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      evidencePath,
      now: NOW,
      reportPath: join(root, "delete.json"),
      resume: true
    });
    expect(deleteReport).toMatchObject({ dry_run: false, eligible_rows: 2, deleted_rows: 2 });
    expect(readEventRows(dbPath).map((row) => row.id)).toEqual([1, 4]);
    expect(readEventRows(dbPath).find((row) => row.id === 1)?.type).toBe("issue.status_changed");

    const checkpointDryRun = checkpointEventDatabase({
      actor: ACTOR,
      dbPath,
      mode: "passive",
      reportPath: join(root, "checkpoint-dry-run.json")
    });
    expect(checkpointDryRun).toMatchObject({ operation: "checkpoint", dry_run: true });
    const checkpointReport = checkpointEventDatabase({
      actor: ACTOR,
      apply: true,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      mode: "truncate",
      reportPath: join(root, "checkpoint.json")
    });
    expect(checkpointReport).toMatchObject({ operation: "checkpoint", dry_run: false });

    const vacuumReport = vacuumEventDatabase({
      actor: ACTOR,
      apply: true,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      enableIncremental: true,
      mode: "full",
      reportPath: join(root, "vacuum.json")
    });
    expect(vacuumReport).toMatchObject({ operation: "vacuum", dry_run: false, details: { quick_check: "ok" } });
    expect(statSync(dbPath).size).toBeLessThan(preDeleteBytes);
    const incrementalReport = vacuumEventDatabase({
      actor: ACTOR,
      apply: true,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      mode: "incremental",
      pages: 10,
      reportPath: join(root, "incremental-vacuum.json")
    });
    expect(incrementalReport).toMatchObject({ operation: "vacuum", details: { mode: "incremental", quick_check: "ok" } });

    const restoreCheckpoint = join(root, "restore-checkpoint.json");
    const restoreDryRun = restoreArchivedEvents({
      actor: ACTOR,
      archiveDir,
      checkpointPath: restoreCheckpoint,
      dbPath,
      reportPath: join(root, "restore-dry-run.json")
    });
    expect(restoreDryRun).toMatchObject({ dry_run: true, restore_rows: 2, restored_rows: 0 });

    const pausedRestore = restoreArchivedEvents({
      actor: ACTOR,
      apply: true,
      archiveDir,
      batchSize: 1,
      checkpointPath: restoreCheckpoint,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      maxBatches: 1,
      reportPath: join(root, "restore-paused.json")
    });
    expect(pausedRestore).toMatchObject({ dry_run: false, paused: true, restored_rows: 1 });
    expect(readEventRows(dbPath).map((row) => row.id)).toEqual([1, 2, 4]);
    rewindCheckpoint(restoreCheckpoint);
    const restoreReport = restoreArchivedEvents({
      actor: ACTOR,
      apply: true,
      archiveDir,
      batchSize: 1,
      checkpointPath: restoreCheckpoint,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      reportPath: join(root, "restore.json"),
      resume: true
    });
    expect(restoreReport).toMatchObject({ dry_run: false, restore_rows: 2, restored_rows: 2 });
    expect(readEventRows(dbPath)).toEqual(expectedRows);
    expect(quickCheck(dbPath)).toBe("ok");
    expect(readEventRows(sourcePath)).toEqual(expectedRows);
  });

  test("keeps incremental vacuum fail-closed until the database is configured for it", () => {
    const root = mkdtempSync(join(tmpdir(), "event-maintenance-incremental-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    createFixture(dbPath);

    expect(() => vacuumEventDatabase({
      actor: ACTOR,
      apply: true,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      mode: "incremental",
      pages: 10,
      reportPath: join(root, "incremental.json")
    })).toThrow("incremental vacuum requires auto_vacuum=INCREMENTAL");
  });
});

function createFixture(path: string): void {
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.run(`
      create table projects (id text primary key);
      create table issues (id integer primary key, project_id text not null);
      create table issue_runs (
        id text primary key, issue_id integer not null, attempt integer not null,
        status text not null, started_at text not null, ended_at text not null
      );
      create table issue_events (
        id integer primary key autoincrement, issue_id integer not null, type text not null,
        payload text not null, created_at text not null,
        foreign key(issue_id) references issues(id) on delete cascade
      );
      create table pi_action_events (
        id integer primary key autoincrement, action_id text not null, project_id text not null default '',
        issue_id integer not null default 0, conversation_id text not null default '', event_type text not null,
        actor text not null default '', decision text not null default '', reason text not null default '',
        payload_json text not null default '{}', result_json text not null default '{}', error text not null default '',
        delegation_id text not null default '', heartbeat_id text not null default '', created_at text not null
      );
    `);
    sqlite.run("insert into projects (id) values ('demo')");
    sqlite.run("insert into issues (id, project_id) values (1, 'demo')");
    sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
      values ('issue-1-attempt-1', 1, 1, 'done', '2024-01-01T00:00:00Z', '2025-02-01T00:00:00Z')`);
    const insert = sqlite.query("insert into issue_events (issue_id, type, payload, created_at) values (1, ?, ?, ?)");
    insert.run("issue.status_changed", JSON.stringify({ status: "done" }), "2025-01-01T00:00:00Z");
    insert.run("issue.log", payload("item/agentMessage/delta", "a"), "2025-01-02T00:00:00Z");
    insert.run("issue.log", payload("item/completed", "b"), "2025-01-03T00:00:00Z");
    insert.run("issue.future_unknown", "{}", "2025-01-04T00:00:00Z");
  } finally {
    sqlite.close();
  }
}

function payload(rawMethod: string, character: string): string {
  return JSON.stringify({ provider: "codex", raw_method: rawMethod, raw_payload: character.repeat(300_000) });
}

function readEventRows(path: string): Array<{ created_at: string; id: number; issue_id: number; payload_sha256: string; type: string }> {
  const sqlite = new Database(path, { readonly: true, strict: true });
  try {
    return sqlite.query<{ created_at: string; id: number; issue_id: number; payload: string; type: string }, []>(
      "select id, issue_id, type, payload, created_at from issue_events order by id"
    ).all().map(({ payload, ...row }) => ({ ...row, payload_sha256: hash(payload) }));
  } finally {
    sqlite.close();
  }
}

function deleteEvidence(manifest: EventArchiveManifest): EventDeleteEvidence {
  const config = structuredClone(DEFAULT_EVENT_RETENTION_CONFIG) as unknown as EventRetentionConfig;
  config.execution_mode = "delete_enabled";
  config.execution_authorization = {
    actor_id: ACTOR.actor,
    actor_kind: "user",
    audit_event_ref: ACTOR.auditRef,
    authorized_at: NOW,
    observation_window_ref: "retention-observation:test",
    policy_version: EVENT_RETENTION_POLICY_VERSION,
    reason: ACTOR.reason,
    restore_test_ref: "archive-restore:test"
  };
  return {
    archive_manifest_sha256: manifest.manifest_sha256,
    config,
    holds: [],
    schema_version: EVENT_DELETE_EVIDENCE_SCHEMA_VERSION,
    scopes: ([
      ["raw_operational", 2],
      ["raw_durable", 3]
    ] as Array<[EventRetentionPolicyID, number]>).map(([policyID, eventID]) => ({
      destructive_gate: {
        actor_id: ACTOR.actor,
        actor_kind: "user",
        audit_event_ref: ACTOR.auditRef,
        decision: "allow",
        evaluated_at: NOW,
        policy_version: EVENT_RETENTION_POLICY_VERSION,
        reason: ACTOR.reason
      },
      issue_id: 1,
      policy_id: policyID,
      references: { handoff_evidence: false, unresolved_refs: [] },
      run_id: "issue-1-attempt-1",
      summary_watermark: {
        actor_id: ACTOR.actor,
        audit_event_ref: ACTOR.auditRef,
        contiguous: true,
        covered_through_event_id: eventID,
        issue_id: 1,
        policy_id: policyID,
        policy_version: EVENT_RETENTION_POLICY_VERSION,
        reason: ACTOR.reason,
        run_id: "issue-1-attempt-1",
        schema_version: SUMMARY_WATERMARK_SCHEMA_VERSION,
        source: "issue_events",
        summary_ref: `summary:test:${policyID}`,
        summary_sha256: hash(policyID),
        verified_at: NOW,
        verifier: "deterministic_retention_worker"
      }
    })),
    source_snapshot: manifest.source.snapshot
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rewindCheckpoint(path: string): void {
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  checkpoint.cursor = 0;
  checkpoint.status = "paused";
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function quickCheck(path: string): string {
  const sqlite = new Database(path, { readonly: true });
  try {
    const row = sqlite.query<Record<string, string>, []>("pragma quick_check").get() ?? {};
    return String(Object.values(row)[0] ?? "");
  } finally {
    sqlite.close();
  }
}
