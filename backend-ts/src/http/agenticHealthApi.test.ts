import { describe, expect, test } from "bun:test";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import { createDefaultRouter } from "./server.ts";

function client(health: AgenticWorkerClient["health"]): AgenticWorkerClient {
  return {
    activity: () => ({ in_flight: 0, last_activity_at: "" }),
    decideCommunication: async () => ({ action: "skip", reason: "unused" }),
    decideSupervisor: async () => ({ decision: { action: "skip", reason: "unused" }, session: {} } as never),
    health,
    runProjectCycle: async () => ({})
  };
}

describe("Agentic Worker health API", () => {
  test("reports the physically separate worker health", async () => {
    const router = createDefaultRouter({
      agenticClient: client(async () => ({ ok: true, role: "agentic" }))
    });

    const response = await router.handle(new Request("http://127.0.0.1/api/system/agentic-health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: "agentic" });
  });

  test("fails closed without exposing the worker error", async () => {
    const router = createDefaultRouter({
      agenticClient: client(async () => { throw new Error("secret worker detail"); })
    });

    const response = await router.handle(new Request("http://127.0.0.1/api/system/agentic-health"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Agentic Worker unavailable" });
  });
});
