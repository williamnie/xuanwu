import { expect, test } from "bun:test";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { runMigrations } from "../../db/migrations.ts";
import { createPiGuardianEvent, listPendingPiGuardianEvents } from "../../db/repositories/pi/guardianEvents.ts";
import { GUARDIAN_INBOX_ACTIVE_INDEX, guardianInboxActiveIndexMigration } from "../../db/schema/094_guardian_inbox_active_index.ts";
import { useTestDatabase } from "../../testing/harness.ts";
import { runPiGuardianWatchdogOnce, watchdogContext } from "./guardianWatchdog.ts";
import { inboxChecks } from "./guardianWatchdogChecks.ts";

const open = useTestDatabase();
const NOW = new Date("2026-10-30T03:00:00Z");
const OLD = "2026-10-30T02:00:00Z";

test("idle inbox queries stay on the active index with sampled and full historical statistics", async () => {
  const db = await open();
  seedHistory(db, 13_832);
  for (const analysisLimit of [1000, 0, -1]) {
    if (analysisLimit === -1) {
      // 复现生产库的近似统计；不能依赖优化器版本自行选择索引。
      db.sqlite.run("update sqlite_stat1 set stat='11696 1001 501 1' where idx='idx_pi_guardian_event_pending'");
      db.sqlite.run("update sqlite_stat1 set stat='9660 143 5 1' where idx='idx_pi_guardian_event_issue'");
      db.sqlite.run("analyze sqlite_schema");
    } else {
      db.sqlite.run(`pragma analysis_limit=${analysisLimit}`);
      db.sqlite.run("analyze pi_guardian_event_inbox");
    }
    const captured = capture(db);
    expect(inboxChecks(watchdogContext(captured.db, { now: NOW }))).toEqual([{ component: "inbox", ok: true }]);
    expect(listPendingPiGuardianEvents(captured.db, 50)).toEqual([]);
    assertActivePlan(db, captured.sql.find((sql) => sql.includes("min(created_at)"))!, ["2026-10-30T02:55:00Z"]);
    assertActivePlan(db, captured.sql.find((sql) => sql.includes("limit ?"))!, [50]);
  }
  expect(db.sqlite.query("select count(*) as count from pi_guardian_event_inbox").get()).toEqual({ count: 13_832 });
});

test("a missing pinned index is reported as a probe error without aborting other checks", async () => {
  const db = await open();
  db.sqlite.run(`drop index ${GUARDIAN_INBOX_ACTIVE_INDEX}`);
  const summary = await runPiGuardianWatchdogOnce(db, {
    now: NOW,
    checks: [
      { component: "inbox", run: inboxChecks },
      { component: "scheduler", run: () => [{ component: "scheduler", ok: true }] }
    ]
  });
  expect(summary).toMatchObject({ errors: 1, scanned: 2, checks: [
    { component: "inbox", ok: false }, { component: "scheduler", ok: true }
  ] });
});

test("stale checks preserve project counts, cutoff boundaries and leased compatibility", async () => {
  const db = await open();
  event(db, "old-pending", "pending", "a");
  event(db, "old-leased", "leased", "a");
  event(db, "boundary", "pending", "b", "2026-10-30T02:55:00Z");
  event(db, "fresh", "pending", "a", "2026-10-30T02:55:01Z");
  event(db, "consumed", "consumed", "a");
  event(db, "failed", "failed", "a");
  const checks = inboxChecks(watchdogContext(db, { now: NOW }));
  expect(checks).toMatchObject([
    { component: "inbox", alert_type: "guardian_inbox_stalled", project_id: "a", evidence: { count: 2, oldest_created_at: OLD } },
    { component: "inbox", project_id: "b", evidence: { count: 1 } }
  ]);
  expect(listPendingPiGuardianEvents(db, 2).map((row) => row.id)).toEqual(["old-pending", "boundary"]);
});

test("FIFO reads apply LIMIT in SQLite and ignore consumed history and leases", async () => {
  const db = await open();
  seedHistory(db, 13_832);
  for (let i = 0; i < 200; i++) event(db, `pending-${i}`, "pending", "demo");
  event(db, "leased", "leased", "demo");
  for (const analysisLimit of [1000, 0]) {
    db.sqlite.run(`pragma analysis_limit=${analysisLimit}`);
    db.sqlite.run("analyze pi_guardian_event_inbox");
    const captured = capture(db);
    expect(listPendingPiGuardianEvents(captured.db, 3).map((row) => row.id)).toEqual(["pending-0", "pending-1", "pending-2"]);
    const sql = captured.sql[0];
    expect(sql).toContain("limit ?");
    const plan = assertActivePlan(db, sql, [3]);
    expect(plan).not.toContain("TEMP B-TREE");
    const reference = db.sqlite.query<{ id: string }, [number]>(sql.replace(`indexed by ${GUARDIAN_INBOX_ACTIVE_INDEX}`, "not indexed"))
      .all(3).map((row) => row.id);
    expect(reference).toEqual(["pending-0", "pending-1", "pending-2"]);
  }
});

test("the additive migration is repeatable and includes only active states", async () => {
  const db = await open();
  seedHistory(db, 13_832);
  event(db, "preserved-history", "consumed", "a");
  event(db, "pending", "pending", "a");
  event(db, "leased", "leased", "b");
  db.sqlite.run(`drop index ${GUARDIAN_INBOX_ACTIVE_INDEX}`);
  db.sqlite.run("delete from schema_migrations where id=?", [guardianInboxActiveIndexMigration.id]);
  runMigrations(db.sqlite);
  db.sqlite.run(guardianInboxActiveIndexMigration.sql);
  expect(db.sqlite.query("select count(*) as count from pi_guardian_event_inbox where status='consumed'").get())
    .toEqual({ count: 13_833 });
  expect(db.sqlite.query(`select count(*) as count from pi_guardian_event_inbox indexed by ${GUARDIAN_INBOX_ACTIVE_INDEX}
    where status='pending' or status='leased'`).get()).toEqual({ count: 2 });
  const index = db.sqlite.query<{ name: string; partial: number }, []>("pragma index_list(pi_guardian_event_inbox)")
    .all().find((row) => row.name === GUARDIAN_INBOX_ACTIVE_INDEX);
  expect(index?.partial).toBe(1);
  expect(db.sqlite.query<{ name: string }, []>(`pragma index_info(${GUARDIAN_INBOX_ACTIVE_INDEX})`).all().map((row) => row.name))
    .toEqual(["status", "sequence_id", "project_id", "created_at"]);
  const definition = db.sqlite.query<{ sql: string }, [string]>("select sql from sqlite_master where name=?")
    .get(GUARDIAN_INBOX_ACTIVE_INDEX)?.sql;
  expect(definition).toContain("where status='pending' or status='leased'");
});

test("a previously applied migration with a missing active index fails at startup", async () => {
  const db = await open();
  db.sqlite.run(`drop index ${GUARDIAN_INBOX_ACTIVE_INDEX}`);
  await expect(openDatabase({ dbPath: db.path })).rejects.toThrow(GUARDIAN_INBOX_ACTIVE_INDEX);
});

function assertActivePlan(db: RunnerDatabase, sql: string, bindings: Array<string | number>): string {
  expect(sql).toBeDefined();
  const details = db.sqlite.query<{ detail: string }, Array<string | number>>(`explain query plan ${sql}`)
    .all(...bindings).map((row) => row.detail).join("\n");
  expect(details).toContain(GUARDIAN_INBOX_ACTIVE_INDEX);
  expect(details).not.toContain("idx_pi_guardian_event_issue");
  return details;
}

function capture(db: RunnerDatabase): { db: RunnerDatabase; sql: string[] } {
  const sql: string[] = [];
  return { sql, db: { ...db, sqlite: new Proxy(db.sqlite, {
    get(target, property) {
      if (property === "query") return (text: string) => { sql.push(text); return target.query(text); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) } };
}

function event(db: RunnerDatabase, id: string, status: string, project: string, createdAt = OLD): void {
  createPiGuardianEvent(db, { id, event_type: "guardian.supervisor.candidate", source_event_id: id,
    source: "supervisor", project_id: project, status, created_at: createdAt });
}

function seedHistory(db: RunnerDatabase, count: number): void {
  const insert = db.sqlite.query(`insert into pi_guardian_event_inbox
    (id,event_type,project_id,status,normalized_payload_json,idempotency_key,created_at,updated_at)
    values (?,'guardian.supervisor.candidate',?,'consumed',?,?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`history-${i}`, `project-${i % 12}`, JSON.stringify({ reason: "x".repeat(1500) }), `key-${i}`, OLD, OLD);
  })();
}
