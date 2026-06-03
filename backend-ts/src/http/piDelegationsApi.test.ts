import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI delegations API", () => {
  test("creates, lists, pauses, and resumes authorization windows", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/delegations", "POST", {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          audit_source: "api-test",
          expires_at: "2026-06-04T08:00:00Z",
          forbidden_actions: ["session.steer"],
          mode: "delegated",
          scope: { project_id: "demo" },
          starts_at: "2026-06-03T20:00:00Z"
        },
        intent: { goal: "clear failed issues overnight" },
        next_heartbeat_at: "2026-06-03T21:00:00Z",
        project_id: "demo",
        title: "Night autonomous window"
      });
      const body = await created.json() as Record<string, unknown>;
      const id = String(body.id);
      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/delegations?project_id=demo&status=active`));
      const paused = await request(router, `/api/pi/delegations/${id}/pause`, "POST", {});
      const resumed = await request(router, `/api/pi/delegations/${id}/resume`, "POST", {});

      expect(created.status).toBe(201);
      expect(body).toMatchObject({
        allowed_actions_json: "[\"issue.enqueue\"]",
        audit_source: "api-test",
        expires_at: "2026-06-04T08:00:00Z",
        forbidden_actions_json: "[\"session.steer\"]",
        project_id: "demo",
        scope_json: "{\"project_id\":\"demo\"}",
        starts_at: "2026-06-03T20:00:00Z",
        status: "active",
        title: "Night autonomous window"
      });
      expect(String(body.authorization_json)).toContain("issue.enqueue");
      expect((await listed.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([id]);
      expect(await paused.json()).toMatchObject({ id, status: "paused" });
      expect(await resumed.json()).toMatchObject({ id, status: "active" });
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-delegations-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function request(router: ReturnType<typeof createDefaultRouter>, path: string, method: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  }));
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}
