import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/bus.ts";
import { createRouter } from "./router.ts";
import { registerEventRoutes } from "./events.ts";

const BASE_URL = "http://127.0.0.1:3008";

describe("Bun SSE events endpoint", () => {
  test("notifies observers while preserving the SSE subscriber stream", async () => {
    const bus = new EventBus();
    const observed: string[] = [];
    const subscription = bus.subscribe();
    const detach = bus.observe((event) => observed.push(event.type));

    bus.publish({ issueId: 1, type: "issue.status_changed" });
    detach();
    bus.publish({ issueId: 2, type: "issue.status_changed" });

    expect(observed).toEqual(["issue.status_changed"]);
    expect(await subscription.next()).toMatchObject({ issueId: 1, type: "issue.status_changed" });
    expect(await subscription.next()).toMatchObject({ issueId: 2, type: "issue.status_changed" });
    subscription.close();
  });

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
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(bus.subscriberCount()).toBe(1);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain("retry: 1000\n\n: connected");

    const second = await reader!.read();
    expect(new TextDecoder().decode(second.value)).toContain(": heartbeat");

    bus.publish({ type: "issue.created", issueId: 1 });
    const third = await reader!.read();
    expect(new TextDecoder().decode(third.value)).toContain('data: {"type":"issue.created","issueId":1}');

    await reader!.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("disconnects a slow reader once its byte budget is exhausted", async () => {
    const bus = new EventBus();
    const router = createRouter();
    registerEventRoutes(router, { bus, heartbeatMs: 60_000, maxBufferBytes: 512 });
    const response = await router.handle(new Request(`${BASE_URL}/api/events`));
    // 让生产循环持续搬运事件而不读取响应，复现 EventBus 条数上限无法限制流积压的路径。
    for (let i = 0; i < 20; i++) {
      bus.publish({ type: "test", text: "x".repeat(128) });
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(bus.subscriberCount()).toBe(0);
    await expect(response.body!.getReader().read()).rejects.toThrow("SSE buffer limit exceeded");
  });

  test("request abort detaches a subscriber waiting for its next event", async () => {
    const bus = new EventBus();
    const router = createRouter();
    registerEventRoutes(router, { bus, heartbeatMs: 60_000 });
    const abort = new AbortController();
    const response = await router.handle(new Request(`${BASE_URL}/api/events`, { signal: abort.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    abort.abort(new Error("disconnected"));
    await expect(pending).rejects.toThrow("disconnected");
    expect(bus.subscriberCount()).toBe(0);
  });

  test("one slow client does not disconnect a healthy subscriber", async () => {
    const bus = new EventBus();
    const router = createRouter();
    registerEventRoutes(router, { bus, heartbeatMs: 60_000, maxBufferBytes: 512 });
    const slow = await router.handle(new Request(`${BASE_URL}/api/events`));
    const healthy = await router.handle(new Request(`${BASE_URL}/api/events`));
    const reader = healthy.body!.getReader();
    await reader.read();
    for (let i = 0; i < 20; i++) {
      bus.publish({ type: "test", text: "x".repeat(128), id: i });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(`"id":${i}`);
    }
    expect(bus.subscriberCount()).toBe(1);
    await expect(slow.body!.getReader().read()).rejects.toThrow("SSE buffer limit exceeded");
    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });
});
