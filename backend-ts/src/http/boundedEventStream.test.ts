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
    await expect(output.stream.getReader().read()).rejects.toThrow("reconnect and reload the snapshot");
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
    await expect(output.stream.getReader().read()).rejects.toThrow("client disconnected");
    const next = createBoundedEventStream({ signal: signal.signal, onClose: () => closed++ });
    expect(next.write("unreachable")).toBe(false);
    await expect(next.stream.getReader().read()).rejects.toThrow("client disconnected");
    expect(closed).toBe(2);
  });

  test("rejects oversized single events without retaining them", async () => {
    const output = createBoundedEventStream({ maxBufferBytes: 8 });
    expect(output.write("x".repeat(9))).toBe(false);
    await expect(output.stream.getReader().read()).rejects.toThrow("SSE buffer limit exceeded");
  });
});
