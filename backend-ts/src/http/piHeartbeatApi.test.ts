import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiHeartbeatRun } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat API", () => {
  test("runs one project heartbeat and exposes diagnostics timeline", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertIssue(database, "demo", "failed", "unexpected eof");
      const router = createDefaultRouter({ database });

      const run = await request(router, "/api/projects/demo/pi/heartbeat/run-once", "POST", {});
      expect(run.status).toBe(201);
      const result = await run.json() as Record<string, unknown>;
      expect(result).toMatchObject({
        action_candidates: [],
        actions_proposed: 0,
        project_id: "demo",
        status: "completed"
      });

      const diagnostics = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi/heartbeat/diagnostics`));
      expect(diagnostics.status).toBe(200);
      const body = await diagnostics.json() as Record<string, unknown>;
      expect(body.control).toBeNull();
      expect((body.recent_runs as Array<Record<string, unknown>>)[0]).toMatchObject({ id: result.heartbeat_id, status: "completed" });
      expect((body.recent_events as Array<Record<string, unknown>>).map((event) => event.event_type)).toContain("schedule_next_tick");
    } finally {
      database.close();
    }
  });

  test("pauses and resumes project heartbeat via HTTP", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const paused = await request(router, "/api/projects/demo/pi/heartbeat/pause", "POST", { reason: "maintenance" });
      const skipped = await request(router, "/api/projects/demo/pi/heartbeat/run-once", "POST", {});
      const resumed = await request(router, "/api/projects/demo/pi/heartbeat/resume", "POST", {});

      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({ paused: 1, reason: "maintenance" });
      expect(await skipped.json()).toMatchObject({ status: "skipped", skip_reason: "heartbeat is paused" });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ paused: 0 });
    } finally {
      database.close();
    }
  });

  test("diagnostics exposes active paused and last_error status", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      createPiHeartbeatRun(database, {
        error: "collector boom",
        finished_at: "2026-06-02T09:02:00Z",
        id: "hb-failed",
        kind: "project",
        project_id: "demo",
        started_at: "2026-06-02T09:01:00Z",
        status: "failed"
      });
      const router = createDefaultRouter({ database });

      const active = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi/heartbeat/diagnostics`));
      await request(router, "/api/projects/demo/pi/heartbeat/pause", "POST", { reason: "maintenance" });
      const paused = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi/heartbeat/diagnostics`));

      expect(await active.json()).toMatchObject({ active: true, last_error: "collector boom", paused: false, status: "active" });
      expect(await paused.json()).toMatchObject({ active: false, last_error: "collector boom", paused: true, status: "paused" });
    } finally {
      database.close();
    }
  });

  test("returns skipped for concurrent project heartbeat HTTP calls", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const responses = await Promise.all([
        request(router, "/api/projects/demo/pi/heartbeat/run-once", "POST", {}),
        request(router, "/api/projects/demo/pi/heartbeat/run-once", "POST", {})
      ]);
      const bodies = await Promise.all(responses.map((response) => response.json() as Promise<Record<string, unknown>>));

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(bodies.map((body) => body.status).sort()).toEqual(["completed", "skipped"]);
      expect(bodies).toContainEqual(expect.objectContaining({ skip_reason: "heartbeat already running" }));
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-heartbeat-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function request(router: ReturnType<typeof createDefaultRouter>, path: string, method: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, error: string): void {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, `${status} issue`, status, error, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}
