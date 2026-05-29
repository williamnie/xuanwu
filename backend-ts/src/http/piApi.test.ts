import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI settings API", () => {
  test("performs PI agent CRUD through HTTP", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const created = await request(router, "/api/pi/agents", "POST", {
        id: "pi-default",
        name: "Default PI",
        tools_json: ["read", "grep"]
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "pi-default",
        name: "Default PI",
        provider: "pi-sdk",
        thinking_level: "medium",
        cwd_policy: "project",
        tools_json: "[\"read\",\"grep\"]",
        enabled: 1
      });

      const read = await router.handle(new Request(`${BASE_URL}/api/pi/agents/pi-default`));
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ id: "pi-default", name: "Default PI" });

      const patched = await request(router, "/api/pi/agents/pi-default", "PATCH", {
        model_provider: "openai",
        model_id: "gpt-5.4",
        enabled: false
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        id: "pi-default",
        model_provider: "openai",
        model_id: "gpt-5.4",
        enabled: 0
      });

      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/agents`));
      expect(listed.status).toBe(200);
      expect((await listed.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["pi-default"]);

      const deleted = await router.handle(new Request(`${BASE_URL}/api/pi/agents/pi-default`, { method: "DELETE" }));
      const missing = await router.handle(new Request(`${BASE_URL}/api/pi/agents/pi-default`));
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
      expect(missing.status).toBe(404);
    } finally {
      database.close();
    }
  });

  test("reads and updates project PI settings with default values", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertAgent(database, "pi-default", 1);
      const router = createDefaultRouter({ database });

      const initial = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi-settings`));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        project_id: "demo",
        pi_agent_id: "pi-default",
        auto_manage: 0,
        auto_triage: 0,
        auto_enqueue: 0,
        notify_on_needs_user: 1,
        max_actions_per_cycle: 5
      });

      const patched = await request(router, "/api/projects/demo/pi-settings", "PATCH", {
        auto_manage: true,
        auto_triage: 1,
        auto_enqueue: false,
        max_actions_per_cycle: 3
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        project_id: "demo",
        pi_agent_id: "pi-default",
        auto_manage: 1,
        auto_triage: 1,
        auto_enqueue: 0,
        max_actions_per_cycle: 3
      });
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid PI agent writes", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const missingID = await request(router, "/api/pi/agents", "POST", { name: "Missing ID" });
      const invalidJson = await router.handle(new Request(`${BASE_URL}/api/pi/agents`, {
        method: "POST",
        body: "{bad-json",
        headers: { "content-type": "application/json" }
      }));

      expect(missingID.status).toBe(400);
      expect(await missingID.json()).toEqual({ message: "id is required" });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toEqual({ message: "请求体不是合法 JSON" });
    } finally {
      database.close();
    }
  });

  test("rejects project settings that would auto-use a disabled PI agent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertAgent(database, "pi-default", 1);
      insertAgent(database, "pi-disabled", 0);
      const router = createDefaultRouter({ database });

      const disabledAgent = await request(router, "/api/projects/demo/pi-settings", "PATCH", {
        pi_agent_id: "pi-disabled",
        auto_manage: 1
      });
      const autoManaged = await request(router, "/api/projects/demo/pi-settings", "PATCH", {
        pi_agent_id: "pi-default",
        auto_manage: 1
      });
      const disabledAfterEnable = await request(router, "/api/pi/agents/pi-default", "PATCH", { enabled: 0 });

      expect(disabledAgent.status).toBe(400);
      expect(await disabledAgent.json()).toEqual({ message: "disabled PI agent cannot be used automatically" });
      expect(autoManaged.status).toBe(200);
      expect(disabledAfterEnable.status).toBe(400);
      expect(await disabledAfterEnable.json()).toEqual({ message: "enabled=false would disable an automatically managed PI agent" });
    } finally {
      database.close();
    }
  });
});

function request(router: ReturnType<typeof createDefaultRouter>, path: string, method: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function insertAgent(db: RunnerDatabase, id: string, enabled: number): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, enabled, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, enabled, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
