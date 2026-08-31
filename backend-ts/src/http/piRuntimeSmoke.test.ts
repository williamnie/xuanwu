import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAutomationTrigger, listAutomations } from "../db/repositories/automations.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { createPiActionEvent, createPiDelegation, createPiMemoryItem, getPiMemoryItem, listPiActionEvents, listPiActions, listPiMemoryItems, updatePiPersona } from "../db/repositories/pi.ts";
import { adoptImConversationState, getImConversationState } from "../db/repositories/imConversationState.ts";
import { EventBus } from "../events/bus.ts";
import { buildImConversationPromptProjection } from "../integrations/imConversationContext.ts";
import { HTTP_READONLY_PROVIDER_ID, URL_FETCH_TOOL_NAME } from "../pi/httpToolProvider.ts";
import {
  createPiRuntimeSession,
  PI_RUNNER_CHAT_ACTIONS,
  PI_RUNNER_CHAT_MUTATION_ACTIONS
} from "./piRuntime.ts";
import { PI_CONTEXT_BUDGET_OBSERVATION_EVENT } from "./piContextBudgetObservation.ts";
import { finalPiConversationSseData } from "./piConversationSse.testSupport.ts";
import { runPiConversationPrompt } from "./piConversationApi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-runtime-smoke-"));
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
  test("keeps Persona final in controlled Chat runtime and strips it plus optional resources from internal profiles", async () => {
    const database = await openFixtureDatabase();
    try {
      writeFauxModelsConfig(database);
      updatePiPersona(database, { expected_revision: 0, enabled: 1 }, {
        actor: "runtime-smoke", reason: "controlled canary", requestedAt: new Date().toISOString()
      });
      const chat = await createPiRuntimeSession(database, {
        agent: agentRecord(),
        channelContext: "CHANNEL_RUNTIME_SENTINEL",
        conversationID: "controlled-chat-persona",
        promptProfile: "chat",
        project: projectRecord("demo")
      });
      const chatPrompt = chat.session.systemPrompt;
      chat.dispose();
      expect(chatPrompt).toContain("Controlled Supervisor resource summary:");
      expect(chatPrompt).toContain("CHANNEL_RUNTIME_SENTINEL");
      expect(chatPrompt.match(/Chat presentation profile:/g)).toHaveLength(1);
      expect(chatPrompt.indexOf("Controlled Supervisor resource summary:")).toBeLessThan(
        chatPrompt.indexOf("Chat presentation profile:")
      );
      const afterPersona = chatPrompt.slice(chatPrompt.indexOf("Chat presentation profile:"));
      expect(afterPersona).toContain("Prefer natural language otherwise.");
      expect(afterPersona).toContain("Current date:");
      expect(afterPersona).not.toContain("Supervisor commitment context");
      expect(afterPersona).not.toContain("Reusable Supervisor memory");
      expect(afterPersona).not.toContain("Agent-specific Supervisor behavior");

      for (const profile of ["acceptance", "recovery", "notification"] as const) {
        const runtime = await createPiRuntimeSession(database, {
          agent: agentRecord(),
          conversationID: `controlled-${profile}`,
          promptProfile: profile,
          project: projectRecord("demo")
        });
        const prompt = runtime.session.systemPrompt;
        const tools = runtime.session.getActiveToolNames();
        runtime.dispose();
        expect(prompt).toContain(`Runtime prompt profile: ${profile}`);
        expect(prompt).not.toContain("Chat presentation profile:");
        expect(prompt).not.toContain("CHANNEL_RUNTIME_SENTINEL");
        expect(prompt).not.toContain("Relevant Skill Metadata:");
        if (profile === "notification") expect(tools).toEqual([]);
        else expect(tools.length).toBeGreaterThan(0);
      }
    } finally {
      database.close();
    }
  });

  test("Runner Chat authorization exposes canonical Issue status management", () => {
    expect(PI_RUNNER_CHAT_ACTIONS).toEqual(expect.arrayContaining([
      "human_review.respond",
      "issue.cancel",
      "issue.delete",
      "runner.settings_update",
      "system.restart",
      "issue.status_update"
    ]));
    expect(PI_RUNNER_CHAT_MUTATION_ACTIONS).toEqual(expect.arrayContaining([
      "human_review.respond",
      "issue.cancel",
      "issue.delete",
      "runner.settings_update",
      "system.restart",
      "issue.status_update"
    ]));
  });

  test("fails visibly when the PI Agent has no configured model", async () => {
    const database = await openFixtureDatabase();
    try {
      await expect(createPiRuntimeSession(database, {
        agent: agentRecord({ model_id: "", model_provider: "" }),
        conversationID: "conv-model-missing",
        promptProfile: "chat",
        project: projectRecord("demo")
      })).rejects.toThrow("has no configured model provider/model");
    } finally {
      database.close();
    }
  });

  test("fails visibly when the configured PI model is unavailable", async () => {
    const database = await openFixtureDatabase();
    try {
      await expect(createPiRuntimeSession(database, {
        agent: agentRecord({ model_id: "missing-model", model_provider: "missing-provider" }),
        conversationID: "conv-model-unavailable",
        promptProfile: "chat",
        project: projectRecord("demo")
      })).rejects.toThrow("model is unavailable: missing-provider/missing-model");
    } finally {
      database.close();
    }
  });

  test("auto-registers local faux provider for preview smoke agent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ bus: new EventBus(), database });

      const created = await post(router, "/api/pi/conversations", {
        id: "conv-auto-faux",
        project_id: "demo"
      });
      const message = await post(router, "/api/pi/conversations/conv-auto-faux/messages", {
        prompt: "Reply ok only"
      });

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(await finalPiConversationSseData(message)).toMatchObject({
        conversation_id: "conv-auto-faux",
        status: "completed",
        text: "pi-smoke-response-ok"
      });
    } finally {
      database.close();
    }
  });

  test("runner chat executes issue create and scheduled enqueue through chat tools", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-smoke-faux-api", provider: "pi-smoke-faux" });
    const bus = new EventBus();
    const events = bus.subscribe();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("project_list", {}, { id: "project-list" }),
          fauxToolCall("issue_create_proposal", {
            description: "Follow-up body",
            project_id: "demo",
            title: "Follow-up issue"
          }, { id: "issue-proposal" }),
          fauxToolCall("issue_schedule_enqueue", {
            issue_id: 1,
            next_run_at: "2999-01-01T00:00:00.000Z"
          }, { id: "schedule-enqueue" }),
          fauxToolCall("memory_remember", {
            kind: "project_preference",
            content: "用户明确要求：优先保存可复用经验，不保存运行状态。",
            memory_key: "project.memory-content-policy",
            scope: "project",
            user_authorized: true
          }, { id: "memory-remember" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("smoke done")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ bus, database });

      const created = await post(router, "/api/pi/conversations", {
        id: "conv-smoke",
        project_id: "demo"
      });
      const message = await post(router, "/api/pi/conversations/conv-smoke/messages", {
        prompt: "Create one action in demo and remember the explicit reusable preference"
      });

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(await finalPiConversationSseData(message)).toMatchObject({
        conversation_id: "conv-smoke",
        status: "completed",
        text: "smoke done"
      });
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([
        { description: "Follow-up body", status: "triage", title: "Follow-up issue" }
      ]);
      const automation = listAutomations(database).find((item) => item.id.startsWith("automation:issue-"));
      expect(automation).toMatchObject({
        mode: "execute_allowed", next_run_at: "2999-01-01T00:00:00.000Z", status: "active"
      });
      expect(automation && getAutomationTrigger(database, automation.id)).toMatchObject({
        type: "manual", config: { target_issue_id: 1 }
      });
      expect(listPiActions(database, { status: "pending" })).toEqual([]);
      expect(listPiActions(database, { status: "completed" }).map((action) => action.action_type).sort())
        .toEqual(["issue.create", "issue.schedule_enqueue", "memory.remember", "project.list"].sort());
      const memories = listPiMemoryItems(database, { disabled: 0 });
      expect(memories).toHaveLength(1);
      expect(memories[0]).toMatchObject({
        kind: "project_preference",
        memory_key: "project.memory-content-policy",
        source_id: "conv-smoke",
        source_type: "pi.conversation"
      });
      expect(listPiMemoryItems(database, { disabled: 1 })).toEqual([]);
      expect(getPiMemoryItem(database, memories[0]?.id ?? "")?.disabled).toBe(0);
      expect(await collectEventTypes(events, 80)).not.toContain("pi.memory_candidate");
      expect(faux.state.callCount).toBe(2);
    } finally {
      events.close();
      faux.unregister();
      database.close();
    }
  });

  test("runner chat reads Issue context and executes an authorized status move", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-smoke-faux-api", provider: "pi-smoke-faux" });
    try {
      insertProject(database, "demo");
      const issue = createIssue(database, {
        project_id: "demo",
        status: "triage",
        title: "Stop this work"
      });
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("issue_read", { id: issue.id }, { id: "issue-read" }),
          fauxToolCall("issue_status_update", {
            issue_ids: [issue.id],
            reason: "用户明确要求不再处理",
            status: "cancelled"
          }, { id: "issue-status-update" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("已移到 cancelled")
      ]);
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ database });

      expect((await post(router, "/api/pi/conversations", {
        id: "conv-status-move",
        project_id: "demo"
      })).status).toBe(201);
      const message = await post(router, "/api/pi/conversations/conv-status-move/messages", {
        prompt: `#${issue.id} 不做了，移动到 cancelled`
      });

      expect(message.status).toBe(201);
      expect(await finalPiConversationSseData(message)).toMatchObject({
        conversation_id: "conv-status-move",
        status: "completed",
        text: "已移到 cancelled"
      });
      expect(listIssues(database, { projectId: "demo" })).toContainEqual(expect.objectContaining({
        id: issue.id,
        status: "cancelled"
      }));
      expect(listPiActions(database, { status: "completed" }).map((action) => action.action_type))
        .toEqual(expect.arrayContaining(["issue.read", "issue.status_update"]));
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("assembles PI runtime tools from registry and audits the source", async () => {
    const database = await openFixtureDatabase();
    try {
      writeFauxModelsConfig(database);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord(),
        conversationID: "conv-tool-registry",
        promptProfile: "chat",
        project: projectRecord("demo")
      });
      const activeTools = runtime.session.getActiveToolNames();
      runtime.dispose();

      expect(activeTools).toEqual(expect.arrayContaining([
        "read",
        URL_FETCH_TOOL_NAME,
        "issue_read",
        "issue_create_proposal",
        "issue_enqueue_proposal",
        "memory_search"
      ]));
      const audit = listPiActionEvents(database, { conversationId: "conv-tool-registry" })
        .find((event) => event.event_type === "runtime_tool_registry_snapshot");
      const contextAudit = listPiActionEvents(database, { conversationId: "conv-tool-registry" })
        .find((event) => event.event_type === "runtime_context_projected");
      expect(audit).toBeTruthy();
      expect(contextAudit).toBeTruthy();
      expect(JSON.parse(contextAudit?.payload_json ?? "{}")).toMatchObject({
        schema_version: "xw.pi-runtime-context.v1",
        target: { project_id: "demo" },
        system_prompt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
      const payload = JSON.parse(audit?.payload_json ?? "{}");
      expect(payload.source).toBe("registry");
      expect(payload.provider_ids).toEqual(expect.arrayContaining(["runner-builtin", HTTP_READONLY_PROVIDER_ID]));
      expect(payload.tool_names).toEqual(expect.arrayContaining(["read", URL_FETCH_TOOL_NAME, "issue_enqueue_proposal"]));
      expect(payload.custom_tool_names).toContain(URL_FETCH_TOOL_NAME);
      expect(payload.counts.sdk_tools).toBeGreaterThan(0);
      expect(payload.counts.custom_tools).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  test("observes context budgets for Feishu, Telegram, and Runner Chat without changing runtime behavior", async () => {
    const database = await openFixtureDatabase();
    const fixtures = [
      {
        channelContext: "FEISHU_CONTEXT_SECRET_SENTINEL",
        conversationID: "feishu-chat-budget-fixture",
        source: "feishu_runner_chat",
        surface: "feishu"
      },
      {
        channelContext: "TELEGRAM_CONTEXT_SECRET_SENTINEL",
        conversationID: "telegram-chat-budget-fixture",
        source: "runner_chat",
        surface: "telegram"
      },
      {
        channelContext: "",
        conversationID: "runner-chat-budget-fixture",
        source: "runner_chat",
        surface: "runner_chat"
      }
    ] as const;
    try {
      writeFauxModelsConfig(database);
      for (const fixture of fixtures) {
        const userPrompt = `budget prompt ${fixture.surface} PRIVATE_PROMPT_SENTINEL`;
        const runtime = await createPiRuntimeSession(database, {
          agent: agentRecord(),
          channelContext: fixture.channelContext,
          conversationID: fixture.conversationID,
          promptProfile: "chat",
          project: projectRecord("demo"),
          source: fixture.source,
          sourceTurn: { id: `turn-${fixture.surface}`, source: fixture.source, userPrompt }
        });
        const activeToolCount = runtime.session.getActiveToolNames().length;
        if (fixture.channelContext !== "") {
          expect(runtime.session.systemPrompt).toContain(fixture.channelContext);
        }
        await runtime.session.prompt(userPrompt, { expandPromptTemplates: false, source: "rpc" });
        runtime.dispose();

        const budgetEvents = listPiActionEvents(database, { conversationId: fixture.conversationID })
          .filter((event) => event.event_type === PI_CONTEXT_BUDGET_OBSERVATION_EVENT);
        const preflight = budgetEvents
          .map((event) => JSON.parse(event.payload_json) as Record<string, any>)
          .find((payload) => payload.phase === "preflight");
        const postflight = budgetEvents
          .map((event) => JSON.parse(event.payload_json) as Record<string, any>)
          .find((payload) => payload.phase === "postflight");

        expect(preflight).toMatchObject({
          behavior: {
            observe_only: true,
            projector_changed: false,
            session_changed: false,
            tool_surface_changed: false
          },
          measurement: {
            confidence: "estimated",
            method: "sdk_messages_plus_serialized_utf8_div_4"
          },
          observe_only: true,
          observer: { assembly_duration_ms: expect.any(Number) },
          phase: "preflight",
          profile: "chat",
          schema_version: "xw.pi-context-budget-observation.v1",
          surface: fixture.surface
        });
        expect(preflight?.breakdown.effective_system_prompt.estimated_tokens).toBeGreaterThan(0);
        expect(preflight?.breakdown.tool_definitions.estimated_tokens).toBeGreaterThan(0);
        expect(preflight?.breakdown.current_user_prompt.estimated_tokens).toBeGreaterThan(0);
        expect(preflight?.context.projected_input_tokens).toBeGreaterThan(
          preflight?.breakdown.effective_system_prompt.estimated_tokens
        );
        expect(preflight?.counts.active_tools).toBe(activeToolCount);
        expect(activeToolCount).toBeGreaterThan(0);
        expect(activeToolCount).toBeLessThan(40);
        expect(preflight?.hashes.effective_system_prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(preflight?.hashes.tool_definitions_sha256).toMatch(/^[a-f0-9]{64}$/);
        if (fixture.channelContext === "") {
          expect(preflight?.subsets.channel_context.estimated_tokens).toBe(0);
        } else {
          expect(preflight?.subsets.channel_context.estimated_tokens).toBeGreaterThan(0);
        }
        expect(postflight).toMatchObject({
          observe_only: true,
          phase: "postflight",
          profile: "chat",
          provider_call_index: 1,
          schema_version: "xw.pi-context-budget-observation.v1",
          surface: fixture.surface
        });
        expect(postflight?.observed_usage.input_context_tokens).toBeGreaterThan(0);
        expect(JSON.stringify(budgetEvents)).not.toContain("PRIVATE_PROMPT_SENTINEL");
        expect(JSON.stringify(budgetEvents)).not.toContain("CONTEXT_SECRET_SENTINEL");
      }
    } finally {
      database.close();
    }
  });

  test("rolls an over-budget IM conversation to one CAS child with a deterministic minimal capsule", async () => {
    const database = await openFixtureDatabase();
    try {
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ database });
      expect((await post(router, "/api/pi/conversations", { id: "feishu-chat-rollover" })).status).toBe(201);
      adoptImConversationState(database, {
        activeConversationId: "feishu-chat-rollover",
        baseConversationId: "feishu-chat-rollover",
        connectorId: "feishu",
        scopeKey: "feishu-chat-rollover"
      });
      createPiActionEvent(database, {
        action_id: "budget-high-rollover",
        actor: "test",
        conversation_id: "feishu-chat-rollover",
        event_type: PI_CONTEXT_BUDGET_OBSERVATION_EVENT,
        payload_json: JSON.stringify({
          context: { projected_input_percent: 65 }, phase: "preflight", surface: "feishu"
        }),
        reason: "fixture over budget"
      });
      const latestBudget = listPiActionEvents(database, {
        conversationId: "feishu-chat-rollover",
        eventType: PI_CONTEXT_BUDGET_OBSERVATION_EVENT
      }).at(-1);
      expect(JSON.parse(latestBudget?.payload_json ?? "{}")).toMatchObject({
        context: { projected_input_percent: 65 }, phase: "preflight"
      });
      const promptInput = {
        channelContext: "legacy projection",
        channelContextProjection: {
          connectorID: "feishu",
          conversationID: "oc_rollover",
          events: [],
          omittedCount: 0,
          piConversationID: "feishu-chat-rollover",
          prompt: "",
          scopeKey: "feishu-chat-rollover",
          truncated: false
        },
        conversationId: "feishu-chat-rollover",
        prompt: "继续刚才那件事",
        targetProjectId: "",
        title: "Rollover fixture"
      };
      const observed = await runPiConversationPrompt({ database }, promptInput);
      expect(observed.conversation_id).toBe("feishu-chat-rollover");
      createPiActionEvent(database, {
        action_id: "budget-high-rollover-after-observation",
        actor: "test",
        conversation_id: "feishu-chat-rollover",
        event_type: PI_CONTEXT_BUDGET_OBSERVATION_EVENT,
        payload_json: JSON.stringify({
          context: { projected_input_percent: 65 }, phase: "preflight", surface: "feishu"
        }),
        reason: "fixture remains over budget"
      });
      const result = await runPiConversationPrompt({ database }, promptInput);

      expect(result).toMatchObject({
        conversation_id: "feishu-chat-rollover-n1",
        status: "completed",
        text: "pi-smoke-response-ok"
      });
      expect(getImConversationState(database, "feishu", "feishu-chat-rollover")).toMatchObject({
        active_conversation_id: "feishu-chat-rollover-n1",
        epoch: 1
      });
      const rollover = database.sqlite.query<Record<string, unknown>, []>(
        "select status, capsule_json, parent_conversation_id, child_conversation_id from im_context_rollovers"
      ).get();
      expect(rollover).toMatchObject({
        child_conversation_id: "feishu-chat-rollover-n1",
        parent_conversation_id: "feishu-chat-rollover",
        status: "activated"
      });
      expect(JSON.parse(String(rollover?.capsule_json))).toMatchObject({
        parent_conversation_id: "feishu-chat-rollover",
        summary_unavailable: true,
        trigger: "projected_context_threshold"
      });
    } finally {
      database.close();
    }
  });

  test("commits an IM event binding and cursor from the SDK agent_start signal", async () => {
    const database = await openFixtureDatabase();
    try {
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ database });
      expect((await post(router, "/api/pi/conversations", { id: "feishu-chat-binding" })).status).toBe(201);
      adoptImConversationState(database, {
        activeConversationId: "feishu-chat-binding",
        baseConversationId: "feishu-chat-binding",
        connectorId: "feishu",
        scopeKey: "feishu-chat-oc_binding"
      });
      const event = createExternalEvent(database, {
        content: "需要被展示一次的历史消息",
        dedupe_key: "feishu:binding:previous",
        external_id: "om_previous_binding",
        normalized_message: { chat_id: "oc_binding", message_id: "om_previous_binding" },
        occurred_at: "2026-08-18T00:00:00.000Z",
        source: "feishu"
      });
      const projection = buildImConversationPromptProjection(database, {
        conversation: {
          connectorId: "feishu",
          conversationId: "oc_binding",
          currentMessageId: "om_current_binding",
          piConversationId: "feishu-chat-binding",
          threadId: ""
        }
      });
      expect(projection.prompt).toContain("需要被展示一次的历史消息");

      const result = await runPiConversationPrompt({ database }, {
        channelContext: projection.prompt,
        channelContextProjection: projection,
        conversationId: "feishu-chat-binding",
        prompt: "继续",
        targetProjectId: "",
        title: "Binding fixture"
      });
      expect(result.status).toBe("completed");
      expect(database.sqlite.query<{ status: string }, [number]>(
        "select status from im_context_event_bindings where source_row_id=?"
      ).get(event.id)?.status).toBe("presented");
      expect(database.sqlite.query<{ inbound_event_id: number }, []>(
        "select inbound_event_id from im_context_cursors"
      ).get()?.inbound_event_id).toBe(event.id);
      expect(buildImConversationPromptProjection(database, {
        conversation: {
          connectorId: "feishu", conversationId: "oc_binding", currentMessageId: "om_next_binding",
          piConversationId: "feishu-chat-binding", threadId: ""
        }
      }).prompt).not.toContain("需要被展示一次的历史消息");
    } finally {
      database.close();
    }
  });

  test("can answer URL questions through url_fetch instead of only local SDK tools", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-url-faux-api", provider: "pi-url-faux" });
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    try {
      (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (url, _init) => {
        fetchCalls.push(String(url));
        return new Response([
          "<html><body>",
          "<h1>Open Connector</h1>",
          "<p>Open Connector is an OOMOL Lab project for building connector integrations.</p>",
          "</body></html>"
        ].join(""), { headers: { "content-type": "text/html; charset=utf-8" }, status: 200 });
      }) as typeof fetch;
      writeFauxModelsConfig(database, { api: "pi-url-faux-api", provider: "pi-url-faux" });
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall(URL_FETCH_TOOL_NAME, {
            extract_text: true,
            max_bytes: 12000,
            url: "https://github.com/oomol-lab/open-connector"
          }, { id: "url-fetch" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("Open Connector 是 OOMOL Lab 的 connector integrations 项目。")
      ]);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord({ model_provider: "pi-url-faux" }),
        conversationID: "conv-url-question",
        promptProfile: "chat",
        project: projectRecord("demo"),
        source: "rpc"
      });
      const probes = new Map<string, { isError: boolean; text: string }>();
      const unsubscribe = runtime.session.subscribe((event) => {
        if (event.type !== "tool_execution_end") return;
        probes.set(event.toolName, { isError: event.isError, text: collectToolText(event.result.content) });
      });

      expect(runtime.session.getActiveToolNames()).toContain(URL_FETCH_TOOL_NAME);
      await runtime.session.prompt(
        "https://github.com/oomol-lab/open-connector 这是个什么项目",
        { expandPromptTemplates: false, source: "rpc" }
      );
      unsubscribe();
      runtime.dispose();

      expect(fetchCalls).toEqual(["https://github.com/oomol-lab/open-connector"]);
      expect(probes.get(URL_FETCH_TOOL_NAME)?.isError).toBe(false);
      expect(probes.get(URL_FETCH_TOOL_NAME)?.text).toContain("Open Connector");
      const audit = toolCallAuditPayloads(listPiActionEvents(database, { conversationId: "conv-url-question" }))
        .find((event) => event.tool === URL_FETCH_TOOL_NAME);
      expect(audit).toMatchObject({
        provider_id: HTTP_READONLY_PROVIDER_ID,
        source: "rpc",
        status: "succeeded",
        tool: URL_FETCH_TOOL_NAME
      });
    } finally {
      (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
      faux.unregister();
      database.close();
    }
  });

  test("injects only authorized skill metadata into PI runtime prompt and audits the summary", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo", JSON.stringify({
        allowed: ["xuanwu"],
        recommended: ["xuanwu", "verification-before-completion"]
      }));
      const issue = createIssue(database, {
        project_id: "demo",
        recommended_skill_intents: ["verification-before-completion"],
        required_skill_intents: ["xuanwu"],
        title: "Skill scoped issue"
      });
      createPiDelegation(database, {
        allowed_skill_intents_json: ["xuanwu"],
        id: "delegation-a",
        project_id: "demo"
      });
      createPiMemoryItem(database, {
        confidence: "high",
        content: "Issue-specific PI context",
        id: "issue-memory",
        kind: "decision",
        scope: "issue",
        scope_id: String(issue.id),
        source_id: "turn-1",
        source_type: "conversation"
      });
      createPiMemoryItem(database, {
        content: "Disabled memory should stay hidden",
        disabled: 1,
        id: "disabled-memory",
        kind: "decision",
        scope: "issue",
        scope_id: String(issue.id)
      });
      insertFauxAgent(database);
      writeFauxModelsConfig(database);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord(),
        authorization: {
          allowedSkillIntents: ["xuanwu", "verification-before-completion"],
          mode: "delegated"
        },
        conversationID: "conv-skill-context",
        promptProfile: "chat",
        delegationID: "delegation-a",
        issueID: issue.id,
        project: projectRecord("demo")
      });
      await runtime.session.reload();
      const prompt = runtime.session.systemPrompt;
      runtime.dispose();

      expect(prompt).toContain("Relevant Skill Metadata:");
      expect(prompt).toContain("Repo-aware issue proposal workflow:");
      expect(prompt).toContain("repo_search");
      expect(prompt).toContain("repo_context_pack");
      expect(prompt).toContain("issue_create_proposal");
      expect(prompt).toContain("最多追问一个关键问题");
      expect(prompt).toContain('"id": "xuanwu"');
      expect(prompt).not.toContain('"id": "verification-before-completion"');
      expect(prompt).toContain("Controlled Supervisor resource summary:");
      expect(prompt).toContain("<name>xuanwu</name>");
      expect(prompt).not.toContain("<name>pi-domain-proposal</name>");
      expect(prompt).toContain("Issue-specific PI context");
      expect(prompt).toContain("pi_memory_items/issue-memory");
      expect(prompt).not.toContain("Disabled memory should stay hidden");
      const events = listPiActionEvents(database, { conversationId: "conv-skill-context" });
      expect(events.map((event) => event.event_type)).toContain("skill_prompt_context_injected");
      expect(events.map((event) => event.event_type)).toContain("runtime_resource_snapshot");
      const audit = JSON.parse(events.find((event) => event.event_type === "skill_prompt_context_injected")?.payload_json ?? "{}");
      expect(audit).toMatchObject({
        injected_skill_ids: ["xuanwu"],
        scope: { delegation_id: "delegation-a", issue_id: issue.id, project_id: "demo" },
        unauthorized_skill_intents: ["verification-before-completion"]
      });
      expect(JSON.stringify(audit)).toContain("Create, enqueue, inspect");
      const resourceEvents = events.filter((event) => event.event_type === "runtime_resource_snapshot");
      const resources = JSON.parse(resourceEvents.at(-1)?.payload_json ?? "{}");
      expect(resources).toMatchObject({
        counts: { skills: 1 },
        generation: 2,
        loaded: { skills: ["xuanwu"] },
        outcome: "loaded"
      });
      expect(resourceEvents).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  test("injects agent-specific instructions into PI runtime system prompt after core constraints", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord({
          instructions: "自定义 PI 行为：先用中文总结项目风险，再提出最小 action。"
        }),
        conversationID: "conv-agent-instructions",
        promptProfile: "chat",
        project: projectRecord("demo")
      });
      const prompt = runtime.session.systemPrompt;
      runtime.dispose();

      expect(prompt).toContain("Agent-specific Supervisor behavior");
      expect(prompt).toContain("自定义 PI 行为：先用中文总结项目风险，再提出最小 action。");
      expect(prompt).toContain("Public URL source workflow");
      expect(prompt).toContain("url_fetch");
      expect(prompt.indexOf("Role contract: turn engineering goals")).toBeLessThan(
        prompt.indexOf("Agent-specific Supervisor behavior")
      );
      expect(prompt).toContain("must not override the core role/vocabulary contract");
    } finally {
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

function collectToolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "object" && block && "text" in block && typeof block.text === "string") return block.text;
    return "";
  }).join("\n");
}

function toolCallAuditPayloads(events: ReturnType<typeof listPiActionEvents>): Array<Record<string, any>> {
  return events
    .filter((event) => event.event_type === "tool_call_audit")
    .map((event) => JSON.parse(event.payload_json) as Record<string, any>);
}

function insertFauxAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `update pi_agents set name=?, model_provider=?, model_id=?, thinking_level=?, enabled=?, updated_at=?
      where id='runner-default'`,
    ["Xuanwu Supervisor", "pi-smoke-faux", "faux-1", "off", 1, "2026-01-01T00:00:00Z"]
  );
}

function agentRecord(patch: Partial<ReturnType<typeof agentRecordBase>> = {}) {
  return { ...agentRecordBase(), ...patch };
}

function agentRecordBase() {
  return {
    id: "runner-default", name: "Xuanwu Supervisor", provider: "pi-sdk", model_provider: "pi-smoke-faux", model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  };
}

function projectRecord(id: string) {
  return {
    id, name: id, cwd: `/tmp/${id}`, provider: "codex", provider_config_json: "{}", auto_run: 0,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    default_service_tier: "",
    sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    default_mcp_policy: "{}", default_skill_policy: JSON.stringify({
      allowed: ["xuanwu"],
      recommended: ["xuanwu", "verification-before-completion"]
    }),
    loop_status: "stopped", provider_capabilities: []
  };
}

function insertProject(db: RunnerDatabase, id: string, skillPolicy = "{}"): void {
  db.sqlite.run(
    `insert into projects
       (id, name, cwd, provider, provider_config_json, default_skill_policy_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', skillPolicy, 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(
  db: RunnerDatabase,
  overrides: { api?: string; provider?: string } = {}
): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  const provider = overrides.provider ?? "pi-smoke-faux";
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: overrides.api ?? "pi-smoke-faux-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}
