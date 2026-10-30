import { expect } from "bun:test";
import { listPiActionEvents } from "../../db/repositories/pi.ts";
import { EventBus } from "../../events/bus.ts";
import { finalPiConversationSseData } from "./piConversationSse.testSupport.ts";
import { createDefaultRouter } from "../server.ts";
import { apiClient, FIXTURE_TIME, useTestDatabase } from "../../testing/harness.ts";
import { useFauxPi } from "../../testing/fauxPi.ts";



export function createTestFixture() {
  const openFixtureDatabase = useTestDatabase();

  const fauxPi = useFauxPi();

  const SMOKE_PROVIDER = "pi-smoke-faux";

  const EXECUTABLE = { provider_config_json: '{"capabilities":["issue_execution"]}' };

  function runnerChat(router: ReturnType<typeof createDefaultRouter>) {
    const api = apiClient(router);
    const open = async (id: string, body: Record<string, unknown> = {}) => {
      expect((await api.post("/api/pi/conversations", { id, ...body })).status).toBe(201);
    };
    return {
      open,
      ask: async (id: string, prompt: string, conversation: Record<string, unknown> = {}) => {
        await open(id, conversation);
        const message = await api.raw(`/api/pi/conversations/${id}/messages`, {
          body: JSON.stringify({ prompt }), headers: { "content-type": "application/json" }, method: "POST"
        });
        expect(message.status).toBe(201);
        return finalPiConversationSseData(message);
      }
    };
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

  const AGENT_RECORD = {
    id: "runner-default", name: "Xuanwu Supervisor", provider: "pi-sdk", model_provider: SMOKE_PROVIDER, model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME
  };

  function agentRecord(patch: Partial<typeof AGENT_RECORD> = {}) {
    return { ...AGENT_RECORD, ...patch };
  }

  function projectRecord(id: string) {
    return {
      id, name: id, cwd: `/tmp/${id}`, provider: "codex", provider_config_json: "{}", auto_run: 0,
      model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
      default_service_tier: "",
      sort_order: 1, created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME,
      default_mcp_policy: "{}", default_skill_policy: JSON.stringify({
        allowed: ["xuanwu"],
        recommended: ["xuanwu", "verification-before-completion"]
      }),
      loop_status: "stopped", provider_capabilities: []
    };
  }
  return { openFixtureDatabase, fauxPi, SMOKE_PROVIDER, EXECUTABLE, runnerChat, collectEventTypes, nextEvent, collectToolText, toolCallAuditPayloads, AGENT_RECORD, agentRecord, projectRecord };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
