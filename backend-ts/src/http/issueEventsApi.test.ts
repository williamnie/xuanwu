import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-events-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue comments and events API", () => {
  test("creates issue.comment events and lists append-only history by time", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      insertEvent(database, issueId, "issue.status_changed", "{\"status\":\"todo\"}", "2026-01-03T00:00:00Z");
      insertEvent(database, issueId, "issue.created", "", "2026-01-01T00:00:00Z");

      const router = createDefaultRouter({ database });
      const created = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "  补充验收标准  ", author: "agent" }),
        headers: { "content-type": "application/json" }
      }));
      const createdEvent = await created.json() as Record<string, unknown>;
      const issue = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));
      const events = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/events`));
      const eventBody = await events.json() as Array<Record<string, unknown>>;

      expect(created.status).toBe(201);
      expect(createdEvent).toMatchObject({ issue_id: issueId, type: "issue.comment" });
      expect(JSON.parse(createdEvent.payload as string)).toEqual({ author: "agent", body: "补充验收标准" });
      expect(await issue.json()).toMatchObject({ id: issueId, comment_count: 1 });
      expect(events.status).toBe(200);
      expect(eventBody.map((event) => event.type)).toEqual([
        "issue.created",
        "issue.status_changed",
        "issue.comment"
      ]);
      expect(eventBody.at(-1)).toMatchObject(createdEvent);
    } finally {
      database.close();
    }
  });

  test("returns explicit errors for empty comments and missing issues", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const router = createDefaultRouter({ database });
      const empty = await postComment(router, issueId, { body: " \n\t ", author: "user" });
      const missingComment = await postComment(router, 404, { body: "hello" });
      const missingEvents = await router.handle(new Request(`${BASE_URL}/api/issues/404/events`));

      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ message: "评论内容不能为空" });
      expect(missingComment.status).toBe(404);
      expect(await missingComment.json()).toEqual({ message: "资源不存在" });
      expect(missingEvents.status).toBe(404);
      expect(await missingEvents.json()).toEqual({ message: "资源不存在" });
    } finally {
      database.close();
    }
  });
});

function postComment(router: ReturnType<typeof createDefaultRouter>, id: number, body: Record<string, unknown>): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
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
    [projectId, "Events API", "triage", "thread-a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertEvent(db: RunnerDatabase, issueId: number, type: string, payload: string, createdAt: string): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueId, type, payload, createdAt]
  );
}
