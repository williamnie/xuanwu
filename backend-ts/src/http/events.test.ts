import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/bus.ts";
import { createRouter } from "./router.ts";
import { registerEventRoutes } from "./events.ts";

const BASE_URL = "http://127.0.0.1:3008";

describe("Bun SSE events endpoint", () => {
  test("opens an SSE stream, sends heartbeat, and cleans up on close", async () => {
    const bus = new EventBus();
    const router = createRouter();
    registerEventRoutes(router, { bus, heartbeatMs: 5 });
    const controller = new AbortController();

    const response = await router.handle(new Request(`${BASE_URL}/api/events`, {
      signal: controller.signal
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(bus.subscriberCount()).toBe(1);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain(": connected");

    const second = await reader!.read();
    expect(new TextDecoder().decode(second.value)).toContain(": heartbeat");

    bus.publish({ type: "issue.created", issueId: 1 });
    const third = await reader!.read();
    expect(new TextDecoder().decode(third.value)).toContain('data: {"type":"issue.created","issueId":1}');

    await reader!.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });
});
