import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issues-page-smoke-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun Issues page write smoke", () => {
  test("covers create edit comment enqueue retry cancel delete API flow used by the frontend", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const created = await requestJSON(router, "/api/issues", "POST", {
        description: "Smoke body",
        project_id: "demo",
        status: "triage",
        title: "Issues smoke"
      }, 201);
      const id = Number(created.id);

      const edited = await requestJSON(router, `/api/issues/${id}`, "PATCH", {
        description: "Edited body",
        priority: 1,
        title: "Edited smoke"
      });
      const comment = await requestJSON(router, `/api/issues/${id}/comments`, "POST", {
        author: "user",
        body: "补充 smoke comment"
      }, 201);
      const enqueued = await requestJSON(router, `/api/issues/${id}/enqueue`, "POST", {});
      const retry = await requestJSON(router, `/api/issues/${id}/retry`, "POST", {});
      const cancelled = await requestJSON(router, `/api/issues/${id}/cancel`, "POST", {});
      const events = await requestJSON(router, `/api/issues/${id}/events`, "GET") as Array<Record<string, unknown>>;
      const issues = await requestJSON(router, "/api/issues?projectId=demo", "GET") as Array<Record<string, unknown>>;
      const deleted = await requestNoContent(router, `/api/issues/${id}`, "DELETE");
      const afterDelete = await requestJSON(router, "/api/issues?projectId=demo", "GET") as Array<Record<string, unknown>>;

      expect(edited).toMatchObject({ description: "Edited body", priority: 1, title: "Edited smoke" });
      expect(comment).toMatchObject({ issue_id: id, type: "issue.comment" });
      expect(enqueued).toMatchObject({ id, status: "todo" });
      expect(retry).toMatchObject({ id, status: "todo" });
      expect(cancelled).toMatchObject({ id, status: "cancelled" });
      expect(events.map((event) => event.type)).toEqual([
        "issue.created",
        "issue.comment",
        "issue.status_changed",
        "issue.status_changed",
        "issue.status_changed"
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ id, comment_count: 1, status: "cancelled" });
      expect(deleted.status).toBe(204);
      expect(afterDelete).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

async function requestNoContent(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  method: string
): Promise<Response> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, { method }));
  expect(response.status).toBe(204);
  return response;
}

async function requestJSON(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  expectedStatus = 200
): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" }
  }));
  expect(response.status).toBe(expectedStatus);
  return await response.json() as Record<string, unknown> | Array<Record<string, unknown>>;
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
