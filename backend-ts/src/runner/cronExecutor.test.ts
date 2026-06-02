import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { runDueCronTasks } from "./cronExecutor.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Cron due executor", () => {
  test("executes due enqueue schedules and records last run status", async () => {
    const db = await openFixtureDatabase();
    const kicked: string[] = [];
    try {
      insertProject(db, "project-a", 1);
      const issueID = insertIssue(db, "project-a", "triage");
      insertCronTask(db, {
        action: "enqueue_issues",
        mode: "once",
        nextRunAt: "2026-06-02T09:59:00.000Z",
        projectID: "project-a"
      });

      const result = await runDueCronTasks({
        database: db,
        now: NOW,
        startProjectLoop: (_runtime, projectID) => kicked.push(projectID)
      });

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(issueStatus(db, issueID)).toBe("todo");
      expect(kicked).toEqual(["project-a"]);
      expect(cronRow(db)).toMatchObject({
        error: "",
        last_run_at: "2026-06-02T10:00:00.000Z",
        last_status: "success",
        run_count: 1,
        status: "done"
      });
      expect(cronRow(db).last_result).toContain("enqueued 1 issue");
    } finally {
      db.close();
    }
  });

  test("starts delegated windows from schedule action and plans the next daily run", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a", 1);
      insertCronTask(db, {
        action: "start_delegation",
        actionPayload: { title: "After-hours window" },
        mode: "daily",
        nextRunAt: "2026-06-02T09:59:00.000Z",
        projectID: "project-a",
        timeOfDay: "18:30",
        timezone: "Asia/Shanghai",
        workingHours: { after_hours_mode: "delegated", weekdays: [1, 2, 3, 4, 5] }
      });

      const result = await runDueCronTasks({ database: db, now: NOW });

      expect(result.executed).toBe(1);
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_delegations where status='active'").get()).toEqual({ count: 1 });
      expect(cronRow(db).last_result).toContain("started delegation");
      expect(cronRow(db).last_result).toContain("mode=delegated");
      expect(cronRow(db).next_run_at).toBe("2026-06-03T10:30:00.000Z");
    } finally {
      db.close();
    }
  });

  test("records execution failures and still advances recurring schedules", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a", 1);
      insertCronTask(db, {
        action: "run_pi_cycle",
        mode: "daily",
        nextRunAt: "2026-06-02T09:59:00.000Z",
        projectID: "project-a",
        timeOfDay: "18:30"
      });

      const result = await runDueCronTasks({
        database: db,
        now: NOW,
        runProjectCycle: async () => {
          throw new Error("cycle boom");
        }
      });

      expect(result).toEqual({ executed: 0, failed: 1, scanned: 1, skipped: 0 });
      expect(cronRow(db)).toMatchObject({
        error: "cycle boom",
        last_status: "failed",
        next_run_at: "2026-06-03T18:30:00.000Z",
        run_count: 1,
        status: "active"
      });
    } finally {
      db.close();
    }
  });

  test("skips missed recurring runs when policy is skip", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a", 1);
      const issueID = insertIssue(db, "project-a", "triage");
      insertCronTask(db, {
        action: "enqueue_issues",
        missedPolicy: "skip",
        mode: "daily",
        nextRunAt: "2026-06-01T09:00:00.000Z",
        projectID: "project-a",
        timeOfDay: "09:00"
      });

      const result = await runDueCronTasks({ database: db, now: NOW });

      expect(result).toEqual({ executed: 0, failed: 0, scanned: 1, skipped: 1 });
      expect(issueStatus(db, issueID)).toBe("triage");
      expect(cronRow(db)).toMatchObject({
        last_status: "skipped",
        next_run_at: "2026-06-03T09:00:00.000Z",
        run_count: 1,
        status: "active"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-cron-executor-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, autoRun: number): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, autoRun, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectID, `${status} issue`, status, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertCronTask(db: RunnerDatabase, input: {
  action: string;
  actionPayload?: Record<string, unknown>;
  mode: string;
  missedPolicy?: string;
  nextRunAt: string;
  projectID: string;
  timeOfDay?: string;
  timezone?: string;
  workingHours?: Record<string, unknown>;
}): void {
  db.sqlite.run(
    `insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Cron", input.projectID, input.action, input.mode, input.timeOfDay ?? "", input.nextRunAt,
      "active", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  const id = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
  db.sqlite.run(
    `insert into cron_task_schedules
      (cron_task_id, timezone, missed_run_policy, action_payload_json, working_hours_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.timezone ?? "UTC", input.missedPolicy ?? "run_immediately", JSON.stringify(input.actionPayload ?? {}),
      JSON.stringify(input.workingHours ?? {}), "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function cronRow(db: RunnerDatabase) {
  return db.sqlite.query<Record<string, unknown>, []>("select * from cron_tasks limit 1").get() ?? {};
}

function issueStatus(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
}
