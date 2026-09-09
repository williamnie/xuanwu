import { EventBus, type AppEvent } from "../events/bus.ts";
import type { Router } from "./router.ts";
import { createBoundedEventStream } from "./boundedEventStream.ts";

const DEFAULT_HEARTBEAT_MS = 5000;

export type EventRoutesContext = {
  bus: EventBus;
  heartbeatMs?: number;
  maxBufferBytes?: number;
};

export function registerEventRoutes(router: Router, context: EventRoutesContext): void {
  router.get("/api/events", (request) => eventStreamResponse(context, request.signal));
}

function eventStreamResponse(context: EventRoutesContext, signal: AbortSignal): Response {
  const subscription = context.bus.subscribe();
  const heartbeatMs = context.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const output = createBoundedEventStream({
    maxBufferBytes: context.maxBufferBytes,
    signal,
    onClose() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      subscription.close();
    }
  });
  if (output.write(`retry: 1000\n\n${comment("connected")}`)) {
    heartbeat = setInterval(() => output.write(comment("heartbeat")), heartbeatMs);
    void pumpEvents().catch((error) => output.abort(error));
  }

  async function pumpEvents(): Promise<void> {
    while (!output.closed) {
      const event = await subscription.next();
      if (!event || !output.write(data(event))) break;
    }
  }

  return new Response(output.stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

function comment(text: string): string {
  return `: ${text}\n\n`;
}

function data(event: AppEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
