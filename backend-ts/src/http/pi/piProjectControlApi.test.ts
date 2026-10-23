import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type RunnerDatabase } from "../../db/database.ts";
import { getAgentSession } from "../../db/repositories/agentSessions.ts";
import { listPiActionEvents, listPiActions, listPiConversations, listPiMemoryItems } from "../../db/repositories/pi.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { EventBus } from "../../events/bus.ts";
import { gatePiActionEnvelope } from "../../pi/actions/actionGate.ts";
import { createDefaultRouter } from "../server.ts";
import { managerCycleAuthorization } from "./piProjectControlAuthorization.ts";
import { apiClient, FIXTURE_TIME, insertIssue, insertProject, insertRow, useTestDatabase } from "../../testing/harness.ts";
import { useFauxPi } from "../../testing/fauxPi.ts";

const openFixtureDatabase = useTestDatabase();
const fauxPi = useFauxPi("pi-control");

describe("Bun project PI control API", () => {
  test("run-once delegates to the Agentic Worker when configured", async () => {
    const database = await managedDemo();
    const calls: unknown[] = [];
    const response = await runOnce(database, {
      agenticClient: {
        activity: () => ({ in_flight: 0, last_activity_at: "" }),
        decideCommunication: async () => ({ decision: "suppress", message: "", rationale: "test" }),
        decideSupervisor: async () => { throw new Error("not used"); },
        health: async () => ({ ok: true, role: "agentic" }),
        runProjectCycle: async (input) => {
          calls.push(input);
          return { managed: true, project_id: input.projectId, status: "completed", text: "remote" };
        }
      }
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ project_id: "demo", status: "completed", text: "remote" });
    expect(calls).toEqual([{ maxActions: 5, projectId: "demo" }]);
    expect(listPiConversations(database, { includeInternal: true, projectId: "demo" })).toEqual([]);
  });

  test("run-once starts one PI manager cycle for a project", async () => {
    const database = await managedDemo();
    const faux = fauxPi(database);
    let promptContext = "";
    faux.setResponses([(context) => {
      promptContext = JSON.stringify(context);
      return fauxAssistantMessage("cycle done");
    }]);
    insertIssue(database, { status: "failed", title: "Failed issue" });

    const response = await runOnce(database);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ managed: true, project_id: "demo", status: "completed", text: "cycle done" });
    const conversations = listPiConversations(database, { includeInternal: true, projectId: "demo" });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ status: "completed" });
    expect(getAgentSession(database, `pi-sdk:${conversations[0]?.pi_session_id}`)).toMatchObject({ status: "completed" });
    expect(faux.state.callCount).toBe(1);
    expect(promptContext).toContain("Project status snapshot");
    expect(promptContext).toContain("Issue state diagnostics");
    expect(promptContext).toContain("Failed issue");
    const promptText = JSON.parse(promptContext).messages.find((message: { role: string }) => message.role === "user").content[0].text;
    expect(promptText).toContain('"failed": 1');
  });

  test("run-once terminalizes failed provider cycles", async () => {
    const database = await managedDemo();
    fauxPi(database).setResponses([fauxAssistantMessage([], { errorMessage: "provider failed", stopReason: "error" })]);

    const response = await runOnce(database);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "failed" });
    const [conversation] = listPiConversations(database, { includeInternal: true, projectId: "demo" });
    expect(conversation).toMatchObject({ status: "failed" });
    expect(getAgentSession(database, `pi-sdk:${conversation?.pi_session_id}`)).toMatchObject({ status: "failed" });
  });

  test("issue-state endpoint returns diagnostics and batch target progress", async () => {
    const database = await managedDemo();
    const weakDone = insertIssue(database, { status: "done", title: "Weak done" });
    const pending = insertIssue(database, { status: "todo", title: "Todo target" });

    const response = await apiClient(createDefaultRouter({ database })).get(
      `/api/projects/demo/pi/issue-state?target_issue_ids=${weakDone},${pending}&target_label=tonight&target_status=done&deadline_at=2026-01-01T23:59:59Z`
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ batch_targets: [expect.objectContaining({ done: 1, label: "tonight", off_track_issue_ids: [pending] })] });
    expect(JSON.stringify(response.body.diagnostics)).not.toContain(`"issue_id":${weakDone}`);
  });

  test("run-once returns observations without manufacturing notifications or action candidates", async () => {
    const database = await managedDemo();
    fauxPi(database).setResponses([fauxAssistantMessage("cycle done")]);
    insertIssue(database, {
      error: "approval denied CODEX_API_KEY=fixture-secret at /Users/secret/log.txt",
      status: "failed",
      title: "Needs user at /Users/secret/project"
    });
    insertIssue(database, {
      auto_retry_next_at: "2026-01-01T01:00:00Z",
      auto_retry_reason: "network error",
      status: "todo",
      title: "Retry candidate"
    });

    const { body, status } = await runOnce(database, { bus: new EventBus() });
    const json = JSON.stringify(body);

    expect(status).toBe(201);
    expect(String(body.status_summary)).toContain("findings=1");
    expect(body.notifications).toEqual([]);
    expect(body).not.toHaveProperty("action_candidates");
    expect(json).not.toContain("fixture-secret");
    expect(json).not.toContain("/Users/secret");
  });

  test("manager cycle runs PI tools in delegated mode and denies uncovered mutations", async () => {
    const database = await managedDemo();
    fauxPi(database).setResponses([
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
    insertIssue(database, { status: "todo", title: "Do not mutate" });

    const response = await runOnce(database);
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
    expect(database.sqlite.query("select type from issue_events").all()).toEqual([]);
    expect(listPiActions(database, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "memory.remember"
    }));
    expect(listPiMemoryItems(database)).toEqual([]);
  });

  test("does not expose pause or resume mode endpoints", async () => {
    const api = apiClient(createDefaultRouter({ database: await managedDemo() }));

    expect((await api.post("/api/projects/demo/pi/pause")).status).toBe(404);
    expect((await api.post("/api/projects/demo/pi/resume")).status).toBe(404);
  });

  test("authorizes project-scoped Work enqueue and explicit human review requests for a managed project", async () => {
    const enabled = managerCycleAuthorization(getProject(await managedDemo(), "demo")!);
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
    expect(gatePiActionEnvelope({ ...envelope, project_id: "other" }, enabled)).toMatchObject({ decision: "deny" });
    expect(enabled.allowedActions).toContain("work.enqueue");
    expect(gatePiActionEnvelope({
      action_type: "human_review.request",
      issue_id: 7,
      payload: { issue_id: 7, question: "是否接受当前产品范围？" },
      project_id: "demo",
      requires_confirmation: false,
      risk_level: "low",
      source: "pi_manager_cycle"
    }, enabled)).toMatchObject({ decision: "execute" });
    expect(enabled.allowedActions).toContain("human_review.request");
    expect(enabled.mode).toBe("delegated");
  });

  test("run-once uses the bootstrapped default PI agent", async () => {
    const response = await runOnce(await managedDemo());

    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain("No API key found for openai");
  });

  test("manager cycle allows delegated SDK read-only tools", async () => {
    const policy = managerCycleAuthorization(getProject(await managedDemo(), "demo")!);

    for (const action_type of ["sdk.read", "sdk.grep", "sdk.find", "sdk.ls"]) {
      expect(gatePiActionEnvelope({
        action_type,
        delegation_id: "pi-cycle:demo",
        heartbeat_id: "pi-cycle:demo:test",
        payload: {},
        project_id: "demo",
        requires_confirmation: false,
        risk_level: "low",
        source: "pi_sdk_tool"
      }, policy)).toMatchObject({ decision: "execute" });
    }
  });

  test("manager cycle rejects status snapshots instead of creating memory candidates", async () => {
    const database = await managedDemo();
    fauxPi(database).setResponses([
      fauxAssistantMessage([
        fauxToolCall("memory_search", { query: "anything" }, { id: "memory-search" }),
        fauxToolCall("memory_remember", {
          content: "当前 demo 项目全部终态，没有未完成 Work。",
          kind: "decision",
          memory_key: "project.current-status",
          scope: "project"
        }, { id: "memory-write" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("cycle done")
    ]);

    expect((await runOnce(database)).status).toBe(201);
    const completed = listPiActions(database, { status: "completed" });
    for (const action_type of ["memory.search", "memory.remember"]) {
      expect(completed).toContainEqual(expect.objectContaining({ action_type, gate_decision: "execute" }));
    }
    expect(listPiMemoryItems(database)).toEqual([]);
  });

  test("run-once rejects concurrent manager cycles for the same project", async () => {
    const database = await managedDemo();
    fauxPi(database).setResponses([fauxAssistantMessage("cycle one"), fauxAssistantMessage("cycle two")]);
    const api = apiClient(createDefaultRouter({ database }));

    const responses = await Promise.all([api.post("/api/projects/demo/pi/run-once"), api.post("/api/projects/demo/pi/run-once")]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(listPiConversations(database, { includeInternal: true, projectId: "demo" })).toHaveLength(1);
  });
});

/** A database with project "demo" and its PI settings row. */
async function managedDemo(): Promise<RunnerDatabase> {
  const database = await openFixtureDatabase();
  insertProject(database, "demo", { provider_config_json: '{"capabilities":["issue_execution"]}', sort_order: 1 });
  insertRow(database, "project_pi_settings", { project_id: "demo", created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME });
  return database;
}

function runOnce(database: RunnerDatabase, options: Omit<Parameters<typeof createDefaultRouter>[0] & {}, "database"> = {}) {
  return apiClient(createDefaultRouter({ ...options, database })).post("/api/projects/demo/pi/run-once");
}
