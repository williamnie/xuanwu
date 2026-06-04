import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiDelegation, createPiHeartbeatRun } from "../db/repositories/pi.ts";
import { buildPiReport } from "./reports.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI report generator", () => {
  test("generates an empty report without publishing notifications", async () => {
    const db = await openFixtureDatabase();
    let published = 0;
    try {
      insertProject(db, "demo");

      const report = await buildPiReport({
        bus: { publish: () => { published += 1; } },
        database: db,
        now: new Date("2026-06-04T08:00:00Z"),
        projectID: "demo",
        since: "2026-06-03T20:00:00Z",
        type: "night_run_summary",
        until: "2026-06-04T08:00:00Z"
      });

      expect(report).toMatchObject({
        delegation_id: "",
        heartbeat_ids: [],
        issue_ids: [],
        project_id: "demo",
        source: "manual",
        status: "generated",
        summary: { total: 0 },
        type: "night_run_summary"
      });
      expect(published).toBe(0);
    } finally {
      db.close();
    }
  });

  test("generates a delegation-scoped report with related heartbeat and issues", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const included = insertIssue(db, "demo", "done", "Included", "bun test passed");
      insertIssue(db, "demo", "failed", "Outside delegation");
      createPiDelegation(db, { id: "delegation-a", project_id: "demo", title: "Night window" });
      createPiHeartbeatRun(db, {
        delegation_id: "delegation-a",
        finished_at: "2026-06-03T21:10:00Z",
        id: "heartbeat-a",
        kind: "delegation",
        project_id: "demo",
        started_at: "2026-06-03T21:00:00Z",
        status: "completed"
      });
      insertActionEvent(db, "delegation-a", included);

      const report = await buildPiReport({
        database: db,
        delegationID: "delegation-a",
        now: new Date("2026-06-04T08:00:00Z"),
        since: "2026-06-03T20:00:00Z",
        source: "delegation",
        type: "night_run_summary",
        until: "2026-06-04T08:00:00Z"
      });

      expect(report).toMatchObject({
        delegation_id: "delegation-a",
        heartbeat_ids: ["heartbeat-a"],
        issue_ids: [included],
        project_id: "demo",
        source: "delegation",
        status: "generated",
        summary: { completed: 1, failed: 0, total: 1 }
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-report-generator-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, title: string, error = ""): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, title, status, error, "2026-06-03T21:05:00Z", "2026-06-03T21:05:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertActionEvent(db: RunnerDatabase, delegationID: string, issueID: number): void {
  db.sqlite.run(
    `insert into pi_action_events
      (action_id, project_id, issue_id, event_type, actor, delegation_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["action-a", "demo", issueID, "execution_result", "executor", delegationID, "2026-06-03T21:08:00Z"]
  );
}
