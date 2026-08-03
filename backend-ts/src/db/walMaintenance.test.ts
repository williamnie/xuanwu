import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import {
  WAL_MAINTENANCE_SCHEMA,
  runWalMaintenance
} from "./walMaintenance.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("audited SQLite WAL maintenance", () => {
  test("dry-run is read-only and apply fails closed on authorization, confirmation, and disk gates", async () => {
    const fixture = await databaseFixture();
    const dryRun = runWalMaintenance({
      dbPath: fixture.dbPath,
      operation: "dry-run",
      reportPath: join(fixture.root, "dry-run.json")
    });
    expect(dryRun).toMatchObject({
      schema_version: WAL_MAINTENANCE_SCHEMA,
      outcome: "checked",
      database: { journal_mode: "delete", quick_check: "ok" }
    });
    expect(journalMode(fixture.dbPath)).toBe("delete");

    expect(() => runWalMaintenance({
      ...applyInput(fixture, "apply"),
      confirmBackupTested: false
    })).toThrow("--confirm-backup-tested");
    expect(() => runWalMaintenance({
      ...applyInput(fixture, "apply"),
      actorKind: "system"
    })).toThrow("--actor-kind user");
    expect(() => runWalMaintenance({
      ...applyInput(fixture, "apply"),
      auditRef: ""
    })).toThrow("--audit-ref is required");
    expect(() => runWalMaintenance({
      ...applyInput(fixture, "apply"),
      availableBytesForTest: 1
    })).toThrow("insufficient disk headroom");
    expect(journalMode(fixture.dbPath)).toBe("delete");
  });

  test("applies, verifies, checkpoints, recovers an uncheckpointed write, snapshots, and rolls back", async () => {
    const fixture = await databaseFixture();
    const applied = runWalMaintenance(applyInput(fixture, "apply"));
    expect(applied).toMatchObject({
      schema_version: WAL_MAINTENANCE_SCHEMA,
      outcome: "applied",
      database: {
        journal_mode: "wal",
        quick_check: "ok",
        synchronous: 1,
        wal_autocheckpoint: 1000
      }
    });
    expect(journalMode(fixture.dbPath)).toBe("wal");

    const reader = new Database(fixture.dbPath, { readonly: true, strict: true });
    const writer = new Database(fixture.dbPath, { readwrite: true, strict: true });
    reader.run("begin");
    expect(reader.query("select count(*) as count from wal_fixture").get()).toEqual({ count: 0 });
    writer.run("pragma synchronous=normal");
    writer.run("insert into wal_fixture (value) values ('survives-wal-recovery')");
    expect(existsSync(`${fixture.dbPath}-wal`)).toBe(true);
    writer.close();
    expect(reader.query("select count(*) as count from wal_fixture").get()).toEqual({ count: 0 });

    const recovered = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(recovered.query("select value from wal_fixture").get()).toEqual({ value: "survives-wal-recovery" });
    recovered.close();
    reader.run("rollback");
    reader.close();

    const snapshotPath = join(fixture.root, "consistent-backup.db");
    const snapshotter = new Database(fixture.dbPath, { readwrite: true, strict: true });
    snapshotter.run("vacuum main into ?", [snapshotPath]);
    snapshotter.close();
    const restored = new Database(snapshotPath, { readonly: true, strict: true });
    expect(restored.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
    expect(restored.query("select value from wal_fixture").get()).toEqual({ value: "survives-wal-recovery" });
    restored.close();

    const verified = runWalMaintenance({
      dbPath: fixture.dbPath,
      operation: "verify",
      reportPath: join(fixture.root, "verify.json")
    });
    expect(verified).toMatchObject({ outcome: "verified", database: { journal_mode: "wal", quick_check: "ok" } });

    const rolledBack = runWalMaintenance(applyInput(fixture, "rollback"));
    expect(rolledBack).toMatchObject({ outcome: "applied", database: { journal_mode: "delete", quick_check: "ok" } });
    expect(journalMode(fixture.dbPath)).toBe("delete");

    const audit = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(audit.query<{ count: number }, []>(`
      select count(*) as count from pi_action_events
      where event_type in ('sqlite_wal.apply_completed', 'sqlite_wal.rollback_completed')
    `).get()?.count).toBe(2);
    audit.close();
  });
});

async function databaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "sqlite-wal-maintenance-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const runner = await openDatabase({ stateDir });
  runner.sqlite.run("create table wal_fixture (value text not null)");
  runner.close();
  return { dbPath: join(stateDir, "runner.db"), root };
}

function applyInput(fixture: { dbPath: string; root: string }, operation: "apply" | "rollback") {
  return {
    actor: "release-operator",
    actorKind: "user" as const,
    apply: true,
    auditRef: "change:sqlite-wal-rehearsal",
    confirmBackupTested: true,
    confirmNoActiveWriters: true,
    dbPath: fixture.dbPath,
    operation,
    reason: "verified WAL transition rehearsal",
    reportPath: join(fixture.root, `${operation}.json`)
  };
}

function journalMode(path: string): string {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    return String(db.query<Record<string, unknown>, []>("pragma journal_mode").get()?.journal_mode ?? "");
  } finally {
    db.close();
  }
}
