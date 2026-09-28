import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import type { EventStreamFixtureAddresses } from "./fixtures/eventStreamServer.ts";

test("HTTP SSE disconnects and overflows preserve the Core process and other clients", async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/eventStreamServer.ts", import.meta.url))], {
    stdout: "pipe", stderr: "pipe"
  });
  const stderr = new Response(child.stderr).text();
  const stdout = child.stdout.getReader();
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
    child.kill();
  }, 10_000);
  try {
    const ready = await stdout.read();
    const addresses = JSON.parse(new TextDecoder().decode(ready.value)) as EventStreamFixtureAddresses;
    for (const base of [addresses.core, addresses.web]) {
      const healthyAbort = new AbortController();
      const healthy = await fetch(`${base}api/events`, {
        signal: AbortSignal.any([healthyAbort.signal, timeout.signal])
      });
      const healthyReader = healthy.body!.getReader();
      expect(new TextDecoder().decode((await healthyReader.read()).value)).toContain(": connected");
      for (let index = 0; index < 20; index++) {
        if (index % 2 === 0) {
          const controller = new AbortController();
          const response = await fetch(`${base}api/events`, {
            signal: AbortSignal.any([controller.signal, timeout.signal])
          });
          const reader = response.body!.getReader();
          await reader.read();
          controller.abort();
          await reader.cancel().catch(() => {});
        } else {
          await disconnectSocket(base);
        }
        await waitForSubscribers(base, 1, timeout.signal);
        expect(child.exitCode).toBeNull();
      }

      const slow = await fetch(`${base}api/test/overflow-stream`, { signal: timeout.signal });
      const slowReader = slow.body!.getReader();
      await slowReader.read();
      const overflow = await fetch(`${base}api/test/overflow`, { method: "POST", signal: timeout.signal });
      expect(await overflow.json()).toEqual({ closed: true });
      expect((await slowReader.read()).done).toBe(true);
      expect(new TextDecoder().decode((await healthyReader.read()).value)).toContain(": heartbeat");
      healthyAbort.abort();
      await healthyReader.cancel().catch(() => {});
      const health = await waitForSubscribers(base, 0, timeout.signal);
      expect(health.pid).toBe(addresses.pid);
      expect(child.exitCode).toBeNull();
    }
  } catch (error) {
    child.kill();
    await child.exited;
    throw new Error(`${String(error)}\nchild stderr:\n${await stderr}`);
  } finally {
    clearTimeout(timer);
    timeout.abort();
    child.kill();
    await child.exited;
    stdout.releaseLock();
  }
  expect(await stderr).toBe("");
}, 15_000);

async function disconnectSocket(base: string): Promise<void> {
  const url = new URL(base);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(2_000, () => socket.destroy(new Error("SSE socket timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`GET /api/events HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`));
    socket.once("data", () => {
      socket.destroy();
      resolve();
    });
  });
}

async function waitForSubscribers(base: string, subscribers: number, signal: AbortSignal) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}api/health`, { signal });
    const health = await response.json() as { pid: number; subscribers: number };
    if (health.subscribers === subscribers) return health;
    await Bun.sleep(5);
  }
  throw new Error(`SSE subscribers did not return to ${subscribers}`);
}
