import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { issueIDToWorkID } from "./issueAdapter.ts";
import {
  auditWorkConsistency,
  backfillIssueWorks,
  rollbackIssueWorkBackfill
} from "./migrationService.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("Work backfill migration service", () => {
  test("dry-runs, resumes batched backfill, repeats idempotently, audits parity and rolls back", async () => {
    const fixture = await fixtureDatabase();
    const paths = artifactPaths(fixture.root);

    const dryRun = backfillIssueWorks({
      checkpointPath: paths.backfill,
      dbPath: fixture.dbPath,
      reportPath: paths.dryRun
    });
    expect(dryRun).toMatchObject({
      dry_run: true,
      parity_passed: false,
      before: { counts: { issues: 5, missing_target: 5, target_issue_works: 0 } },
      checkpoint: { status: "not_created", total: 5 }
    });
    expect(existsSync(paths.backfill)).toBe(false);
    expect(workCount(fixture.dbPath)).toBe(0);

    const paused = backfillIssueWorks({
      ...writeInput(fixture.dbPath, paths.backfill, paths.paused),
      batchSize: 2,
      maxBatches: 1
    });
    expect(paused).toMatchObject({
      dry_run: false,
      paused: true,
      checkpoint: { created_rows: 2, cursor: 2, status: "paused", total: 5 }
    });
    expect(workCount(fixture.dbPath)).toBe(2);

    const completed = backfillIssueWorks({
      ...writeInput(fixture.dbPath, paths.backfill, paths.completed),
      batchSize: 2,
      resume: true
    });
    expect(completed).toMatchObject({
      dry_run: false,
      paused: false,
      parity_passed: true,
      checkpoint: { created_rows: 5, cursor: 5, status: "complete", total: 5 },
      after: {
        counts: { issues: 5, matched: 5, mismatched: 0, missing_target: 0, target_issue_works: 5 },
        source_status_counts: { done: 1, in_progress: 1, todo: 2, triage: 1 },
        target_status_counts: { done: 1, in_progress: 1, todo: 2, triage: 1 }
      }
    });
    expect(workCount(fixture.dbPath)).toBe(5);
    expect(workCreateEventCount(fixture.dbPath)).toBe(5);

    const repeat = backfillIssueWorks({
      ...writeInput(fixture.dbPath, paths.repeatCheckpoint, paths.repeatReport),
      batchSize: 3
    });
    expect(repeat).toMatchObject({
      created_rows: 0,
      parity_passed: true,
      checkpoint: { created_rows: 0, cursor: 5, status: "complete", total: 5 }
    });
    expect(workCreateEventCount(fixture.dbPath)).toBe(5);

    const audit = auditWorkConsistency({ dbPath: fixture.dbPath, reportPath: paths.audit });
    expect(audit).toMatchObject({
      dual_read: { authority: "issues", mode: "legacy_primary_target_comparison", winner: "legacy" },
      parity_passed: true,
      repair_proposals: []
    });
    expect(JSON.parse(readFileSync(paths.audit, "utf8"))).toMatchObject({ parity_passed: true });

    const rollbackDryRun = rollbackIssueWorkBackfill({
      backfillCheckpointPath: paths.backfill,
      checkpointPath: paths.rollback,
      dbPath: fixture.dbPath,
      reportPath: paths.rollbackDryRun
    });
    expect(rollbackDryRun).toMatchObject({
      blockers: [],
      dry_run: true,
      checkpoint: { status: "not_created", total: 5 }
    });
    expect(existsSync(paths.rollback)).toBe(false);

    const rollbackPaused = rollbackIssueWorkBackfill({
      ...rollbackWriteInput(fixture.dbPath, paths.backfill, paths.rollback, paths.rollbackPaused),
      batchSize: 2,
      maxBatches: 1
    });
    expect(rollbackPaused).toMatchObject({
      paused: true,
      checkpoint: { cursor: 2, deleted_rows: 2, status: "paused", total: 5 }
    });
    expect(workCount(fixture.dbPath)).toBe(3);

    const rollbackComplete = rollbackIssueWorkBackfill({
      ...rollbackWriteInput(fixture.dbPath, paths.backfill, paths.rollback, paths.rollbackComplete),
      batchSize: 2,
      resume: true
    });
    expect(rollbackComplete).toMatchObject({
      paused: false,
      removed_rows: 3,
      checkpoint: { cursor: 5, deleted_rows: 5, status: "complete", total: 5 },
      after: { counts: { issues: 5, matched: 0, missing_target: 5, target_issue_works: 0 } }
    });
    expect(workCount(fixture.dbPath)).toBe(0);
    expect(migrationAuditCount(fixture.dbPath)).toBeGreaterThanOrEqual(8);
  });

  test("reports legacy-winning drift as a proposal and blocks rollback after target mutation", async () => {
    const fixture = await fixtureDatabase(1);
    const paths = artifactPaths(fixture.root);
    backfillIssueWorks(writeInput(fixture.dbPath, paths.backfill, paths.completed));

    const sqlite = new Database(fixture.dbPath, { readwrite: true });
    sqlite.run("update works set title='target drift' where id=?", [issueIDToWorkID(1)]);
    sqlite.close();

    const audit = auditWorkConsistency({ dbPath: fixture.dbPath });
    expect(audit).toMatchObject({
      counts: { matched: 0, mismatched: 1, missing_target: 0 },
      details: [{ issue_id: 1, mismatches: ["title"], status: "mismatch" }],
      dual_read: { authority: "issues", winner: "legacy" },
      parity_passed: false,
      repair_proposals: [{
        action: "sync_target_from_issue_after_review",
        authority: "issues",
        destructive: false,
        fields: ["title"],
        issue_id: 1
      }]
    });

    const rollback = rollbackIssueWorkBackfill({
      backfillCheckpointPath: paths.backfill,
      checkpointPath: paths.rollback,
      dbPath: fixture.dbPath,
      reportPath: paths.rollbackDryRun
    });
    expect(rollback).toMatchObject({
      blockers: [{
        reason: "Work row no longer matches its backfill creation audit",
        work_id: issueIDToWorkID(1)
      }],
      dry_run: true
    });
    expect(workCount(fixture.dbPath)).toBe(1);
  });
});

async function fixtureDatabase(issueCount = 5): Promise<{ dbPath: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "work-migration-"));
  roots.push(root);
  const dbPath = join(root, "runner-copy.db");
  const db = await openDatabase({ dbPath, stateDir: root });
  try {
    insertProject(db);
    const statuses = ["triage", "todo", "in_progress", "done", "todo"];
    for (let index = 0; index < issueCount; index += 1) {
      createIssue(db, {
        description: `Goal ${index + 1}`,
        project_id: "demo",
        status: statuses[index] ?? "todo",
        title: `Issue ${index + 1}`
      });
    }
  } finally {
    db.close();
  }
  return { dbPath, root };
}

function insertProject(db: RunnerDatabase): void {
  const timestamp = "2026-01-01T00:00:00Z";
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', ?, ?)`, [timestamp, timestamp]);
}

function writeInput(dbPath: string, checkpointPath: string, reportPath: string) {
  return {
    actor: "operator-1",
    actorKind: "user" as const,
    apply: true,
    auditRef: "pi_action_events:approved-work-migration",
    checkpointPath,
    confirmBackupTested: true,
    confirmNoActiveWriters: true,
    dbPath,
    reason: "Work backfill rehearsal on database copy",
    reportPath
  };
}

function rollbackWriteInput(
  dbPath: string,
  backfillCheckpointPath: string,
  checkpointPath: string,
  reportPath: string
) {
  return {
    ...writeInput(dbPath, checkpointPath, reportPath),
    backfillCheckpointPath
  };
}

function artifactPaths(root: string) {
  return {
    audit: join(root, "audit.json"),
    backfill: join(root, "backfill-checkpoint.json"),
    completed: join(root, "backfill-complete.json"),
    dryRun: join(root, "backfill-dry-run.json"),
    paused: join(root, "backfill-paused.json"),
    repeatCheckpoint: join(root, "repeat-checkpoint.json"),
    repeatReport: join(root, "repeat-report.json"),
    rollback: join(root, "rollback-checkpoint.json"),
    rollbackComplete: join(root, "rollback-complete.json"),
    rollbackDryRun: join(root, "rollback-dry-run.json"),
    rollbackPaused: join(root, "rollback-paused.json")
  };
}

function workCount(dbPath: string): number {
  return scalar(dbPath, "select count(*) as count from works");
}

function workCreateEventCount(dbPath: string): number {
  return scalar(dbPath, "select count(*) as count from work_events where event_type='work.created.v1'");
}

function migrationAuditCount(dbPath: string): number {
  return scalar(dbPath, "select count(*) as count from pi_action_events where event_type like 'work_migration.%'");
}

function scalar(dbPath: string, sql: string): number {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
  } finally {
    sqlite.close();
  }
}
