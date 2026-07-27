import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listPiActionEvents, listPiActions, listPiConversations, listPiMemoryItems } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { EventBus } from "../events/bus.ts";
import { gatePiActionEnvelope } from "../pi/actionGate.ts";
import { createDefaultRouter } from "./server.ts";
import { managerCycleAuthorization } from "./piProjectControlAuthorization.ts";

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
  test("run-once delegates to the Agentic Worker when configured", async () => {
    const database = await openFixtureDatabase();
    const calls: unknown[] = [];
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({
        agenticClient: {
          activity: () => ({ in_flight: 0, last_activity_at: "" }),
          decideCommunication: async () => ({ decision: "suppress", message: "", rationale: "test" }),
          decideSupervisor: async () => { throw new Error("not used"); },
          health: async () => ({ ok: true, role: "agentic" }),
          runProjectCycle: async (input) => {
            calls.push(input);
            return { managed: true, project_id: input.projectId, status: "completed", text: "remote" };
          }
        },
        database
      });

      const response = await post(router, "/api/projects/demo/pi/run-once");

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ project_id: "demo", status: "completed", text: "remote" });
      expect(calls).toEqual([{ maxActions: 5, projectId: "demo" }]);
      expect(listPiConversations(database, { includeInternal: true, projectId: "demo" })).toEqual([]);
    } finally {
      database.close();
    }
  });

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
        managed: true,
        project_id: "demo",
        status: "completed",
        text: "cycle done"
      });
      const conversations = listPiConversations(database, { includeInternal: true, projectId: "demo" });
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({ status: "completed" });
      expect(getAgentSession(database, `pi-sdk:${conversations[0]?.pi_session_id}`))
        .toMatchObject({ status: "completed" });
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

  test("run-once terminalizes failed provider cycles", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-control-error-api", provider: "pi-control-error" });
    try {
      faux.setResponses([fauxAssistantMessage([], {
        errorMessage: "provider failed",
        stopReason: "error"
      })]);
      insertProject(database, "demo");
      insertFauxAgent(database, "pi-control-error");
      writeFauxModelsConfig(database, "pi-control-error");
      const router = createDefaultRouter({ database });

      const response = await post(router, "/api/projects/demo/pi/run-once");

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ status: "failed" });
      const [conversation] = listPiConversations(database, { includeInternal: true, projectId: "demo" });
      expect(conversation).toMatchObject({ status: "failed" });
      expect(getAgentSession(database, `pi-sdk:${conversation?.pi_session_id}`))
        .toMatchObject({ status: "failed" });
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

  test("run-once returns observations without manufacturing notifications or action candidates", async () => {
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
      const router = createDefaultRouter({ bus, database });

      const response = await post(router, "/api/projects/demo/pi/run-once");
      const body = await response.json() as Record<string, unknown>;
      const notifications = body.notifications as Array<Record<string, unknown>>;
      const json = JSON.stringify(body);

      expect(response.status).toBe(201);
      expect(String(body.status_summary)).toContain("findings=2");
      expect(notifications).toEqual([]);
      expect(body).not.toHaveProperty("action_candidates");
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
          fauxToolCall("memory_remember", {
            kind: "decision",
            content: "当前 demo 全部终态，没有未完成 Work。",
            memory_key: "project.current-status",
            scope: "project"
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
      expect(listPiActions(database, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "memory.remember"
      }));
      expect(listPiMemoryItems(database)).toEqual([]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("does not expose pause or resume mode endpoints", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const paused = await post(router, "/api/projects/demo/pi/pause");
      const resumed = await post(router, "/api/projects/demo/pi/resume");

      expect(paused.status).toBe(404);
      expect(resumed.status).toBe(404);
    } finally {
      database.close();
    }
  });

  test("always authorizes only project-scoped Work enqueue for a managed project", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = getProject(database, "demo")!;
      const enabled = managerCycleAuthorization(project);
      const envelope = {
        action_type: "work.enqueue",
        issue_id: 7,
        payload: { action: "enqueue", work_id: "xw:work:issues:7" },
        project_id: "demo",
        requires_confirmation: true,
        risk_level: "medium" as const,
        source: "pi_manager_cycle"
      };

      expect(gatePiActionEnvelope(envelope, enabled)).toMatchObject({ decision: "execute" });
      expect(gatePiActionEnvelope({ ...envelope, project_id: "other" }, enabled))
        .toMatchObject({ decision: "deny" });
      expect(enabled.allowedActions).toContain("work.enqueue");
      expect(enabled.mode).toBe("delegated");
    } finally {
      database.close();
    }
  });

  test("run-once uses the bootstrapped default PI agent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const runOnce = await post(router, "/api/projects/demo/pi/run-once");

      expect(runOnce.status).toBe(400);
      expect(String((await runOnce.json() as Record<string, unknown>).message)).toContain("No API key found for openai");
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
  db.sqlite.run(
    "insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)",
    [id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
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
