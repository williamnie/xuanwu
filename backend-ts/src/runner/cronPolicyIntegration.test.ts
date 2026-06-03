import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { runDueCronTasks } from "./cronExecutor.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Cron project schedule policy integration", () => {
  test("uses project working-hours policy and timezone for delegated mode", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      upsertProjectPiPolicy(db, {
        project_id: "project-a",
        timezone: "Asia/Shanghai",
        working_hours_json: { end: "18:00", start: "09:00", weekdays: [1, 2, 3, 4, 5] }
      });
      insertCronTask(db, { action: "start_delegation", mode: "once", projectID: "project-a" });

      const result = await runDueCronTasks({ database: db, now: new Date("2026-06-02T11:00:00Z") });
      const delegation = db.sqlite.query<{ authorization_json: string }, []>(
        "select authorization_json from pi_delegations limit 1"
      ).get();

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(JSON.parse(delegation?.authorization_json ?? "{}")).toMatchObject({ mode: "delegated" });
    } finally {
      db.close();
    }
  });

  test("uses project quiet-hours policy to defer due cron work", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      upsertProjectPiPolicy(db, {
        project_id: "project-a",
        quiet_hours_json: { daily: [{ end: "08:00", start: "22:00" }] },
        timezone: "Asia/Shanghai"
      });
      insertCronTask(db, { action: "run_pi_cycle", mode: "daily", projectID: "project-a", timeOfDay: "23:00" });

      const result = await runDueCronTasks({ database: db, now: new Date("2026-06-02T15:00:00Z") });

      expect(result).toEqual({ executed: 0, failed: 0, scanned: 1, skipped: 1 });
      expect(cronRow(db)).toMatchObject({
        last_result: "quiet hours until 2026-06-03T00:00:00.000Z",
        last_status: "skipped",
        next_run_at: "2026-06-03T00:00:00.000Z"
      });
    } finally {
      db.close();
    }
  });

  test("covers missed-run policies skip, run_immediately, and catch_up_once", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "skip-project");
      insertProject(db, "run-project");
      insertProject(db, "catch-project");
      const skippedIssue = insertIssue(db, "skip-project");
      const runIssue = insertIssue(db, "run-project");
      const catchIssue = insertIssue(db, "catch-project");
      insertCronTask(db, { action: "enqueue_issues", missedPolicy: "skip", mode: "daily", projectID: "skip-project" });
      insertCronTask(db, { action: "enqueue_issues", missedPolicy: "run_immediately", mode: "daily", projectID: "run-project" });
      insertCronTask(db, { action: "enqueue_issues", missedPolicy: "catch_up_once", mode: "daily", projectID: "catch-project" });

      const result = await runDueCronTasks({ database: db, now: new Date("2026-06-02T10:00:00Z"), startProjectLoop: () => {} });

      expect(result).toEqual({ executed: 2, failed: 0, scanned: 3, skipped: 1 });
      expect(issueStatus(db, skippedIssue)).toBe("triage");
      expect(issueStatus(db, runIssue)).toBe("todo");
      expect(issueStatus(db, catchIssue)).toBe("todo");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-cron-policy-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, "triage issue", "triage", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertCronTask(db: RunnerDatabase, input: {
  action: string;
  missedPolicy?: string;
  mode: string;
  projectID: string;
  timeOfDay?: string;
}): void {
  db.sqlite.run(
    `insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Cron", input.projectID, input.action, input.mode, input.timeOfDay ?? "09:00",
      "2026-06-01T09:00:00.000Z", "active", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  const id = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
  db.sqlite.run(
    `insert into cron_task_schedules (cron_task_id, missed_run_policy, created_at, updated_at)
     values (?, ?, ?, ?)`,
    [id, input.missedPolicy ?? "run_immediately", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function cronRow(db: RunnerDatabase) {
  return db.sqlite.query<Record<string, unknown>, []>("select * from cron_tasks limit 1").get() ?? {};
}

function issueStatus(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
}
