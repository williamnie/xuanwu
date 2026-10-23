import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { listPiGuardianEvents } from "../../db/repositories/pi.ts";
import { runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();
const NOW = new Date("2026-06-02T10:00:00Z");

describe("PI heartbeat decision boundary", () => {
  test("attended heartbeat collects state without manufacturing an action", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "project-a");
    const issueID = insertIssue(db, "project-a", "todo");

    const result = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });

    expect(result).toMatchObject({ actions_proposed: 0, executed_actions: [], status: "completed" });
    expect(listPiGuardianEvents(db, { projectId: "project-a" })).toEqual([]);
    expect(rowCount(db, "pi_actions")).toBe(0);
    expect(statusOfIssue(db, issueID)).toBe("todo");
  });
});

function insertProject(db: RunnerDatabase, id: string, provider = "codex"): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, provider, 1, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, skills: string[] = []): number {
  db.sqlite.run(
    `insert into issues
       (project_id, title, status, recommended_skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, `${status} issue`, status, JSON.stringify(skills), "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function statusOfIssue(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
}

function rowCount(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}
