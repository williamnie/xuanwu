import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getProjectPiSettings, listPiActionEvents, listPiActions, listPiConversations, listPiMemoryItems } from "../db/repositories/pi.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
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
      expect(promptContext).toContain("Issue state diagnostics");
      expect(promptContext).toContain("Failed issue");
      const promptText = JSON.parse(promptContext).messages[0].content[0].text;
      expect(promptText).toContain('"failed": 1');
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("issue-state endpoint returns diagnostics and batch target progress", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const weakDone = insertIssue(database, { projectId: "demo", status: "done", title: "Weak done" });
      const pending = insertIssue(database, { projectId: "demo", status: "todo", title: "Todo target" });
      const router = createDefaultRouter({ database });

      const path = `/api/projects/demo/pi/issue-state?target_issue_ids=${weakDone},${pending}&target_label=tonight&target_status=done&deadline_at=2026-01-01T23:59:59Z`;
      const response = await router.handle(new Request(`${BASE_URL}${path}`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ batch_targets: [expect.objectContaining({ done: 1, label: "tonight", off_track_issue_ids: [pending] })] });
      expect(JSON.stringify(body.diagnostics)).not.toContain(`"issue_id":${weakDone}`);
    } finally {
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
      expect(actionCandidates).toContainEqual(expect.objectContaining({ action_type: "issue.retry_proposal", payload: { issue_id: 2 } }));
      expect(actionCandidates).toContainEqual(expect.objectContaining({ action_type: "issue.state_repair", issue_id: 1 }));
      expect(json).toContain("[redacted]");
      expect(json).toContain("[redacted-path]");
      expect(json).not.toContain("fixture-secret");
      expect(json).not.toContain("/Users/secret");
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("manager cycle runs PI tools in delegated mode and denies uncovered mutations", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-delegated-api", provider: "pi-control-delegated" });
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_comment", { issue_id: 1, body: "delegated mutation" }, { id: "comment" }),
          fauxToolCall("memory_write_candidate", {
            kind: "preference",
            content: "must not write memory"
          }, { id: "memory" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("cycle done")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-control-delegated");
      writeFauxModelsConfig(database, "pi-control-delegated");
      insertIssue(database, { projectId: "demo", status: "todo", title: "Do not mutate" });
      const router = createDefaultRouter({ database });

      const response = await post(router, "/api/projects/demo/pi/run-once");
      const denied = listPiActions(database, { status: "denied" });
      const audit = listPiActionEvents(database, { actionId: denied[0]?.id ?? "" });

      expect(response.status).toBe(201);
      expect(denied).toContainEqual(expect.objectContaining({
        action_type: "issue.comment",
        delegation_id: expect.stringContaining("demo"),
        gate_decision: "deny",
        heartbeat_id: expect.stringContaining("pi-cycle")
      }));
      expect(audit.map((event) => event.event_type)).toEqual(["candidate", "gate_decision"]);
      expect(audit[1]).toMatchObject({ decision: "deny" });
      expect(listEvents(database)).toEqual([]);
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

  test("run-once and resume use the bootstrapped default PI agent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const runOnce = await post(router, "/api/projects/demo/pi/run-once");
      const resume = await post(router, "/api/projects/demo/pi/resume");

      expect(runOnce.status).toBe(400);
      expect(String((await runOnce.json() as Record<string, unknown>).message)).toContain("No API key found for openai");
      expect(resume.status).toBe(200);
      expect(await resume.json()).toMatchObject({ project_id: "demo", pi_agent_id: "runner-default", auto_manage: 1 });
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
    `update pi_agents
       set name=?, model_provider=?, model_id=?, thinking_level=?, enabled=?, updated_at=?
     where id=?`,
    ["PI Faux", provider, "faux-1", "off", 1, "2026-01-01T00:00:00Z", "runner-default"]
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
}): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, auto_retry_next_at, auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [issue.projectId, issue.title, issue.status, issue.error ?? "",
      issue.autoRetryNextAt ?? "", issue.autoRetryReason ?? "",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
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
function listEvents(db: RunnerDatabase): Array<{ type: string }> {
  return db.sqlite.query<{ type: string }, []>("select type from issue_events order by id asc").all();
}
