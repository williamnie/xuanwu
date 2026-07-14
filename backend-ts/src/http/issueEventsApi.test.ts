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

  test("filters and pages event history without changing the legacy full-list response", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      insertEvent(database, issueId, "issue.created", "{}", "2026-01-01T00:00:00Z");
      insertEvent(database, issueId, "issue.log", '{"text":"first"}', "2026-01-02T00:00:00Z");
      insertEvent(database, issueId, "issue.status_changed", '{"status":"in_progress"}', "2026-01-03T00:00:00Z");
      insertEvent(database, issueId, "issue.log", '{"text":"second"}', "2026-01-04T00:00:00Z");
      insertEvent(database, issueId, "issue.log", '{"text":"third"}', "2026-01-05T00:00:00Z");
      const router = createDefaultRouter({ database });

      const full = await getEvents(router, issueId);
      const activity = await getEvents(router, issueId, "exclude_type=issue.log");
      const tail = await getEvents(router, issueId, "type=issue.log&limit=2");
      const firstTailID = Number(tail[0]?.id);
      const older = await getEvents(router, issueId, `type=issue.log&limit=2&before_id=${firstTailID}`);
      database.sqlite.run(
        `update issue_events set created_at=? where issue_id=? and payload=?`,
        ["2025-12-01T00:00:00Z", issueId, '{"text":"third"}']
      );
      const after = await getEvents(router, issueId, `after_id=${Number(full[1]?.id)}&limit=2`);

      expect(full.map((event) => event.type)).toEqual([
        "issue.created",
        "issue.log",
        "issue.status_changed",
        "issue.log",
        "issue.log"
      ]);
      expect(activity.map((event) => event.type)).toEqual(["issue.created", "issue.status_changed"]);
      expect(tail.map(eventText)).toEqual(["second", "third"]);
      expect(older.map(eventText)).toEqual(["first"]);
      expect(after.map((event) => event.type)).toEqual(["issue.status_changed", "issue.log"]);
    } finally {
      database.close();
    }
  });

  test("rejects invalid event cursors and oversized pages", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const router = createDefaultRouter({ database });

      const invalidCursor = await router.handle(new Request(
        `${BASE_URL}/api/issues/${issueId}/events?before_id=nope`
      ));
      const conflictingCursors = await router.handle(new Request(
        `${BASE_URL}/api/issues/${issueId}/events?before_id=2&after_id=1`
      ));
      const oversized = await router.handle(new Request(
        `${BASE_URL}/api/issues/${issueId}/events?limit=501`
      ));

      expect(invalidCursor.status).toBe(400);
      expect(await invalidCursor.json()).toEqual({ message: "before_id 必须是正整数" });
      expect(conflictingCursors.status).toBe(400);
      expect(await conflictingCursors.json()).toEqual({ message: "before_id 和 after_id 不能同时使用" });
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toEqual({ message: "limit 不能大于 500" });
    } finally {
      database.close();
    }
  });
});

async function getEvents(
  router: ReturnType<typeof createDefaultRouter>,
  id: number,
  query = ""
): Promise<Array<Record<string, unknown>>> {
  const suffix = query ? `?${query}` : "";
  const response = await router.handle(new Request(`${BASE_URL}/api/issues/${id}/events${suffix}`));
  expect(response.status).toBe(200);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

function eventText(event: Record<string, unknown>): string {
  return JSON.parse(String(event.payload || "{}")).text || "";
}

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
