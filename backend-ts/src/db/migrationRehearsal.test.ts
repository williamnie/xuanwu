import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrations.ts";
import {
  forwardDatabaseMigration,
  preflightDatabaseMigration,
  rollbackDatabaseMigration,
  STORAGE_COMPAT_VERSION
} from "./migrationRehearsal.ts";
import { migrations } from "./schema/index.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("database migration rehearsal gate", () => {
  test("backs up, applies the additive Work/Run migrations, audits, and restores the copy", () => {
    const root = fixtureRoot();
    const dbPath = join(root, "runner-copy.db");
    createPreXuanwuDatabase(dbPath);
    const backupPath = join(root, "backup", "before-forward.db");
    const forwardReport = join(root, "reports", "forward.json");

    const applied = forwardDatabaseMigration(applyInput(dbPath, backupPath, forwardReport));

    expect(applied).toMatchObject({
      operation: "forward",
      outcome: "applied",
      compatibility: { status: "compatible", received: STORAGE_COMPAT_VERSION },
      health_gate: { status: "passed" }
    });
    expect(existsSync(backupPath)).toBe(true);
    const migrated = new Database(dbPath, { readonly: true });
    try {
      expect(migrated.query("select id from schema_migrations where id='041_work_ledger_schema'").get()).toBeTruthy();
      expect(migrated.query("select id from schema_migrations where id='042_run_attempt_relations'").get()).toBeTruthy();
      expect(migrated.query<{ count: number }, []>("select count(*) as count from run_attempts").get()?.count).toBe(1);
      expect(migrated.query<{ count: number }, []>("select count(*) as count from pi_action_events where event_type='db_migration.forward_completed'").get()?.count).toBe(1);
    } finally {
      migrated.close();
    }

    const restored = rollbackDatabaseMigration(applyInput(dbPath, backupPath, join(root, "reports", "rollback.json")));
    expect(restored).toMatchObject({ operation: "rollback", outcome: "restored", health_gate: { status: "blocked" } });
    const rollback = new Database(dbPath, { readonly: true });
    try {
      expect(rollback.query("select id from schema_migrations where id='041_work_ledger_schema'").get()).toBeNull();
      expect(rollback.query("select name from sqlite_master where type='table' and name='works'").get()).toBeNull();
      expect(rollback.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
      expect(rollback.query<{ count: number }, []>("select count(*) as count from pi_action_events where event_type='db_migration.rollback_completed'").get()?.count).toBe(1);
    } finally {
      rollback.close();
    }
  });

  test("reports a version downgrade without allowing a forward write", () => {
    const root = fixtureRoot();
    const dbPath = join(root, "runner-copy.db");
    createPreXuanwuDatabase(dbPath);
    const report = preflightDatabaseMigration({
      compatVersion: "xuanwu.storage-compat.v0",
      dbPath,
      reportPath: join(root, "reports", "preflight.json")
    });

    expect(report).toMatchObject({
      operation: "preflight",
      compatibility: { status: "blocked", received: "xuanwu.storage-compat.v0" },
      health_gate: { status: "blocked" }
    });
    expect(readFileSync(join(root, "reports", "preflight.json"), "utf8"))
      .toContain("compatibility downgrade or mismatch");
  });

  test("preserves a fresh backup and a failure report when forward migration fails", () => {
    const root = fixtureRoot();
    const dbPath = join(root, "runner-copy.db");
    createPreXuanwuDatabase(dbPath);
    const backupPath = join(root, "backup", "before-failure.db");
    const reportPath = join(root, "reports", "failed.json");

    expect(() => forwardDatabaseMigration({
      ...applyInput(dbPath, backupPath, reportPath),
      migrations: [{ id: "999_failure_injection", sql: "not valid sql" }]
    })).toThrow();
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toContain('"outcome": "failed"');
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(check.query("select id from schema_migrations where id='999_failure_injection'").get()).toBeNull();
      expect(check.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
    } finally {
      check.close();
    }
  });
});

function applyInput(dbPath: string, backupPath: string, reportPath: string) {
  return {
    actor: "rehearsal-operator",
    actorKind: "user" as const,
    apply: true,
    auditRef: "pi_action_events:migration-rehearsal-test",
    backupPath,
    confirmBackupTested: true,
    confirmNoActiveWriters: true,
    dbPath,
    reason: "database migration rehearsal test",
    reportPath
  };
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "db-migration-rehearsal-"));
  roots.push(root);
  return root;
}

function createPreXuanwuDatabase(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("pragma foreign_keys = on");
    const cutoff = migrations.findIndex((migration) => migration.id === "041_work_ledger_schema");
    if (cutoff < 0) throw new Error("Work migration missing");
    runMigrations(db, migrations.slice(0, cutoff));
    db.run(`insert into projects (id, name, cwd, created_at, updated_at)
      values ('demo', 'Demo', '/tmp/demo', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')`);
    db.run(`insert into issues (project_id, title, status, created_at, updated_at)
      values ('demo', 'Migration fixture', 'todo', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')`);
    db.run(`insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
      values ('run-1', 1, 1, 'in_progress', 'codex', '2026-07-18T00:00:00Z')`);
  } finally {
    db.close();
  }
}
