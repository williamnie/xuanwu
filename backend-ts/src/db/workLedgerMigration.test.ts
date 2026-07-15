import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "041_work_ledger_schema";
const NOW = "2026-07-16T00:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Work Ledger schema migration", () => {
  test("creates the additive schema on an empty database", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("work-ledger-empty-") });
    try {
      expect(tableNames(connection)).toEqual(expect.arrayContaining(["works", "work_relations", "work_events"]));
      expect(columnNames(connection, "works")).toEqual(expect.arrayContaining([
        "acceptance_json", "created_at", "project_id", "provenance_json", "revision", "updated_at"
      ]));
      expect(indexNames(connection, "works")).toEqual(expect.arrayContaining([
        "idx_works_project_status_updated", "idx_works_project_updated"
      ]));
      expect(indexNames(connection, "work_relations")).toEqual(expect.arrayContaining([
        "idx_work_relations_source", "idx_work_relations_target", "ux_work_relations_parent_child"
      ]));
      expect(indexNames(connection, "work_events")).toEqual(expect.arrayContaining([
        "idx_work_events_correlation", "idx_work_events_project_occurred", "idx_work_events_work_occurred"
      ]));
      expect(migrationCount(connection)).toEqual({ count: 1 });
    } finally {
      connection.close();
    }
  });

  test("migrates an existing runtime database without changing legacy issues", async () => {
    const stateDir = await tempPath("work-ledger-upgrade-");
    await createPreWorkLedgerDatabase(join(stateDir, "runner.db"));

    const migrated = await openDatabase({ stateDir });
    try {
      expect(migrated.sqlite.query(
        "select project_id, title, status, created_at, updated_at from issues where id=1"
      ).get()).toEqual({
        created_at: NOW,
        project_id: "demo",
        status: "todo",
        title: "Legacy issue",
        updated_at: NOW
      });
      expect(migrated.sqlite.query("select count(*) as count from works").get()).toEqual({ count: 0 });
      expect(migrationCount(migrated)).toEqual({ count: 1 });
    } finally {
      migrated.close();
    }
  });

  test("is idempotent across repeated migration runs", async () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.run("pragma foreign_keys = on");
      runMigrations(db);
      runMigrations(db);

      expect(db.query("select count(*) as count from schema_migrations").get()).toEqual({ count: migrations.length });
      expect(db.query("select count(*) as count from schema_migrations where id=?").get(MIGRATION_ID))
        .toEqual({ count: 1 });
      expect(db.query("select count(*) as count from sqlite_master where type='table' and name like 'work%'").get())
        .toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  test("enforces Work vocabulary, project ownership, relation shape, and audit gates", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("work-ledger-constraints-") });
    try {
      insertProject(connection, "alpha");
      insertProject(connection, "beta");
      insertWork(connection, "xw:work:issues:1", "alpha");
      insertWork(connection, "xw:work:issues:2", "alpha");
      insertWork(connection, "xw:work:issues:3", "alpha");
      insertWork(connection, "xw:work:issues:4", "beta");

      expect(() => insertWork(connection, "xw:work:issues:5", "alpha", "unknown"))
        .toThrow();
      expect(() => insertRelation(connection, "self", "alpha", "xw:work:issues:1", "xw:work:issues:1"))
        .toThrow();
      expect(() => insertRelation(connection, "cross-project", "alpha", "xw:work:issues:1", "xw:work:issues:4"))
        .toThrow();

      insertRelation(connection, "parent-one", "alpha", "xw:work:issues:1", "xw:work:issues:3");
      expect(() => insertRelation(connection, "parent-two", "alpha", "xw:work:issues:2", "xw:work:issues:3"))
        .toThrow();

      expect(() => insertEvent(connection, "llm-event", "xw:work:issues:1", "alpha", "llm"))
        .toThrow();
      insertEvent(connection, "allowed-event", "xw:work:issues:1", "alpha", "deterministic_policy");
      expect(connection.sqlite.query("select outcome from work_events where event_id='allowed-event'").get())
        .toEqual({ outcome: "applied" });
    } finally {
      connection.close();
    }
  });

  test("uses the declared indexes for ledger queries", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("work-ledger-query-plan-") });
    try {
      expect(queryPlan(connection, `
        select * from works
        where project_id='demo' and status='todo'
        order by updated_at desc, id
      `)).toContain("idx_works_project_status_updated");
      expect(queryPlan(connection, `
        select target_work_id from work_relations
        where project_id='demo' and source_work_id='xw:work:issues:1' and kind='depends_on'
      `)).toContain("idx_work_relations_source");
      expect(queryPlan(connection, `
        select source_work_id from work_relations
        where project_id='demo' and target_work_id='xw:work:issues:1' and kind='depends_on'
      `)).toContain("idx_work_relations_target");
      expect(queryPlan(connection, `
        select * from work_events
        where work_id='xw:work:issues:1'
        order by occurred_at, event_id
      `)).toContain("idx_work_events_work_occurred");
    } finally {
      connection.close();
    }
  });

  test("documents authority, bounded coexistence, and rollback safety", () => {
    const note = readFileSync(resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0012-work-ledger-schema.md"), "utf8");
    expect(note).toContain("`issues`、`issue_events` 与现有 Issue API/state service 仍是 W0 唯一读写 authority");
    expect(note).toContain("不增加 repository、API、backfill、双写或双读");
    expect(note).toContain("Schema rollback note");
    expect(note).toContain("只有在确认三个表零行");
    expect(note).toContain("P11.05/P11.09");
  });
});

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function createPreWorkLedgerDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  try {
    db.run("pragma foreign_keys = on");
    runMigrations(db, migrations.slice(0, workLedgerMigrationIndex()));
    db.run(
      "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ["demo", "Demo", "/tmp/demo", NOW, NOW]
    );
    db.run(
      "insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ["demo", "Legacy issue", "todo", NOW, NOW]
    );
  } finally {
    db.close();
  }
}

function workLedgerMigrationIndex(): number {
  const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
  if (index < 0) throw new Error("Work Ledger migration missing");
  return index;
}

function insertProject(connection: RunnerDatabase, id: string): void {
  connection.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [id, id, `/tmp/${id}`, NOW, NOW]
  );
}

function insertWork(connection: RunnerDatabase, id: string, projectID: string, status = "todo"): void {
  connection.sqlite.run(`
    insert into works (
      id, project_id, type, title, goal, status, acceptance_json,
      provenance_json, workflow_ref, created_at, updated_at
    ) values (?, ?, 'engineering_task', 'Task', 'Ship task', ?, '{}', '{}', 'agent-execution-contract', ?, ?)
  `, [id, projectID, status, NOW, NOW]);
}

function insertRelation(
  connection: RunnerDatabase,
  relationID: string,
  projectID: string,
  sourceWorkID: string,
  targetWorkID: string
): void {
  connection.sqlite.run(`
    insert into work_relations (
      relation_id, project_id, kind, source_work_id, target_work_id,
      actor_json, reason, correlation_id, audit_event_ref, occurred_at
    ) values (?, ?, 'parent_child', ?, ?, '{"kind":"supervisor","id":"planner"}',
      'decompose Work', ?, ?, ?)
  `, [relationID, projectID, sourceWorkID, targetWorkID, `correlation:${relationID}`, `event:${relationID}`, NOW]);
}

function insertEvent(
  connection: RunnerDatabase,
  eventID: string,
  workID: string,
  projectID: string,
  authority: string
): void {
  connection.sqlite.run(`
    insert into work_events (
      event_id, work_id, project_id, event_type, actor_json, reason, correlation_id,
      gate_authority, gate_decision, gate_policy_ref, expected_revision,
      before_revision, after_revision, outcome, occurred_at
    ) values (?, ?, ?, 'work.status_changed.v1', '{"kind":"runner","id":"runner"}',
      'start Work', ?, ?, 'allow', 'work-state-policy:v1', 0, 0, 1, 'applied', ?)
  `, [eventID, workID, projectID, `correlation:${eventID}`, authority, NOW]);
}

function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query("select name from sqlite_master where type='table'").all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_info(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma index_list(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

function migrationCount(connection: RunnerDatabase): unknown {
  return connection.sqlite.query("select count(*) as count from schema_migrations where id=?").get(MIGRATION_ID);
}

function queryPlan(connection: RunnerDatabase, sql: string): string {
  return connection.sqlite.query(`explain query plan ${sql}`).all()
    .map((row) => (row as { detail: string }).detail)
    .join("\n");
}
