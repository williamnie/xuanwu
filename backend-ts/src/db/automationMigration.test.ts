import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const roots: string[] = [];
const MIGRATION_ID = "045_automation_model";

afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("Automation model migration", () => {
  test("upgrades an existing runner database additively and creates query indexes", async () => {
    const root = await path();
    await createPreAutomationDatabase(join(root, "runner.db"));
    const db = await openDatabase({ stateDir: root });
    try {
      expect(tableNames(db)).toEqual(expect.arrayContaining([
        "automation_definitions", "automation_trigger_configs", "automation_runs", "automation_events"
      ]));
      expect(indexNames(db, "automation_definitions")).toContain("idx_automation_definitions_scope_status_next");
      expect(indexNames(db, "automation_trigger_configs")).toContain("idx_automation_trigger_configs_lookup");
      expect(indexNames(db, "automation_runs")).toContain("idx_automation_runs_history");
      expect(indexNames(db, "automation_events")).toContain("idx_automation_events_history");
      expect(db.sqlite.query("select id from schema_migrations where id=?").get(MIGRATION_ID)).toEqual({ id: MIGRATION_ID });
      expect(db.sqlite.query("select title from issues where id=1").get()).toEqual({ title: "legacy issue" });
      expect(queryPlan(db, `select * from automation_definitions
        where scope_kind='project' and scope_id='demo' and status='active' order by next_run_at, id`))
        .toContain("idx_automation_definitions_scope_status_next");
    } finally { db.close(); }
  });
});

async function path(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "automation-migration-")); roots.push(root); return root; }
async function createPreAutomationDatabase(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const db = new Database(file, { strict: true });
  try {
    db.run("pragma foreign_keys=on");
    const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
    runMigrations(db, migrations.slice(0, index));
    db.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo', 'Demo', '/tmp/demo', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')");
    db.run("insert into issues (project_id, title, status, created_at, updated_at) values ('demo', 'legacy issue', 'todo', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')");
  } finally { db.close(); }
}
function tableNames(db: RunnerDatabase): string[] { return db.sqlite.query("select name from sqlite_master where type='table'").all().map((row) => (row as { name: string }).name); }
function indexNames(db: RunnerDatabase, table: string): string[] { return db.sqlite.query(`pragma index_list(${table})`).all().map((row) => (row as { name: string }).name); }
function queryPlan(db: RunnerDatabase, sql: string): string { return db.sqlite.query(`explain query plan ${sql}`).all().map((row) => (row as { detail: string }).detail).join("\n"); }
