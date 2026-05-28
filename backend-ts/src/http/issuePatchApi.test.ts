import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-patch-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue patch API", () => {
  test("patches issue fields and records status change history", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const response = await patchIssue(database, issueId, fullPatchPayload());
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject(expectedPatchedIssue(issueId));
      expect(listEvents(database)).toEqual([
        { type: "issue.status_changed", payload: "{\"status\":\"todo\"}" }
      ]);
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid and missing issue patches", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const invalidStatus = await patchIssue(database, issueId, { status: "bogus" });
      const missing = await patchIssue(database, 404, { title: "Missing" });

      expect(invalidStatus.status).toBe(400);
      expect(await invalidStatus.json()).toEqual({ message: "status 不合法" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
    } finally {
      database.close();
    }
  });
});

function fullPatchPayload(): Record<string, unknown> {
  return {
    title: "  Renamed patch  ",
    description: "  Updated body  ",
    status: "todo",
    priority: 2,
    error: "queued manually",
    source_session_id: "codex:thread-b",
    source_turn_id: "turn-b",
    source_excerpt: "来源摘录",
    agent_profile_id: "Codex Pro!",
    codex_thread_id: "thread-runtime",
    codex_turn_id: "turn-runtime"
  };
}

function expectedPatchedIssue(id: number): Record<string, unknown> {
  return {
    id,
    title: "Renamed patch",
    description: "Updated body",
    status: "todo",
    priority: 2,
    error: "queued manually",
    source_session_id: "thread-b",
    source_turn_id: "turn-b",
    source_excerpt: "来源摘录",
    agent_profile_id: "codex-pro",
    codex_thread_id: "thread-runtime",
    codex_turn_id: "turn-runtime"
  };
}

function patchIssue(db: RunnerDatabase, id: number, body: Record<string, unknown>): Promise<Response> {
  return createDefaultRouter({ database: db }).handle(new Request(`${BASE_URL}/api/issues/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, source_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, "Patch API", "triage", "thread-a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
