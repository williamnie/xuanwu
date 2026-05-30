import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getProjectPiSettings, listPiConversations } from "../db/repositories/pi.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-project-control-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun project PI control API", () => {
  test("run-once starts one PI manager cycle for a project", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-faux-api", provider: "pi-control-faux" });
    let promptContext = "";
    try {
      faux.setResponses([(context) => {
        promptContext = JSON.stringify(context);
        return fauxAssistantMessage("cycle done");
      }]);
      insertProject(database, "demo");
      insertIssue(database, { projectId: "demo", status: "failed", title: "Failed issue" });
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ database });

      const response = await post(router, "/api/projects/demo/pi/run-once");

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        auto_manage: 0,
        project_id: "demo",
        status: "completed",
        text: "cycle done"
      });
      expect(listPiConversations(database, { projectId: "demo" })).toHaveLength(1);
      expect(faux.state.callCount).toBe(1);
      expect(promptContext).toContain("Project status snapshot");
      expect(promptContext).toContain("Failed issue");
      const promptText = JSON.parse(promptContext).messages[0].content[0].text;
      expect(promptText).toContain('"failed": 1');
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("run-once emits needs-user notifications and returns summary/action candidates", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-summary-api", provider: "pi-control-summary" });
    const bus = new EventBus();
    try {
      faux.setResponses([fauxAssistantMessage("cycle done")]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-control-summary");
      writeFauxModelsConfig(database, "pi-control-summary");
      insertIssue(database, {
        error: "approval denied CODEX_API_KEY=fixture-secret at /Users/secret/log.txt",
        projectId: "demo",
        status: "failed",
        title: "Needs user at /Users/secret/project"
      });
      insertIssue(database, {
        autoRetryNextAt: "2026-01-01T01:00:00Z",
        autoRetryReason: "network error",
        projectId: "demo",
        status: "todo",
        title: "Retry candidate"
      });
      const events = bus.subscribe();
      const router = createDefaultRouter({ bus, database });

      const response = await post(router, "/api/projects/demo/pi/run-once");
      const event = await nextEvent(events, "pi.needs_user");
      events.close();
      const body = await response.json() as Record<string, unknown>;
      const notifications = body.notifications as Array<Record<string, unknown>>;
      const actionCandidates = body.action_candidates as Array<Record<string, unknown>>;
      const json = JSON.stringify(body);

      expect(response.status).toBe(201);
      expect(String(body.status_summary)).toContain("findings=2");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ event: "pi.needs_user", issue_id: 1 });
      expect(event).toMatchObject({ type: "pi.needs_user", issueId: 1, projectId: "demo" });
      expect(actionCandidates).toEqual([
        expect.objectContaining({ action_type: "issue.retry_proposal", payload: { issue_id: 2 } })
      ]);
      expect(json).toContain("[redacted]");
      expect(json).toContain("[redacted-path]");
      expect(json).not.toContain("fixture-secret");
      expect(json).not.toContain("/Users/secret");
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("pause and resume persist auto_manage state", async () => {
    let database: RunnerDatabase | undefined = await openFixtureDatabase();
    let restored: RunnerDatabase | undefined;
    try {
      insertProject(database, "demo");
      insertAgent(database, "pi-default", 1);
      const router = createDefaultRouter({ database });

      const paused = await post(router, "/api/projects/demo/pi/pause");
      const resumed = await post(router, "/api/projects/demo/pi/resume");

      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({ project_id: "demo", auto_manage: 0 });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ project_id: "demo", auto_manage: 1 });
      expect(getProjectPiSettings(database, "demo")?.auto_manage).toBe(1);

      const dbPath = database.path;
      database.close();
      database = undefined;
      restored = await openDatabase({ dbPath });
      expect(getProjectPiSettings(restored, "demo")?.auto_manage).toBe(1);
    } finally {
      database?.close();
      restored?.close();
    }
  });

  test("run-once and resume return clear errors when PI agent is missing", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const runOnce = await post(router, "/api/projects/demo/pi/run-once");
      const resume = await post(router, "/api/projects/demo/pi/resume");

      expect(runOnce.status).toBe(400);
      expect(await runOnce.json()).toEqual({ message: "PI agent 不存在" });
      expect(resume.status).toBe(400);
      expect(await resume.json()).toEqual({ message: "PI agent 不存在" });
    } finally {
      database.close();
    }
  });
});

function post(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" }
  }));
}

async function nextEvent(events: ReturnType<EventBus["subscribe"]>, type: string) {
  for (let index = 0; index < 20; index += 1) {
    const event = await events.next();
    if (!event || event.type === type) return event;
  }
  return undefined;
}

function insertAgent(db: RunnerDatabase, id: string, enabled: number): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, enabled, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, enabled, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertFauxAgent(db: RunnerDatabase, provider = "pi-control-faux"): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", provider, "faux-1", "off", 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
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

function insertIssue(db: RunnerDatabase, issue: {
  autoRetryNextAt?: string; autoRetryReason?: string; error?: string; projectId: string; status: string; title: string;
}): void {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, auto_retry_next_at, auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [issue.projectId, issue.title, issue.status, issue.error ?? "",
      issue.autoRetryNextAt ?? "", issue.autoRetryReason ?? "",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase, provider = "pi-control-faux"): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: `${provider}-api`,
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}
