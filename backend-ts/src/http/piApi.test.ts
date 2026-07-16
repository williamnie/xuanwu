import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
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
  test("keeps the public PI agent API scoped to the default runner agent", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const created = await request(router, "/api/pi/agents", "POST", {
        id: "another-agent",
        name: "Another PI"
      });
      expect(created.status).toBe(405);

      const read = await router.handle(new Request(`${BASE_URL}/api/pi/agents/runner-default`));
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        id: "runner-default",
        name: "Xuanwu Supervisor",
        provider: "pi-sdk",
        thinking_level: "medium",
        cwd_policy: "project",
        instructions: expect.stringContaining("Engineering Chief of Staff"),
        enabled: 1
      });

      const patched = await request(router, "/api/pi/agents/runner-default", "PATCH", {
        model_provider: "openai",
        model_id: "gpt-5.4",
        instructions: "CODEX_API_KEY=fixture-secret\n每轮先总结 Runner 风险。",
        enabled: false
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        id: "runner-default",
        model_provider: "openai",
        model_id: "gpt-5.4",
        enabled: 0
      });

      const promptSummary = await router.handle(new Request(`${BASE_URL}/api/pi/agents/runner-default/runtime-prompt`));
      const promptSummaryBody = await promptSummary.json() as Record<string, unknown>;
      expect(promptSummary.status).toBe(200);
      expect(JSON.stringify(promptSummaryBody)).not.toContain("fixture-secret");
      expect(promptSummaryBody).toMatchObject({
        agent_id: "runner-default",
        runtime_prompt_summary: {
          custom_instructions_configured: true,
          injected_after: "core Supervisor role/safety/tool/MCP constraints"
        }
      });

      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/agents`));
      expect(listed.status).toBe(200);
      expect((await listed.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["runner-default"]);

      const deleted = await router.handle(new Request(`${BASE_URL}/api/pi/agents/runner-default`, { method: "DELETE" }));
      const stillThere = await router.handle(new Request(`${BASE_URL}/api/pi/agents/runner-default`));
      expect(deleted.status).toBe(405);
      expect(stillThere.status).toBe(200);
    } finally {
      database.close();
    }
  });

  test("reads and updates project PI settings with default values", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const initial = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi-settings`));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        project_id: "demo",
        pi_agent_id: "runner-default",
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
        pi_agent_id: "runner-default",
        auto_manage: 1,
        auto_triage: 1,
        auto_enqueue: 0,
        max_actions_per_cycle: 3
      });
    } finally {
      database.close();
    }
  });


  test("creates and reads PI conversations with SDK session metadata", async () => {
    let database: RunnerDatabase | undefined = await openFixtureDatabase();
    let restored: RunnerDatabase | undefined;
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/conversations", "POST", {
        id: "conv-1",
        project_id: "demo",
        title: "Plan"
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as Record<string, unknown>;
      expect(createdBody).toMatchObject({
        id: "conv-1",
        project_id: "demo",
        pi_agent_id: "runner-default",
        pi_session_id: "conv-1",
        status: "active",
        title: "Plan"
      });
      expect(String(createdBody.session_file)).toContain("pi-runtime/sessions/");
      expect(String(createdBody.session_file)).toContain("_conv-1.jsonl");
      expect(existsSync(String(createdBody.session_file))).toBe(true);
      expect(getAgentSession(database, "pi-sdk:conv-1")).toMatchObject({
        provider: "pi-sdk",
        provider_session_id: "conv-1",
        agent_role: "pi_manager",
        project_id: "demo",
        status: "active",
        title: "Plan"
      });

      const dbPath = database.path;
      database.close();
      database = undefined;
      restored = await openDatabase({ dbPath });
      const restoredRouter = createDefaultRouter({ database: restored });
      const detail = await restoredRouter.handle(new Request(`${BASE_URL}/api/pi/conversations/conv-1`));
      const list = await restoredRouter.handle(new Request(`${BASE_URL}/api/pi/conversations?project_id=demo`));

      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: "conv-1",
        project_id: "demo",
        pi_session_id: "conv-1",
        session_file: createdBody.session_file
      });
      expect(list.status).toBe(200);
      expect((await list.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["conv-1"]);
      expect(getAgentSession(restored, "pi-sdk:conv-1")?.provider).toBe("pi-sdk");
    } finally {
      database?.close();
      restored?.close();
    }
  });

  test("creates global Runner conversations without binding a project", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/conversations", "POST", {
        id: "runner-global",
        title: "Runner"
      });

      expect(created.status).toBe(201);
      const body = await created.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        id: "runner-global",
        project_id: "",
        pi_agent_id: "runner-default",
        pi_session_id: "runner-global",
        status: "active",
        title: "Runner"
      });
      expect(String(body.session_file)).toContain(".runner/sessions/runner/");
      expect(String(body.session_file)).toContain("_runner-global.jsonl");
      expect(existsSync(String(body.session_file))).toBe(true);
      expect(getAgentSession(database, "pi-sdk:runner-global")).toMatchObject({
        provider: "pi-sdk",
        provider_session_id: "runner-global",
        agent_role: "pi_manager",
        project_id: "",
        status: "active",
        title: "Runner"
      });
    } finally {
      database.close();
    }
  });

  test("does not expose public PI agent creation even for invalid write payloads", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const missingID = await request(router, "/api/pi/agents", "POST", { name: "Missing ID" });
      const invalidJson = await router.handle(new Request(`${BASE_URL}/api/pi/agents`, {
        method: "POST",
        body: "{bad-json",
        headers: { "content-type": "application/json" }
      }));

      expect(missingID.status).toBe(405);
      expect(await missingID.json()).toEqual({ message: "method not allowed" });
      expect(invalidJson.status).toBe(405);
      expect(await invalidJson.json()).toEqual({ message: "method not allowed" });
    } finally {
      database.close();
    }
  });

  test("recovers the default assistant for settings and chat when PI agents are empty", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      database.sqlite.run("delete from pi_agents");

      const settingsAgents = await router.handle(new Request(`${BASE_URL}/api/pi/agents`));
      expect(settingsAgents.status).toBe(200);
      expect((await settingsAgents.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["runner-default"]);

      database.sqlite.run("delete from pi_agents");
      const conversation = await request(router, "/api/pi/conversations", "POST", {
        id: "empty-agents-chat",
        title: "New conversation"
      });

      expect(conversation.status).toBe(201);
      expect(await conversation.json()).toMatchObject({
        id: "empty-agents-chat",
        pi_agent_id: "runner-default",
        status: "active"
      });
    } finally {
      database.close();
    }
  });

  test("rejects project settings that would auto-use a disabled PI agent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertAgent(database, "pi-disabled", 0);
      const router = createDefaultRouter({ database });

      const disabledAgent = await request(router, "/api/projects/demo/pi-settings", "PATCH", {
        pi_agent_id: "pi-disabled",
        auto_manage: 1
      });
      const autoManaged = await request(router, "/api/projects/demo/pi-settings", "PATCH", {
        pi_agent_id: "runner-default",
        auto_manage: 1
      });
      const disabledAfterEnable = await request(router, "/api/pi/agents/runner-default", "PATCH", { enabled: 0 });

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
