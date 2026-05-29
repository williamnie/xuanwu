import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiMemoryItem, listPiActions, listPiMemoryItems } from "../db/repositories/pi.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-runtime-smoke-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI runtime v1 smoke", () => {
  test("runs conversation to action/memory/SSE without promoting memory candidates", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-smoke-faux-api", provider: "pi-smoke-faux" });
    const bus = new EventBus();
    const events = bus.subscribe();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue.create_proposal", {
            description: "Follow-up body",
            title: "Follow-up issue"
          }, { id: "issue-proposal" }),
          fauxToolCall("memory.write_candidate", {
            kind: "preference",
            content: "Prefer PI memory candidates before long-term memory"
          }, { id: "memory-candidate" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("smoke done")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ bus, database });

      const created = await post(router, "/api/pi/conversations", {
        id: "conv-smoke",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });
      const message = await post(router, "/api/pi/conversations/conv-smoke/messages", {
        prompt: "Create one action and one memory candidate"
      });

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(await message.json()).toMatchObject({
        conversation_id: "conv-smoke",
        status: "completed",
        text: "smoke done"
      });
      expect(listPiActions(database, { status: "pending" }).map((action) => action.action_type))
        .toEqual(["issue.create"]);
      const candidates = listPiMemoryItems(database, { disabled: 1 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: "preference",
        source_id: "conv-smoke",
        source_type: "pi.conversation"
      });
      expect(listPiMemoryItems(database, { disabled: 0 })).toEqual([]);
      expect(getPiMemoryItem(database, candidates[0]?.id ?? "")?.disabled).toBe(1);
      expect(await collectEventTypes(events, 40)).toContain("pi.memory_candidate");
      expect(faux.state.callCount).toBe(2);
    } finally {
      events.close();
      faux.unregister();
      database.close();
    }
  });
});

function post(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

async function collectEventTypes(events: ReturnType<EventBus["subscribe"]>, limit: number): Promise<string[]> {
  const types: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const event = await nextEvent(events);
    if (!event) break;
    types.push(event.type);
    if (types.includes("pi.memory_candidate")) break;
  }
  return types;
}

async function nextEvent(events: ReturnType<EventBus["subscribe"]>) {
  return await Promise.race([
    events.next(),
    Bun.sleep(20).then(() => undefined)
  ]);
}

function insertFauxAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", "pi-smoke-faux", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-smoke-faux": {
        api: "pi-smoke-faux-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}
