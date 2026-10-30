import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { getAutomationTrigger, listAutomations } from "../../db/repositories/automations.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { getPiMemoryItem, listPiActions, listPiMemoryItems, updatePiPersona } from "../../db/repositories/pi.ts";
import { EventBus } from "../../events/bus.ts";
import { createPiRuntimeSession, PI_RUNNER_CHAT_ACTIONS } from "./piRuntime.ts";
import { createDefaultRouter } from "../server.ts";
import { insertProject } from "../../testing/harness.ts";
import { configureFauxAgent, writeFauxModelsConfig } from "../../testing/fauxPi.ts";
import type { TestFixture } from "./piRuntimeSmoke.testFixture.ts";

export function registerKeepsPersonaFinalInControlledCases(testScope: TestFixture) {
  const { openFixtureDatabase, fauxPi, SMOKE_PROVIDER, EXECUTABLE, runnerChat, collectEventTypes, agentRecord, projectRecord } = testScope;
  test("keeps Persona final in controlled Chat runtime and strips it plus optional resources from internal profiles", async () => {
      const database = await openFixtureDatabase();
      writeFauxModelsConfig(database, SMOKE_PROVIDER);
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
    });
  
  test("fails visibly when the PI Agent has no configured model", async () => {
      const database = await openFixtureDatabase();
      await expect(createPiRuntimeSession(database, {
        agent: agentRecord({ model_id: "", model_provider: "" }),
        conversationID: "conv-model-missing",
        promptProfile: "chat",
        project: projectRecord("demo")
      })).rejects.toThrow("has no configured model provider/model");
    });
  
  test("fails visibly when the configured PI model is unavailable", async () => {
      const database = await openFixtureDatabase();
      await expect(createPiRuntimeSession(database, {
        agent: agentRecord({ model_id: "missing-model", model_provider: "missing-provider" }),
        conversationID: "conv-model-unavailable",
        promptProfile: "chat",
        project: projectRecord("demo")
      })).rejects.toThrow("model is unavailable: missing-provider/missing-model");
    });
  
  test("auto-registers local faux provider for preview smoke agent", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo", EXECUTABLE);
      configureFauxAgent(database, SMOKE_PROVIDER);
      const chat = runnerChat(createDefaultRouter({ bus: new EventBus(), database }));
  
      expect(await chat.ask("conv-auto-faux", "Reply ok only", { project_id: "demo" })).toMatchObject({
        conversation_id: "conv-auto-faux",
        status: "completed",
        text: "pi-smoke-response-ok"
      });
    });
  
  test("runner chat executes issue create and scheduled enqueue through chat tools", async () => {
      const database = await openFixtureDatabase();
      const faux = fauxPi(database, { provider: SMOKE_PROVIDER });
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
        insertProject(database, "demo", EXECUTABLE);
        const chat = runnerChat(createDefaultRouter({ bus, database }));
  
        expect(await chat.ask("conv-smoke", "Create one action in demo and remember the explicit reusable preference", {
          project_id: "demo"
        })).toMatchObject({
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
      }
    });
  
  test("runner chat reads Issue context and executes an authorized status move", async () => {
      const database = await openFixtureDatabase();
      const faux = fauxPi(database, { provider: SMOKE_PROVIDER });
      insertProject(database, "demo", EXECUTABLE);
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "Stop this work" });
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
      const chat = runnerChat(createDefaultRouter({ database }));
  
      expect(await chat.ask("conv-status-move", `#${issue.id} 不做了，移动到 cancelled`, { project_id: "demo" })).toMatchObject({
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
    });
}
