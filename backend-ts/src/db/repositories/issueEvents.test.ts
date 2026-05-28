import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { listIssueEvents, recordIssueLogEvent } from "./issueEvents.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-events-repo-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue event repository logs", () => {
  test("records normalized provider error events as issue.log rows", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");

      const event = recordIssueLogEvent(database, issueId, {
        provider: "codex",
        type: "error",
        error: "turn failed",
        status: "failed",
        session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
        raw: { method: "error", payload: "{\"error\":\"turn failed\"}" }
      });

      expect(event.type).toBe("issue.log");
      expect(listIssueEvents(database, issueId).map((item) => item.type)).toEqual(["issue.log"]);
      expect(JSON.parse(event.payload)).toEqual({
        type: "error",
        provider: "codex",
        raw_method: "error",
        raw_payload: "{\"error\":\"turn failed\"}",
        status: "failed",
        error: "turn failed"
      });
    } finally {
      database.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Events repo", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
