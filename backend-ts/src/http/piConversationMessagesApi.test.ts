import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
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
        title: "hello",
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

  test("derives stable conversation title from markdown prompt", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-title-faux-api", provider: "pi-title-faux" });
    try {
      faux.setResponses([fauxAssistantMessage("ok")]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-title-faux");
      writeFauxModelsConfig(database, "pi-title-faux");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-title", project_id: "demo", pi_agent_id: "pi-faux", title: "New conversation"
      });
      const message = await request(router, "/api/pi/conversations/conv-title/messages", {
        prompt: "帮我看下 **Runner Markdown** 渲染"
      });
      expect(message.status).toBe(201);
      expect(await message.json()).toMatchObject({ conversation_id: "conv-title", title: "帮我看下 Runner Markdown 渲染" });
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("reads persisted PI conversation transcript for history switching", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertFauxAgent(database);
      const sessionFile = writeConversationSession(database, "conv-history", [
        sessionMessage("user-1", "user", "hello runner"),
        sessionMessage("assistant-1", "assistant", "history reply")
      ]);
      insertConversation(database, {
        id: "conv-history",
        projectId: "demo",
        sessionFile
      });
      const response = await createDefaultRouter({ database })
        .handle(new Request(`${BASE_URL}/api/pi/conversations/conv-history`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.message_count).toBe(2);
      expect(body.transcript).toEqual([
        {
          id: "user-1",
          role: "user",
          text: "hello runner",
          created_at: "2026-01-01T00:00:00Z",
          meta: { conversation_id: "conv-history", pi_session_id: "conv-history" }
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "history reply",
          created_at: "2026-01-01T00:00:00Z",
          meta: { conversation_id: "conv-history", pi_session_id: "conv-history" }
        }
      ]);
    } finally {
      database.close();
    }
  });

  test("returns provider errors as visible Runner text", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-error-faux-api", provider: "pi-error-faux" });
    try {
      const errorReply = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "fatal provider failure CODEX_API_KEY=fixture-secret"
      });
      faux.setResponses([errorReply]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-error-faux");
      writeFauxModelsConfig(database, "pi-error-faux");
      const router = createDefaultRouter({ database });
      await request(router, "/api/pi/conversations", {
        id: "conv-provider-error",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });

      const message = await request(router, "/api/pi/conversations/conv-provider-error/messages", {
        prompt: "hello"
      });
      const body = await message.json() as Record<string, unknown>;

      expect(message.status).toBe(201);
      expect(body.status).toBe("failed");
      expect(body.text).toContain("Runner 执行失败：fatal provider failure");
      expect(body.text).toContain("CODEX_API_KEY=[redacted]");
      expect(JSON.stringify(body)).not.toContain("fixture-secret");
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

function insertFauxAgent(db: RunnerDatabase, provider = "pi-test-faux"): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", provider, "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(
  db: RunnerDatabase,
  provider = "pi-test-faux",
  modelOverride: Record<string, unknown> = {}
): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: `${provider}-api`,
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1", ...modelOverride }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}

function insertConversation(
  db: RunnerDatabase,
  input: { id: string; projectId: string; sessionFile: string }
): void {
  db.sqlite.run(
    `insert into pi_conversations
      (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.projectId, "pi-faux", "History", "active", input.sessionFile,
      input.id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeConversationSession(
  db: RunnerDatabase,
  id: string,
  entries: Array<Record<string, unknown>>
): string {
  const dir = join(db.path, "..", "pi-runtime", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `fixture_${id}.jsonl`);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

function sessionMessage(id: string, role: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role, content: [{ type: "text", text }] }
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition timed out");
}
