import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { projectPendingEventSummaries } from "../events/eventSummaryProjector.ts";
import { issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Work timeline HTTP API", () => {
  test("serves opaque cursor pages and stable input errors", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssue(db);
      const workID = issueIDToWorkID(issueID);
      const router = createDefaultRouter({ database: db });
      const first = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent(workID)}/timeline?limit=1`
      ));
      const firstBody = await jsonBody(first);
      const cursor = String(firstBody.next_cursor ?? "");
      const second = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent(workID)}/timeline?limit=1&cursor=${encodeURIComponent(cursor)}`
      ));
      const secondBody = await jsonBody(second);
      const invalidCursor = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent(workID)}/timeline?cursor=not-a-cursor`
      ));
      const invalidLimit = await router.handle(new Request(
        `${BASE_URL}/api/works/${encodeURIComponent(workID)}/timeline?limit=501`
      ));

      expect(first.status).toBe(200);
      expect(firstBody).toMatchObject({
        has_more: true,
        items: [{ kind: "issue_event", summary: "second" }]
      });
      expect(Object.keys(firstBody).sort()).toEqual(["has_more", "items", "next_cursor"]);
      expect(Object.keys((firstBody.items as Record<string, unknown>[])[0] ?? {}).sort()).toEqual([
        "id", "kind", "occurred_at", "status", "summary", "title"
      ]);
      expect(cursor).not.toBe("");
      expect(second.status).toBe(200);
      expect(secondBody).toMatchObject({
        has_more: false,
        items: [{ kind: "work_event", title: "issue.created" }],
        next_cursor: ""
      });
      expect(invalidCursor.status).toBe(400);
      expect(await jsonBody(invalidCursor)).toEqual({
        code: "invalid_cursor",
        message: "Work timeline cursor is invalid"
      });
      expect(invalidLimit.status).toBe(400);
      expect(await jsonBody(invalidLimit)).toEqual({
        code: "invalid_request",
        message: "limit must not exceed 500"
      });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "work-timeline-api-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedIssue(db: RunnerDatabase): number {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/work-timeline-api', ?, ?)`, [
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  db.sqlite.run(`insert into issues (project_id, title, description, status, created_at, updated_at)
    values ('demo', 'Timeline API', 'Timeline API', 'in_progress', ?, ?)`, [
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
  db.sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)", [
    issueID, "issue.created", JSON.stringify({ title: "Timeline API" }), "2026-01-01T00:00:00Z"
  ]);
  db.sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)", [
    issueID, "issue.comment", JSON.stringify({ body: "second" }), "2026-01-01T00:00:01Z"
  ]);
  projectPendingEventSummaries(db);
  return issueID;
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}
