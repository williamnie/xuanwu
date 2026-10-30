import { expect, test } from "bun:test";
import { listPiActionEvents } from "../../db/repositories/pi.ts";
import { HTTP_READONLY_PROVIDER_ID, URL_FETCH_TOOL_NAME } from "../../pi/tools/httpToolProvider.ts";
import { createPiRuntimeSession } from "./piRuntime.ts";
import { PI_CONTEXT_BUDGET_OBSERVATION_EVENT } from "./piContextBudgetObservation.ts";
import { writeFauxModelsConfig } from "../../testing/fauxPi.ts";
import type { TestFixture } from "./piRuntimeSmoke.testFixture.ts";

export function registerAssemblesPiRuntimeToolsFromCases(testScope: TestFixture) {
  const { openFixtureDatabase, SMOKE_PROVIDER, agentRecord, projectRecord } = testScope;
  test("assembles PI runtime tools from registry and audits the source", async () => {
      const database = await openFixtureDatabase();
      writeFauxModelsConfig(database, SMOKE_PROVIDER);
  
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
      writeFauxModelsConfig(database, SMOKE_PROVIDER);
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
    });
}
