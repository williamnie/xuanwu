import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI verifier workflow control", () => {
  test("manager cycle can propose verifier and reviewer workflows", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-verifier-api", provider: "pi-control-verifier" });
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("verification_workflow_request", { target_issue_id: 1, instructions: "verify evidence" }, { id: "verifier" }),
          fauxToolCall("review_workflow_request", { target_issue_id: 1, instructions: "review result quality" }, { id: "reviewer" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("cycle done")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      insertIssue(database, "demo");

      const response = await post(createDefaultRouter({ database }), "/api/projects/demo/pi/run-once");
      const pending = listPiActions(database, { status: "pending" });

      expect(response.status).toBe(201);
      expect(pending.map((item) => item.action_type)).toEqual(["agent.workflow_request", "agent.workflow_request"]);
      expect(pending.map((item) => item.issue_id)).toEqual([1, 1]);
      expect(pending.every((item) => item.gate_decision === "ask")).toBe(true);
    } finally {
      faux.unregister();
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-verifier-control-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertFauxAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set model_provider=excluded.model_provider,
       model_id=excluded.model_id, thinking_level=excluded.thinking_level, enabled=excluded.enabled`,
    ["runner-default", "PI Faux", "pi-control-verifier", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, "Needs verifier", "pending_verification", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-control-verifier": {
        api: "pi-control-verifier-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
}

function post(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, { method: "POST" }));
}
