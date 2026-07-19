import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";

const MIGRATE = join(import.meta.dir, "migrate-automation-target-primary.mjs");
const VERIFY = join(import.meta.dir, "verify-automation-rollback.mjs");
const ROOTS: string[] = [];

afterEach(() => { while (ROOTS.length) rmSync(ROOTS.pop()!, { recursive: true, force: true }); });

describe("Automation target-primary migration", () => {
  test("archives terminal carriers, establishes one audited writer marker, remains idempotent, and verifies backup restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "automation-target-primary-"));
    ROOTS.push(root);
    const dbPath = join(root, "runner.db");
    const backupPath = join(root, "runner.pre-cutover.db");
    const archivePath = join(root, "nightly.json");
    const reportPath = join(root, "cutover.json");
    const rollbackPath = join(root, "rollback.json");
    const restoredPath = join(root, "restored.db");
    const db = await openDatabase({ dbPath, stateDir: root });
    seedArchiveTables(db);
    db.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo','Demo','/tmp','2026-07-19T00:00:00Z','2026-07-19T00:00:00Z')");
    db.sqlite.run(`insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, created_at, updated_at)
      values ('done cron','demo','triage_to_todo','once','','2026-07-18T00:00:00Z','done','2026-07-17T00:00:00Z','2026-07-18T00:00:00Z')`);
    db.close();
    copyFileSync(dbPath, backupPath);

    const first = await run(MIGRATE, args(dbPath, backupPath, archivePath, reportPath));
    expect(first.exitCode).toBe(0);
    const report = JSON.parse(first.stdout);
    expect(report).toMatchObject({
      authority: { destructive_delete: false, dual_write: "none", source_of_truth: "automation_definitions" },
      migration: { cron_archived: 1, legacy_rows_deleted: 0, pi_automations_migrated: 0 },
      after: { cutover_marker: true, foreign_key_violations: 0, quick_check: "ok" }
    });
    expect(JSON.parse(readFileSync(archivePath, "utf8"))).toMatchObject({ contract: "xw.nightly-batch-archive.v1" });

    const second = await run(MIGRATE, args(dbPath, backupPath, archivePath, reportPath));
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).migration.unchanged_automation_ids).toEqual(expect.arrayContaining([
      "automation:cutover-739", "automation:legacy-cron-1"
    ]));

    copyFileSync(backupPath, restoredPath);
    const rollback = await run(VERIFY, ["--backup-db", backupPath, "--restored-db", restoredPath, "--report", rollbackPath]);
    expect(rollback.exitCode).toBe(0);
    expect(JSON.parse(rollback.stdout)).toMatchObject({ contract: "xw.automation-rollback-restore.v1", passed: true });
  });

  test("fails closed when a legacy scheduler still has active work", async () => {
    const root = mkdtempSync(join(tmpdir(), "automation-target-primary-blocked-"));
    ROOTS.push(root);
    const dbPath = join(root, "runner.db");
    const backupPath = join(root, "backup.db");
    const db = await openDatabase({ dbPath, stateDir: root });
    seedArchiveTables(db);
    db.sqlite.run(`insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, created_at, updated_at)
      values ('active cron','','triage_to_todo','once','','2099-01-01T00:00:00Z','active','2026-07-19T00:00:00Z','2026-07-19T00:00:00Z')`);
    db.close(); copyFileSync(dbPath, backupPath);
    const result = await run(MIGRATE, args(dbPath, backupPath, join(root,"nightly.json"), join(root,"report.json")));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nonterminal cron tasks=1");
  });
});

function args(db: string, backup: string, archive: string, report: string): string[] {
  return ["--db",db,"--backup-db",backup,"--archive",archive,"--report",report,"--actor","codex-runner-migration","--correlation","issue-739-test","--reason","test target-primary cutover","--apply","--confirm-backup-tested","--confirm-no-active-writers"];
}
function seedArchiveTables(db: Awaited<ReturnType<typeof openDatabase>>) {
  db.sqlite.run("create table nightly_batches (id integer primary key, status text not null, created_at text not null, updated_at text not null)");
  db.sqlite.run("create table nightly_batch_items (batch_id integer not null, issue_id integer not null, status text not null, updated_at text not null, primary key(batch_id,issue_id))");
  db.sqlite.run("insert into nightly_batches values (1,'done','2026-07-18T00:00:00Z','2026-07-18T01:00:00Z')");
  db.sqlite.run("insert into nightly_batch_items values (1,739,'done','2026-07-18T01:00:00Z')");
}
async function run(script: string, args: string[]) { const child=Bun.spawn([process.execPath,script,...args],{stdout:"pipe",stderr:"pipe"}); const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]); return {exitCode,stdout,stderr}; }
