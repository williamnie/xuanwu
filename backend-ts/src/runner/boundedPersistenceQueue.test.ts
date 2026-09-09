import { describe, expect, test } from "bun:test";
import { createBoundedPersistenceQueue } from "./boundedPersistenceQueue.ts";

describe("bounded asynchronous persistence queue", () => {
  test("serializes writes, retains in-flight byte accounting, and drains accepted work on overflow", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const written: number[] = [];
    const queue = createBoundedPersistenceQueue<number>(async (value) => {
      if (value === 1) await gate;
      written.push(value);
    }, { maxBytes: 8, maxEntries: 4 });
    expect(queue.push(1, 4)).toBe(true);
    await Promise.resolve();
    expect(queue.push(2, 4)).toBe(true);
    expect(queue.push(3, 1)).toBe(false);
    expect(written).toEqual([]);
    expect(() => queue.throwIfFailed()).toThrow("queue budget exceeded");
    release();
    await expect(queue.flush()).rejects.toThrow("queue budget exceeded");
    expect(written).toEqual([1, 2]);
    expect(queue.push(4, 0)).toBe(false);
  });

  test("bounds entry count even for empty events", async () => {
    const queue = createBoundedPersistenceQueue(async () => {}, { maxEntries: 2 });
    expect(queue.push("a", 0)).toBe(true);
    expect(queue.push("b", 0)).toBe(true);
    expect(queue.push("c", 0)).toBe(false);
    await expect(queue.flush()).rejects.toThrow("queue budget exceeded");
  });

  test("propagates asynchronous I/O failure at flush without executing dependent terminal work", async () => {
    const written: number[] = [];
    const queue = createBoundedPersistenceQueue<number>(async (value) => {
      if (value === 2) throw new Error("disk unavailable");
      written.push(value);
    });
    queue.push(1, 1);
    queue.push(2, 1);
    queue.push(3, 1);
    await expect(queue.flush()).rejects.toThrow("disk unavailable");
    expect(written).toEqual([1]);
    expect(() => queue.throwIfFailed()).toThrow("disk unavailable");
  });

  test("supports repeated flushes and yields while draining a large inline batch", async () => {
    const written: number[] = [];
    let observedDuringDrain = -1;
    const queue = createBoundedPersistenceQueue<number>(async (value) => { written.push(value); });
    setImmediate(() => { observedDuringDrain = written.length; });
    for (let i = 0; i < 100; i++) queue.push(i, 1);
    await queue.flush();
    expect(observedDuringDrain).toBeGreaterThan(0);
    expect(observedDuringDrain).toBeLessThan(100);
    expect(written).toEqual(Array.from({ length: 100 }, (_, index) => index));
    queue.push(100, 1);
    await queue.flush();
    expect(written.at(-1)).toBe(100);
  });

  test("captures timer-side serialization failures and still waits for queued writes", async () => {
    const written: number[] = [];
    const queue = createBoundedPersistenceQueue<number>(async (value) => { written.push(value); });
    queue.push(1, 1);
    queue.fail(new Error("cannot serialize"));
    await expect(queue.flush()).rejects.toThrow("cannot serialize");
    expect(written).toEqual([1]);
  });
});
