import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cleanupLegacyAutomationSchema,
  verifyLegacyAutomationArchive
} from "./legacyAutomationCleanup.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";
import {
  LEGACY_AUTOMATION_DROP_MIGRATION_ID,
  LEGACY_AUTOMATION_DROP_TABLES
} from "./schema/053_drop_legacy_automation_tables.ts";

const roots: string[] = [];
const sourceRoot = resolve(import.meta.dir, "../../..");

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("legacy Automation schema cleanup", () => {
  test("keeps ordinary startup deferred until the audited drop marker exists", () => {
    const fixture = fixturePaths();
    const sqlite = new Database(fixture.db, { strict: true });
    try {
      runMigrations(sqlite, migrations);
      expect(remainingTables(sqlite)).toEqual([
        "cron_task_schedules", "cron_tasks", "pi_automations",
        "pi_issue_completion_watch_items", "pi_issue_completion_watches"
      ]);
      expect(hasMigration(sqlite)).toBe(false);

      runMigrations(sqlite, migrations);
      expect(hasMigration(sqlite)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  test("defers a populated upgrade until guarded archive, backup, and restore rehearsal pass", () => {
    const fixture = fixturePaths();
    const sqlite = new Database(fixture.db, { strict: true });
    try {
      const dropIndex = migrations.findIndex((migration) => migration.id === LEGACY_AUTOMATION_DROP_MIGRATION_ID);
      runMigrations(sqlite, migrations.slice(0, dropIndex));
      seedReadyLegacyData(sqlite);

      runMigrations(sqlite, migrations);
      expect(hasMigration(sqlite)).toBe(false);
      expect(remainingTables(sqlite)).toEqual([...LEGACY_AUTOMATION_DROP_TABLES]);
    } finally {
      sqlite.close();
    }

    const preflight = cleanupLegacyAutomationSchema({
      dbPath: fixture.db,
      releaseRef: "test-release-restart-1",
      reportPath: fixture.preflight,
      sourceRoot
    });
    expect(preflight).toMatchObject({ gate: { passed: true }, operation: "preflight", outcome: "ready" });

    const applied = cleanupLegacyAutomationSchema({
      actor: "test-operator",
      actorKind: "user",
      apply: true,
      archivePath: fixture.archive,
      auditRef: "issue:744:test",
      backupPath: fixture.backup,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      confirmTables: LEGACY_AUTOMATION_DROP_TABLES.join(","),
      dbPath: fixture.db,
      reason: "verify guarded legacy Automation cleanup",
      releaseRef: "test-release-restart-1",
      reportPath: fixture.applied,
      sourceRoot
    });
    expect(applied).toMatchObject({
      archive: { verified: true },
      backup: { foreign_key_violations: 0, quick_check: "ok", restore_rehearsal_completed: true },
      outcome: "applied",
      removed_tables: [...LEGACY_AUTOMATION_DROP_TABLES]
    });
    expect(existsSync(fixture.backup)).toBe(true);
    expect(verifyLegacyAutomationArchive(fixture.archive)).toMatchObject({ verified: true });

    const cleaned = new Database(fixture.db, { readonly: true, strict: true });
    try {
      expect(remainingTables(cleaned)).toEqual([]);
      expect(hasMigration(cleaned)).toBe(true);
      expect(cleaned.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
      expect(cleaned.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      cleaned.close();
    }

    const restored = new Database(fixture.backup, { readonly: true, strict: true });
    try {
      expect(remainingTables(restored)).toEqual([...LEGACY_AUTOMATION_DROP_TABLES]);
      expect(restored.query("select count(*) as count from cron_tasks").get()).toEqual({ count: 1 });
      expect(restored.query("select count(*) as count from nightly_batch_items").get()).toEqual({ count: 1 });
    } finally {
      restored.close();
    }
  });

  test("fails closed without the exact table approval", () => {
    const fixture = fixturePaths();
    const sqlite = new Database(fixture.db, { strict: true });
    try {
      const dropIndex = migrations.findIndex((migration) => migration.id === LEGACY_AUTOMATION_DROP_MIGRATION_ID);
      runMigrations(sqlite, migrations.slice(0, dropIndex));
      seedReadyLegacyData(sqlite);
    } finally {
      sqlite.close();
    }
    expect(() => cleanupLegacyAutomationSchema({
      actor: "test-operator",
      actorKind: "user",
      apply: true,
      archivePath: fixture.archive,
      auditRef: "issue:744:test",
      backupPath: fixture.backup,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      confirmTables: "cron_tasks",
      dbPath: fixture.db,
      reason: "must fail",
      releaseRef: "test-release-restart-1",
      reportPath: fixture.applied,
      sourceRoot
    })).toThrow("--confirm-tables must exactly equal");
    expect(existsSync(fixture.backup)).toBe(false);
    expect(existsSync(fixture.archive)).toBe(false);
  });
});

function seedReadyLegacyData(sqlite: Database): void {
  const now = "2026-07-19T09:18:51.076Z";
  sqlite.run(`create table nightly_batches (
    id integer primary key autoincrement, project_id text not null, title text not null,
    status text not null, source text not null, options_json text not null,
    created_at text not null, started_at text not null default '', updated_at text not null
  )`);
  sqlite.run(`create table nightly_batch_items (
    batch_id integer not null, issue_id integer not null, position integer not null,
    status text not null, created_at text not null, primary key(batch_id, issue_id)
  )`);
  sqlite.run("create index idx_nightly_batch_items_issue on nightly_batch_items(issue_id)");
  sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', ?, ?)`, [now, now]);
  sqlite.run(`insert into cron_tasks
    (name, project_id, action, mode, status, next_run_at, created_at, updated_at)
    values ('Archived cron', 'demo', 'issue.enqueue', 'once', 'done', '', ?, ?)`, [now, now]);
  sqlite.run(`insert into nightly_batches
    (project_id, title, status, source, options_json, created_at, updated_at)
    values ('demo', 'Archived nightly', 'done', 'test', '{}', ?, ?)`, [now, now]);
  const batchID = Number(sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0);
  sqlite.run(`insert into nightly_batch_items
    (batch_id, issue_id, position, status, created_at) values (?, 0, 0, 'done', ?)`, [batchID, now]);
  sqlite.run(`insert into automation_definitions
    (id, scope_kind, scope_id, name, workflow_ref, permission_policy_ref, mode, status,
     idempotency_namespace, active_trigger_version, next_run_at, revision, created_at, updated_at)
    values ('automation:cutover-739', 'control_plane', 'local', 'Cutover',
      'workflow:investigate@v1', 'migration-policy:test', 'observe', 'archived',
      'xw:test:cutover', 1, null, 0, ?, ?)`, [now, now]);
  sqlite.run(`insert into automation_trigger_configs
    (automation_id, version, trigger_type, config_json, created_by, created_at)
    values ('automation:cutover-739', 1, 'manual', '{}', 'test-operator', ?)`, [now]);
  sqlite.run(`insert into automation_events
    (event_id, automation_id, event_type, expected_revision, before_revision, after_revision,
     actor_id, actor_kind, correlation_id, gate_authority, gate_decision, gate_policy_ref,
     reason, payload_json, occurred_at)
    values ('automation-event:test-cutover', 'automation:cutover-739',
      'automation.target_primary_cutover.v1', 0, 0, 0, 'test-operator', 'user',
      'issue:744:test', 'human_approval', 'allow', 'issue:744:test', 'test cutover', '{}', ?)`, [now]);
}

function remainingTables(sqlite: Database): string[] {
  return LEGACY_AUTOMATION_DROP_TABLES.filter((table) => Boolean(sqlite.query(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table)));
}

function hasMigration(sqlite: Database): boolean {
  return Boolean(sqlite.query("select id from schema_migrations where id=?").get(LEGACY_AUTOMATION_DROP_MIGRATION_ID));
}

function fixturePaths() {
  const root = mkdtempSync(join(tmpdir(), "xw-p11-09-cleanup-"));
  roots.push(root);
  return {
    applied: join(root, "applied.json"),
    archive: join(root, "legacy-automation-archive.json"),
    backup: join(root, "runner-before-drop.db"),
    db: join(root, "runner.db"),
    preflight: join(root, "preflight.json")
  };
}
