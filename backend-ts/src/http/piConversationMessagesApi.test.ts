import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-message-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI conversation message API", () => {
  test("sends PI messages and publishes conversation SSE events only", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-test-faux-api", provider: "pi-test-faux" });
    try {
      faux.setResponses([fauxAssistantMessage("pi reply")]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const bus = new EventBus();
      const events = bus.subscribe();
      const router = createDefaultRouter({ bus, database });

      const created = await request(router, "/api/pi/conversations", {
        id: "conv-msg",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });
      const message = await request(router, "/api/pi/conversations/conv-msg/messages", {
        prompt: "hello"
      });

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(await message.json()).toMatchObject({
        conversation_id: "conv-msg",
        pi_session_id: "conv-msg",
        status: "completed",
        text: "pi reply",
        message_count: 2
      });
      const firstEvent = await events.next();
      events.close();
      expect(firstEvent).toMatchObject({
        type: "pi.conversation.event",
        conversationId: "conv-msg",
        projectId: "demo",
        provider: "pi-sdk"
      });
      expect(firstEvent?.issueId).toBeUndefined();
      expect(faux.state.callCount).toBe(1);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("interrupts a running PI conversation", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({
      api: "pi-test-faux-api",
      provider: "pi-test-faux",
      tokenSize: { min: 1, max: 1 },
      tokensPerSecond: 1
    });
    try {
      faux.setResponses([fauxAssistantMessage("slow response")]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-interrupt",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });

      const running = request(router, "/api/pi/conversations/conv-interrupt/messages", {
        prompt: "please stream slowly"
      });
      await until(() => faux.state.callCount > 0);
      const interrupt = await router.handle(new Request(
        `${BASE_URL}/api/pi/conversations/conv-interrupt/interrupt`,
        { method: "POST" }
      ));
      const result = await running;

      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toMatchObject({ interrupted: true, conversation_id: "conv-interrupt" });
      expect(result.status).toBe(201);
      expect(await result.json()).toMatchObject({ conversation_id: "conv-interrupt", status: "failed", text: "" });
    } finally {
      faux.unregister();
      database.close();
    }
  });
});

function request(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function insertFauxAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", "pi-test-faux", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-test-faux": {
        api: "pi-test-faux-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition timed out");
}
