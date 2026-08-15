import { EventBus, type AppEvent } from "../events/bus.ts";
import type { Router } from "./router.ts";

const DEFAULT_HEARTBEAT_MS = 5000;

export type EventRoutesContext = {
  bus: EventBus;
  heartbeatMs?: number;
};

export function registerEventRoutes(router: Router, context: EventRoutesContext): void {
  router.get("/api/events", () => eventStreamResponse(context));
}

function eventStreamResponse(context: EventRoutesContext): Response {
  const subscription = context.bus.subscribe();
  const heartbeatMs = context.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = streamWriter(controller, () => closed);
      write(`retry: 1000\n\n${comment("connected")}`);
      heartbeat = setInterval(() => write(comment("heartbeat")), heartbeatMs);
      while (!closed) {
        const event = await subscription.next();
        if (event) write(data(event));
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      subscription.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

function streamWriter(controller: ReadableStreamDefaultController<Uint8Array>, isClosed: () => boolean) {
  const encoder = new TextEncoder();
  return (chunk: string) => {
    if (!isClosed()) controller.enqueue(encoder.encode(chunk));
  };
}

function comment(text: string): string {
  return `: ${text}\n\n`;
}

function data(event: AppEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
