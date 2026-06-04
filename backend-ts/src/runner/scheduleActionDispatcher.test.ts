import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listPiActionEvents, listPiActions, listPiHeartbeatRuns } from "../db/repositories/pi.ts";
import { runDueCronTasks } from "./cronExecutor.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Schedule action dispatcher", () => {
  test("gates start_delegation before creating an active delegation", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      insertCronTask(db, {
        action: "start_delegation",
        actionPayload: { title: "After-hours window" },
        mode: "once",
        projectID: "project-a"
      });

      const result = await runDueCronTasks({ database: db, now: NOW, startProjectLoop: () => {} });
      const action = onlyPiAction(db);

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(activeDelegationCount(db)).toBe(1);
      expect(action).toMatchObject({
        action_type: "schedule.start_delegation",
        gate_decision: "execute",
        source: "cron_schedule",
        status: "completed"
      });
      expect(listPiActionEvents(db, { actionId: action.id }).map((event) => event.event_type)).toEqual([
        "candidate", "gate_decision", "execution_started", "execution_result"
      ]);
    } finally {
      db.close();
    }
  });

  test("runs one scheduled heartbeat", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      insertCronTask(db, { action: "run_heartbeat", mode: "once", projectID: "project-a" });

      const result = await runDueCronTasks({ database: db, now: NOW, startProjectLoop: () => {} });
      const heartbeats = listPiHeartbeatRuns(db, { kind: "cron", projectId: "project-a" });

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0]).toMatchObject({ project_id: "project-a", status: "completed", trigger: "cron" });
      expect(cronRow(db)).toMatchObject({ last_result: "ran heartbeat for project-a", last_status: "success", status: "done" });
    } finally {
      db.close();
    }
  });

  test("scheduled enqueue_issues with issue_ids only queues the selected issue", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const selectedID = insertIssue(db, "project-a", "Selected issue");
      const otherID = insertIssue(db, "project-a", "Other issue");
      insertCronTask(db, {
        action: "enqueue_issues",
        actionPayload: { issue_ids: [selectedID] },
        mode: "once",
        projectID: "project-a"
      });

      const result = await runDueCronTasks({ database: db, now: NOW, startProjectLoop: () => {} });

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(getIssue(db, selectedID)?.status).toBe("todo");
      expect(getIssue(db, otherID)?.status).toBe("triage");
      expect(cronRow(db)).toMatchObject({
        last_result: "enqueued 1 issue(s)",
        last_status: "success",
        status: "done"
      });
    } finally {
      db.close();
    }
  });

  test("rejects unsupported schedule actions and records the gate decision", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      insertCronTask(db, { action: "delete_everything", mode: "once", projectID: "project-a" });

      const result = await runDueCronTasks({ database: db, now: NOW });
      const action = onlyPiAction(db);

      expect(result).toEqual({ executed: 0, failed: 1, scanned: 1, skipped: 0 });
      expect(cronRow(db).last_status).toBe("error");
      expect(cronRow(db).last_result).toContain("schedule action rejected by action gate");
      expect(action).toMatchObject({ action_type: "schedule.unsupported", gate_decision: "deny", status: "denied" });
      expect(listPiActionEvents(db, { actionId: action.id }).map((event) => event.event_type)).toEqual([
        "candidate", "gate_decision"
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-schedule-actions-"));
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

function insertIssue(db: RunnerDatabase, projectID: string, title: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectID, title, "triage", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertCronTask(db: RunnerDatabase, input: {
  action: string;
  actionPayload?: Record<string, unknown>;
  mode: string;
  projectID: string;
}): void {
  db.sqlite.run(
    `insert into cron_tasks
      (name, project_id, action, mode, next_run_at, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Cron", input.projectID, input.action, input.mode, "2026-06-02T09:59:00.000Z",
      "active", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  const id = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
  db.sqlite.run(
    `insert into cron_task_schedules (cron_task_id, action_payload_json, created_at, updated_at)
     values (?, ?, ?, ?)`,
    [id, JSON.stringify(input.actionPayload ?? {}), "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function activeDelegationCount(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_delegations where status='active'").get()?.count ?? 0;
}

function onlyPiAction(db: RunnerDatabase) {
  const action = listPiActions(db)[0];
  if (!action) throw new Error("PI action missing");
  return action;
}

function cronRow(db: RunnerDatabase) {
  return db.sqlite.query<Record<string, unknown>, []>("select * from cron_tasks limit 1").get() ?? {};
}
