import { describe, expect, test } from "bun:test";
import { createBoundedEventStream } from "./boundedEventStream.ts";

describe("bounded SSE response stream", () => {
  test("uses UTF-8 byte accounting and discards an overflowing backlog", async () => {
    let closed = 0;
    const output = createBoundedEventStream({ maxBufferBytes: 8, onClose: () => closed++ });
    expect(output.write("你好")).toBe(true);
    expect(output.write("啊")).toBe(false);
    expect(output.closed).toBe(true);
    expect(closed).toBe(1);
    expect(output.write("later")).toBe(false);
    expect((await output.stream.getReader().read()).done).toBe(true);
    output.close();
    output.abort();
    expect(closed).toBe(1);
  });

  test("releases the budget as a healthy consumer reads, and preserves the final event", async () => {
    const output = createBoundedEventStream({ maxBufferBytes: 8 });
    const reader = output.stream.getReader();
    for (let i = 0; i < 100; i++) {
      expect(output.write("你好")).toBe(true);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("你好");
    }
    expect(output.write("final")).toBe(true);
    output.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("final");
    expect((await reader.read()).done).toBe(true);
  });

  test("cancel and request abort clean up exactly once", async () => {
    const signal = new AbortController();
    let closed = 0;
    const output = createBoundedEventStream({ signal: signal.signal, onClose: () => closed++ });
    await output.stream.cancel();
    signal.abort();
    expect(closed).toBe(1);
    expect(output.write("later")).toBe(false);
  });

  test("request abort discards queued data and an already aborted request never starts writing", async () => {
    const signal = new AbortController();
    let closed = 0;
    const output = createBoundedEventStream({ signal: signal.signal, onClose: () => closed++ });
    output.write("queued");
    signal.abort(new Error("client disconnected"));
    expect((await output.stream.getReader().read()).done).toBe(true);
    const next = createBoundedEventStream({ signal: signal.signal, onClose: () => closed++ });
    expect(next.write("unreachable")).toBe(false);
    expect((await next.stream.getReader().read()).done).toBe(true);
    expect(closed).toBe(2);
  });

  test("rejects oversized single events without retaining them", async () => {
    const output = createBoundedEventStream({ maxBufferBytes: 8 });
    expect(output.write("x".repeat(9))).toBe(false);
    expect((await output.stream.getReader().read()).done).toBe(true);
  });

  test("normal completion drains all queued final events in order", async () => {
    let closed = 0;
    const output = createBoundedEventStream({ maxBufferBytes: 16, onClose: () => closed++ });
    output.write("accepted");
    output.write("done");
    output.close();
    expect(closed).toBe(1);
    expect(output.write("later")).toBe(false);
    const reader = output.stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("accepted");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("done");
    expect((await reader.read()).done).toBe(true);
  });

  test("abort completes pending reads and cancel discards a graceful close backlog", async () => {
    const output = createBoundedEventStream();
    const reader = output.stream.getReader();
    const pending = [reader.read(), reader.read()];
    output.abort();
    expect((await Promise.all(pending)).every((read) => read.done)).toBe(true);
    const next = createBoundedEventStream();
    next.write("queued");
    next.close();
    await next.stream.cancel();
    expect((await next.stream.getReader().read()).done).toBe(true);
  });
});
