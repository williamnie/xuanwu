import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActions, listPiConversations, listPiMemoryItems } from "../db/repositories/pi.ts";
import { gatePiActionEnvelope } from "../pi/actionGate.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun project PI control regressions", () => {
  test("manager cycle allows delegated SDK read-only tools", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");

      expect(delegatedSdkDecisions("demo")).toEqual([
        { action_type: "sdk.read", decision: "execute" },
        { action_type: "sdk.grep", decision: "execute" },
        { action_type: "sdk.find", decision: "execute" },
        { action_type: "sdk.ls", decision: "execute" }
      ]);
    } finally {
      database.close();
    }
  });

  test("manager cycle writes memory candidates only as disabled review items", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-memory-api", provider: "pi-control-memory" });
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("memory_search", { query: "anything" }, { id: "memory-search" }),
          fauxToolCall("memory_write_candidate", {
            content: "must not write memory",
            kind: "preference"
          }, { id: "memory-write" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("cycle done")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-control-memory");
      writeFauxModelsConfig(database, "pi-control-memory");
      const router = createDefaultRouter({ database });

      const response = await post(router, "/api/projects/demo/pi/run-once");

      expect(response.status).toBe(201);
      expect(listPiActions(database, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "memory.search",
        gate_decision: "execute"
      }));
      expect(listPiActions(database, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "memory.write_candidate",
        gate_decision: "execute"
      }));
      expect(listPiMemoryItems(database, { disabled: 1 })).toEqual([
        expect.objectContaining({
          content: "must not write memory",
          disabled: 1,
          kind: "preference",
          scope: "project",
          scope_id: "demo",
          source_type: "pi.manager_cycle"
        })
      ]);
      expect(listPiMemoryItems(database, { disabled: 0 })).toEqual([]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("run-once rejects concurrent manager cycles for the same project", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-race-api", provider: "pi-control-race" });
    try {
      faux.setResponses([fauxAssistantMessage("cycle one"), fauxAssistantMessage("cycle two")]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-control-race");
      writeFauxModelsConfig(database, "pi-control-race");
      const router = createDefaultRouter({ database });

      const responses = await Promise.all([
        post(router, "/api/projects/demo/pi/run-once"),
        post(router, "/api/projects/demo/pi/run-once")
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(listPiConversations(database, { projectId: "demo" })).toHaveLength(1);
    } finally {
      faux.unregister();
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-project-control-regression-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function delegatedSdkDecisions(projectID: string): Array<{ action_type: string; decision: string }> {
  const policy = managerPolicy(projectID);
  return ["sdk.read", "sdk.grep", "sdk.find", "sdk.ls"].map((actionType) => ({
    action_type: actionType,
    decision: gatePiActionEnvelope({
      action_type: actionType,
      delegation_id: `pi-cycle:${projectID}`,
      heartbeat_id: `pi-cycle:${projectID}:test`,
      payload: {},
      project_id: projectID,
      requires_confirmation: false,
      risk_level: "low",
      source: "pi_sdk_tool"
    }, policy).decision
  }));
}

function managerPolicy(projectID: string) {
  return {
    authorizedActions: [
      { action_type: "issue.list", project_id: projectID },
      { action_type: "issue.read", project_id: projectID },
      { action_type: "issue.state_diagnose", project_id: projectID },
      { action_type: "project.list" },
      { action_type: "project.status", project_id: projectID },
      { action_type: "session.list", project_id: projectID },
      { action_type: "session.read_summary", project_id: projectID },
      { action_type: "memory.search", project_id: projectID },
      { action_type: "sdk.read", project_id: projectID },
      { action_type: "sdk.grep", project_id: projectID },
      { action_type: "sdk.find", project_id: projectID },
      { action_type: "sdk.ls", project_id: projectID }
    ],
    mode: "delegated" as const,
    scope: { project_id: projectID }
  };
}

function post(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertFauxAgent(db: RunnerDatabase, provider: string): void {
  db.sqlite.run(
    `update pi_agents
       set name=?, model_provider=?, model_id=?, thinking_level=?, enabled=?, updated_at=?
     where id=?`,
    ["PI Faux", provider, "faux-1", "off", 1, "2026-01-01T00:00:00Z", "runner-default"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase, provider: string): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { [provider]: { api: `${provider}-api`, apiKey: "test", baseUrl: "http://localhost:0", models: [{ id: "faux-1" }] } }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}
