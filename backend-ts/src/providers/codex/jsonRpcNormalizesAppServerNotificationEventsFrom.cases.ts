import { describe, expect, test } from "bun:test";
import { codexAppServerRpcTimeoutMs, CodexStdioJsonRpcTransport } from "./jsonRpc.ts";
import type { ProviderEvent } from "../types.ts";
import type { CodexJsonRpcProcess } from "./jsonRpc.ts";
import { CodexProcessGroupLifecycle, type ProcessTreeEntry } from "./processLifecycle.ts";

import { FakeCodexProcess, FakeStdin, config, flushTimers, waitFor, encode } from "./jsonRpcTestFixtures.ts";

export function registerNormalizesAppServerNotificationEventsFrom() {
test("normalizes app-server notification events from fake stdout stream", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport(config, {
      onEvent: (event) => events.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });
    await transport.start();

    fake.sendNotification("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "hello" });
    fake.sendNotification("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      command: "bun test",
      delta: "pass"
    });
    fake.sendNotification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });
    fake.sendNotification("mystery/event", { threadId: "thread-1", token: "fixture-secret" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.map((event) => event.type)).toEqual(["text", "tool", "done", "raw"]);
    expect(events[0]).toMatchObject({
      provider: "codex",
      text: "hello",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
      raw: { method: "item/agentMessage/delta" }
    });
    expect(events[1]).toMatchObject({ command: "bun test", text: "pass" });
    expect(events[2]).toMatchObject({ status: "completed" });
    expect(JSON.stringify(events[3].raw)).toContain("mystery/event");
    expect(JSON.stringify(events[3].raw)).toContain("[redacted]");
    expect(JSON.stringify(events[3].raw)).not.toContain("fixture-secret");
  });

test("normalizes error notifications for issue log consumers", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport(config, {
      onEvent: (event) => events.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });
    await transport.start();

    fake.sendNotification("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: { message: "boom", additionalDetails: "CODEX_API_KEY=fixture-secret" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toMatchObject([{
      provider: "codex",
      type: "error",
      status: "failed",
      error: "boom CODEX_API_KEY=[redacted]",
      runEvent: {
        contract: "xw.run-event.v1",
        kind: "error",
        outcome: "failed",
        terminal: true
      },
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
      raw: {
        method: "error",
        payload: "{\"threadId\":\"thread-1\",\"turnId\":\"turn-1\",\"error\":{\"message\":\"boom\",\"additionalDetails\":\"CODEX_API_KEY=[redacted]\"}}"
      }
    }]);
  });

test("keeps health responsive and skips process inspection through a streaming delta flood", async () => {
    let fake!: FakeCodexProcess;
    let delivered = 0;
    let inspections = 0;
    const rows: ProcessTreeEntry[] = [
      { command: "/opt/codex app-server --listen stdio://", pgid: 100, pid: 100, ppid: 50, rss_bytes: 16_384 }
    ];
    const lifecycle = new CodexProcessGroupLifecycle("", ["codex", "app-server"], {
      inspect: () => {
        inspections += 1;
        Bun.sleepSync(1);
        return rows;
      },
      runnerPid: 50,
      signalGroup: (_pgid, signal) => { if (signal === "SIGTERM") fake.exit(0); },
      sleep: async () => {},
      stopGraceMs: 1
    });
    const transport = new CodexStdioJsonRpcTransport(config, {
      onEvent: () => { delivered += 1; },
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        fake.pid = 100;
        return fake;
      },
      processLifecycle: lifecycle
    });
    const health = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true })
    });
    try {
      await transport.start();
      expect(inspections).toBe(1);
      const flood = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({
        method: "item/agentMessage/delta",
        params: { delta: `token-${index}`, threadId: "thread-flood", turnId: "turn-flood" }
      })).join("\n");
      const started = performance.now();
      const response = new Promise<Response>((resolve, reject) => {
        setTimeout(() => { void fetch(new URL("/health", health.url)).then(resolve, reject); }, 0);
      });
      fake.sendStdoutChunk(`${flood}\n`);

      await expect(response).resolves.toMatchObject({ status: 200 });
      expect(performance.now() - started).toBeLessThan(750);
      await waitFor(() => delivered === 2_000);
      expect(inspections).toBe(1);

      fake.sendStdoutChunk([
        JSON.stringify({ method: "item/started", params: { item: { id: "one", type: "commandExecution" } } }),
        JSON.stringify({ method: "item/completed", params: { item: { id: "one", type: "commandExecution" } } })
      ].join("\n") + "\n");
      await waitFor(() => inspections === 2);
      expect(inspections).toBe(2);
    } finally {
      health.stop(true);
      await transport.stop();
    }
  });
}
