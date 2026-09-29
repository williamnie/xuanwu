import { EventBus } from "../../events/bus.ts";
import { createBoundedEventStream } from "../boundedEventStream.ts";
import { registerEventRoutes } from "../events.ts";
import { createRouter } from "../router.ts";
import { createWebGatewayHandler } from "../webGateway.ts";

export type EventStreamFixtureAddresses = { core: string; web: string; pid: number };

// 用独立进程验证 Bun HTTP sink；进程退出不能由测试框架的拒绝处理器掩盖。
const bus = new EventBus();
const router = createRouter();
registerEventRoutes(router, { bus, heartbeatMs: 10 });
let overflow: ReturnType<typeof createBoundedEventStream> | undefined;
router.get("/api/health", () => Response.json({ pid: process.pid, subscribers: bus.subscriberCount() }));
router.get("/api/test/overflow-stream", (request) => {
  overflow = createBoundedEventStream({ signal: request.signal, maxBufferBytes: 128 });
  overflow.write(": connected\n\n");
  return new Response(overflow.stream, { headers: { "content-type": "text/event-stream" } });
});
router.post("/api/test/overflow", () => {
  overflow?.write("x".repeat(129));
  return Response.json({ closed: overflow?.closed });
});
const core = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => router.handle(request) });
const web = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: createWebGatewayHandler({
    addr: "127.0.0.1:0", coreAddr: core.url.toString(), proxyTimeoutMs: 1000, webDir: ""
  })
});
console.log(JSON.stringify({ core: core.url.toString(), web: web.url.toString(), pid: process.pid } satisfies EventStreamFixtureAddresses));
