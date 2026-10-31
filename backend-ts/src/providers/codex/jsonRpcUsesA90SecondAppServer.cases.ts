import { describe, expect, test } from "bun:test";
import { codexAppServerRpcTimeoutMs, CodexStdioJsonRpcTransport } from "./jsonRpc.ts";
import type { ProviderEvent } from "../types.ts";
import type { CodexJsonRpcProcess } from "./jsonRpc.ts";
import { CodexProcessGroupLifecycle, type ProcessTreeEntry } from "./processLifecycle.ts";

import { FakeCodexProcess, FakeStdin, config, flushTimers, waitFor, encode } from "./jsonRpcTestFixtures.ts";

export function registerUsesA90SecondAppServer() {
test("uses a 90 second app-server RPC cap while preserving shorter overrides", () => {
    expect(codexAppServerRpcTimeoutMs(1_800_000)).toBe(90_000);
    expect(codexAppServerRpcTimeoutMs(90_000)).toBe(90_000);
    expect(codexAppServerRpcTimeoutMs(60_000)).toBe(60_000);
    expect(codexAppServerRpcTimeoutMs(1)).toBe(1);
  });

test("parses stdout line frames split across chunks", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport(config, {
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });
    await transport.start();

    const pending = transport.request("model/list", {});
    fake.sendStdoutChunk('{"id":1,"result":{"ok"');
    fake.sendStdoutChunk(':true}}\n');

    await expect(pending).resolves.toEqual({ ok: true });
  });

test("rejects pending requests when the app-server exits", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport(config, {
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });
    await transport.start();

    const pending = transport.request("thread/list", {});
    fake.exit(7);

    await expect(pending).rejects.toThrow("codex app-server exited before response (code 7)");
  });

test("advances process generation when the app-server exits unexpectedly", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport(config, {
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });
    await transport.start();

    const initialGeneration = transport.generation();

    fake.exit(7);
    await fake.exited;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.generation()).toBeGreaterThan(initialGeneration);
  });

test("times out hung app-server requests and stops the stale process", async () => {
    let fake!: FakeCodexProcess;
    const diagnostics: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 1 }, {
      onDiagnostic: (event) => diagnostics.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });

    const pending = transport.request("thread/list", {});

    await expect(pending).rejects.toThrow("codex app-server request timed out after 1ms: thread/list");
    expect(diagnostics).toContainEqual(expect.objectContaining({ type: "process/timeout" }));
    await expect(fake.exited).resolves.toBe(0);
  });

test("keeps one owned app-server through an active turn and idle-stops it after the terminal event", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport(config, {
      idleTtlMs: 1,
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          process.sendStdout({ id: request.id, result: { ok: true } });
        });
        return fake;
      }
    });
    const lease = transport.acquire("project:demo:issue:1:run");
    lease.bind("thread-owned", "turn-owned");

    await transport.request("initialize", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(transport.runtimeSnapshot().owners).toEqual(["project:demo:issue:1:run"]);

    fake.sendNotification("turn/completed", {
      threadId: "thread-owned",
      turn: { id: "turn-owned", status: "completed" }
    });
    await expect(fake.exited).resolves.toBe(0);
    expect(transport.runtimeSnapshot().owners).toEqual([]);
  });

test("returns to the zero-process baseline across 20 idle reuse cycles", async () => {
    const processes: FakeCodexProcess[] = [];
    let live = 0;
    let peak = 0;
    const transport = new CodexStdioJsonRpcTransport(config, {
      idleTtlMs: 1,
      processFactory: () => {
        live += 1;
        peak = Math.max(peak, live);
        const fake = new FakeCodexProcess((request, process) => {
          process.sendStdout({ id: request.id, result: { cycle: processes.length } });
        });
        void fake.exited.then(() => { live -= 1; });
        processes.push(fake);
        return fake;
      }
    });

    for (let cycle = 0; cycle < 20; cycle += 1) {
      await transport.request("thread/list", {});
      await waitFor(() => live === 0);
    }

    expect(processes).toHaveLength(20);
    expect(peak).toBe(1);
    expect(live).toBe(0);
  });

test("advances process generation when a timeout stops the stale process", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 1 }, {
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });

    const initialGeneration = transport.generation();
    const pending = transport.request("thread/start", {});

    await expect(pending).rejects.toThrow("codex app-server request timed out after 1ms: thread/start");

    expect(transport.generation()).toBeGreaterThan(initialGeneration);
    await expect(fake.exited).resolves.toBe(0);
  });

test("captures stderr diagnostics with sensitive values redacted", async () => {
    let fake!: FakeCodexProcess;
    const diagnostics: string[] = [];
    const transport = new CodexStdioJsonRpcTransport(config, {
      onDiagnostic: (event) => { if (event.text) diagnostics.push(event.text); },
      processFactory: () => {
        fake = new FakeCodexProcess(() => {});
        return fake;
      }
    });
    await transport.start();

    fake.sendStderr("SAFE_VALUE=ok CODEX_API_KEY=fixture-secret");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.stderrLines()).toEqual(["SAFE_VALUE=ok CODEX_API_KEY=[redacted]"]);
    expect(diagnostics.join("\n")).not.toContain("fixture-secret");
  });

test("answers app-server server requests on stdout frames with ids", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport(config, {
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({ id: 99, method: "item/tool/requestUserInput", params: { prompt: "continue?" } });
            process.sendStdout({ id: request.id, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.requests).toContainEqual({ id: 99, result: { answers: {} } });
  });
}
