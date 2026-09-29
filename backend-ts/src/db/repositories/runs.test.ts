import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { RUN_STATUSES, type RunID, type WorkID } from "../../domain/run/contracts.ts";
import { listLatestRunsForWorkIDs, listRuns, type RunListFilter } from "./runs.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Run list repository", () => {
  test("created-at pages bound candidates before reading attempt history", async () => {
    const db = await openFixture();
    try {
      insertRuns(db);
      const filter = { limit: 2, offset: 1, sort: "created_at" } as const;
      const { sql, args } = captureRunQuery(filter);
      const candidateSql = sql.match(/candidate_runs as materialized \(([\s\S]*?)\),\s*attempt_stats/)?.[1];
      expect(candidateSql).toBeDefined();
      const parameterCount = candidateSql!.match(/\?/g)?.length ?? 0;
      const candidates = db.sqlite.query<{ legacy_id: string }, Array<number | string>>(
        `with candidate_runs as materialized (${candidateSql}) select legacy_id from candidate_runs`
      ).all(...args.slice(0, parameterCount));
      expect(candidates.map(row => row.legacy_id)).toEqual(["a3", "b1"]);
    } finally { db.close(); }
  });

  test("created-at pages look up attempts by indexed Run rather than scanning their history", async () => {
    const db = await openFixture();
    try {
      const { sql, args } = captureRunQuery({ limit: 2, offset: 1, sort: "created_at" });
      const plan = db.sqlite.query<{ detail: string }, Array<number | string>>(
        `explain query plan ${sql}`
      ).all(...args).map(row => row.detail);
      expect(plan.some(detail => detail.includes("SCAN run USING INDEX idx_issue_runs_started_run_id"))).toBe(true);
      expect(plan.some(detail => /^SCAN attempt\b/.test(detail))).toBe(false);
      expect(plan.some(detail => detail.includes("SEARCH attempt USING COVERING INDEX ux_run_attempts_run_sequence (run_id=?)"))).toBe(true);
      expect(plan.some(detail => detail.includes("SEARCH latest USING INDEX ux_run_attempts_run_sequence (run_id=? AND sequence=?)"))).toBe(true);
    } finally { db.close(); }
  });

  test("created-at pagination preserves full Run projection, ties, filters and both directions", async () => {
    const db = await openFixture();
    try {
      const workID = insertRuns(db);
      for (const order of ["asc", "desc"] as const) {
        for (const scope of [{}, { providers: ["codex"] }, { project_id: "demo" }, { work_id: workID }]) {
          const all = listRuns(db, {
            ...scope, limit: 100, offset: 0, order, sort: "created_at", statuses: [...RUN_STATUSES]
          });
          const page = listRuns(db, { ...scope, limit: 2, offset: 1, order, sort: "created_at" });
          expect(page.map(stableRun)).toEqual(all.slice(1, 3).map(stableRun));
          expect(listRuns(db, { ...scope, limit: 2, offset: 99, order, sort: "created_at" })).toEqual([]);
        }
      }
      const recovering = listRuns(db, { limit: 2, offset: 1, order: "asc", sort: "created_at" })[0]!;
      expect(recovering).toMatchObject({
        id: runID("a2"), attempt_count: 2, revision: 7, status: "recovering", trigger: "retry",
        supersedes_run_id: runID("a1"),
        progress: { attempt_sequence: 2, attempt_status: "created", phase: "recovering" }
      });
    } finally { db.close(); }
  });

  test("status filters and provider, status and updated-at sorting still paginate after projection", async () => {
    const db = await openFixture();
    try {
      insertRuns(db);
      const cases: Array<{ filter: Partial<RunListFilter>; ids: string[] }> = [
        { filter: { statuses: ["recovering"], sort: "created_at" }, ids: ["a2"] },
        { filter: { statuses: ["succeeded"], sort: "created_at" }, ids: ["d1", "a1"] },
        { filter: { sort: "provider", order: "asc" }, ids: ["a1", "a2", "a3", "d1", "b1", "c1"] },
        { filter: { sort: "status", order: "asc" }, ids: ["c1", "a3", "a2", "b1", "a1", "d1"] },
        { filter: { sort: "updated_at" }, ids: ["a1", "c1", "a2", "a3", "d1", "b1"] },
        { filter: {}, ids: ["a1", "c1", "a2", "a3", "d1", "b1"] }
      ];
      for (const { filter, ids } of cases) {
        expect(listRuns(db, { limit: 100, offset: 0, ...filter }).map(run => run.id)).toEqual(ids.map(runID));
        expect(listRuns(db, { limit: 2, offset: 1, ...filter }).map(run => run.id)).toEqual(ids.slice(1, 3).map(runID));
      }
    } finally { db.close(); }
  });

  test("latest Runs for requested Works retain one projected Run per Work", async () => {
    const db = await openFixture();
    try {
      const workID = insertRuns(db);
      const runs = listLatestRunsForWorkIDs(db, [workID, "xw:work:issues:3", workID]);
      expect(runs.map(run => run.id)).toEqual([runID("c1"), runID("a3")]);
      expect(runs.map(run => run.attempt_count)).toEqual([1, 1]);
      expect(runs.map(run => run.status)).toEqual(["cancelled", "failed"]);
    } finally { db.close(); }
  });

  test("created-at pages preserve Runs with no Attempts alongside multiple-Attempt Runs", async () => {
    const db = await openFixture();
    try {
      insertRuns(db);
      db.sqlite.run("delete from run_attempts where run_id=?", [runID("b1")]);
      const runs = listRuns(db, { limit: 3, offset: 1, project_id: "demo", sort: "created_at" });
      expect(runs.map(run => run.id)).toEqual([runID("b1"), runID("a2"), runID("a1")]);
      expect(runs[0]).toMatchObject({
        attempt_count: 0, status: "running", progress: { attempt_id: "", attempt_sequence: 0, attempt_status: null }
      });
      expect(runs[1]).toMatchObject({
        attempt_count: 2, status: "recovering", progress: { attempt_sequence: 2, attempt_status: "created" }
      });
    } finally { db.close(); }
  });

  test("uses bounded attempt and lifecycle rollups instead of per-Run correlated scans", async () => {
    const queries: string[] = [];
    const db = {
      sqlite: {
        query(sql: string) {
          queries.push(sql);
          return { all: () => [] };
        }
      }
    } as unknown as RunnerDatabase;

    expect(listRuns(db, { limit: 50, offset: 0 })).toEqual([]);
    expect(queries).toHaveLength(1);
    const sql = queries[0] ?? "";
    expect(sql).toContain("candidate_runs as materialized");
    expect(sql).toContain("attempt_stats as materialized");
    expect(sql).toContain("selected_runs as materialized");
    expect(sql).toContain("lifecycle_rollup as materialized");
    expect(sql.match(/event\.issue_id=run\.issue_id/g)).toHaveLength(1);
    expect(sql).not.toMatch(/select count\(\*\) from run_attempts child/);
    expect(sql).not.toMatch(/latest\.sequence=\(select max/);

    const root = await mkdtemp(join(tmpdir(), "xuanwu-runs-plan-"));
    tempRoots.push(root);
    const fixture = await openDatabase({ stateDir: join(root, "state") });
    try {
      const plan = fixture.sqlite.query<{ detail: string }, [number, number]>(
        `explain query plan ${sql}`
      ).all(50, 0).map((row) => row.detail);
      expect(plan).toContain("MATERIALIZE selected_runs");
      expect(plan).toContain("MATERIALIZE attempt_stats");
      expect(plan.some((detail) => detail.includes("SEARCH event USING INDEX idx_issue_events_issue_type"))).toBe(true);
      expect(plan.some((detail) => detail.includes("CORRELATED SCALAR SUBQUERY"))).toBe(false);
    } finally {
      fixture.close();
    }
  });
});

function captureRunQuery(filter: RunListFilter): { sql: string; args: Array<number | string> } {
  const captured = { sql: "", args: [] as Array<number | string> };
  const db = {
    sqlite: {
      query(sql: string) {
        captured.sql = sql;
        return { all: (...args: Array<number | string>) => { captured.args = args; return []; } };
      }
    }
  } as unknown as RunnerDatabase;
  listRuns(db, filter);
  return captured;
}

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-run-pages-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function runID(id: string): RunID {
  return `xw:run:issue_runs:${id}`;
}

function stableRun(run: ReturnType<typeof listRuns>[number]): unknown {
  return { ...run, progress: { ...run.progress, stalled: { ...run.progress.stalled, evaluated_at: "" } } };
}

function insertRuns(db: RunnerDatabase): WorkID {
  const timestamp = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  for (const project of ["demo", "other"]) {
    db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
      values (?, ?, ?, 'codex', 0, ?, ?)`, [project, project, `/tmp/run-page-fixture-${project}`, timestamp(1), timestamp(1)]);
  }
  for (const [id, project] of [[1, "demo"], [2, "demo"], [3, "other"], [4, "other"]] as const) {
    db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
      values (?, ?, 'Run page fixture', 'in_progress', ?, ?)`, [id, project, timestamp(1), timestamp(1)]);
  }
  for (const [id, issue, sequence, status, start, end, provider] of [
    ["a1", 1, 1, "succeeded", 1, 9, "codex"],
    ["a2", 1, 2, "in_progress", 3, 0, "codex"],
    ["a3", 1, 3, "failed", 5, 6, "codex"],
    ["b1", 2, 1, "in_progress", 5, 0, "qoder"],
    ["c1", 3, 1, "cancelled", 4, 8, "qoder"],
    ["d1", 4, 1, "succeeded", 6, 6, "codex"]
  ] as const) {
    db.sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at, provider)
      values (?, ?, ?, ?, ?, ?, ?)`, [id, issue, sequence, status, timestamp(start), end ? timestamp(end) : "", provider]);
  }
  db.sqlite.run(`insert into run_attempts (
    attempt_id, run_id, issue_run_id, sequence, kind, status, provider, created_at, updated_at
  ) values (?, ?, 'a2', 2, 'recovery', 'created', 'codex', ?, ?)`,
  [`${runID("a2")}~attempt:2`, runID("a2"), timestamp(7), timestamp(7)]);
  for (const [type, payload] of [
    ["run.lifecycle.run_materialized.v1", { run_id: runID("a2"), after_revision: 4, trigger: "retry", supersedes_run_id: runID("a1") }],
    ["run.lifecycle.outcome.v1", { run_id: runID("a2"), after_revision: 7 }],
    ["run.lifecycle.outcome.v1", { run_id: runID("a1"), after_revision: 99 }]
  ] as const) {
    db.sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (1, ?, ?, ?)",
      [type, JSON.stringify(payload), timestamp(7)]);
  }
  return "xw:work:issues:1";
}
