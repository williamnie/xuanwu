import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createPiActionEvent, listPiActionEvents } from "../../db/repositories/pi.ts";
import { adoptImConversationState, getImConversationState } from "../../db/repositories/imConversationState.ts";
import { buildImConversationPromptProjection } from "../../integrations/im/imConversationContext.ts";
import { HTTP_READONLY_PROVIDER_ID, URL_FETCH_TOOL_NAME } from "../../pi/tools/httpToolProvider.ts";
import { createPiRuntimeSession } from "./piRuntime.ts";
import { PI_CONTEXT_BUDGET_OBSERVATION_EVENT } from "./piContextBudgetObservation.ts";
import { runPiConversationPrompt } from "./piConversationApi.ts";
import { createDefaultRouter } from "../server.ts";
import { configureFauxAgent } from "../../testing/fauxPi.ts";
import type { TestFixture } from "./piRuntimeSmoke.testFixture.ts";

export function registerRollsAnOverBudgetImCases(testScope: TestFixture) {
  const { openFixtureDatabase, fauxPi, SMOKE_PROVIDER, runnerChat, collectToolText, toolCallAuditPayloads, agentRecord, projectRecord } = testScope;
  test("rolls an over-budget IM conversation to one CAS child with a deterministic minimal capsule", async () => {
      const database = await openFixtureDatabase();
      configureFauxAgent(database, SMOKE_PROVIDER);
      await runnerChat(createDefaultRouter({ database })).open("feishu-chat-rollover");
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
    });
  
  test("commits an IM event binding and cursor from the SDK agent_start signal", async () => {
      const database = await openFixtureDatabase();
      configureFauxAgent(database, SMOKE_PROVIDER);
      await runnerChat(createDefaultRouter({ database })).open("feishu-chat-binding");
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
    });
  
  test("can answer URL questions through url_fetch instead of only local SDK tools", async () => {
      const database = await openFixtureDatabase();
      const faux = fauxPi(database, { provider: "pi-url-faux" });
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
      }
    });
}
