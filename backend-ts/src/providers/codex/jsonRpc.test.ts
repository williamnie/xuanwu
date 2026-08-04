import { describe, expect, test } from "bun:test";
import { codexAppServerRpcTimeoutMs, CodexStdioJsonRpcTransport, runCodexTransportInitializeSmoke } from "./jsonRpc.ts";
import type { ProviderEvent } from "../types.ts";
import type { CodexJsonRpcProcess, CodexJsonRpcProcessFactory } from "./jsonRpc.ts";

class FakeCodexProcess implements CodexJsonRpcProcess {
  readonly stdin = new FakeStdin((line) => this.onRequest(line));
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly requests: Array<Record<string, unknown>> = [];
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private exitResolve!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => { this.exitResolve = resolve; });

  constructor(private readonly handler: (request: Record<string, unknown>, fake: FakeCodexProcess) => void) {
    this.stdout = new ReadableStream<Uint8Array>({ start: (controller) => { this.stdoutController = controller; } });
    this.stderr = new ReadableStream<Uint8Array>({ start: (controller) => { this.stderrController = controller; } });
  }

  kill(): void {
    this.exit(0);
  }

  sendStdout(value: unknown): void {
    this.sendStdoutChunk(`${JSON.stringify(value)}\n`);
  }

  sendNotification(method: string, params: unknown): void {
    this.sendStdout({ method, params });
  }

  sendStdoutChunk(text: string): void {
    this.stdoutController.enqueue(encode(text));
  }

  sendStderr(line: string): void {
    this.stderrController.enqueue(encode(`${line}\n`));
  }

  exit(code: number): void {
    this.stdoutController.close();
    this.stderrController.close();
    this.exitResolve(code);
  }

  private onRequest(line: string): void {
    const request = JSON.parse(line) as Record<string, unknown>;
    this.requests.push(request);
    this.handler(request, this);
  }
}

class FakeStdin {
  private buffer = "";
  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() !== "") this.onLine(line);
    }
  }

  flush(): void {}
  end(): void {}
}

const config = {
  command: "codex app-server --listen stdio://",
  cwd: "",
  env: { CODEX_API_KEY: "fixture-secret", SAFE_VALUE: "ok" },
  timeoutMs: 1_000
};

describe("Codex stdio JSON-RPC transport", () => {
  test("uses a 90 second app-server RPC cap while preserving shorter overrides", () => {
    expect(codexAppServerRpcTimeoutMs(1_800_000)).toBe(90_000);
    expect(codexAppServerRpcTimeoutMs(90_000)).toBe(90_000);
    expect(codexAppServerRpcTimeoutMs(60_000)).toBe(60_000);
    expect(codexAppServerRpcTimeoutMs(1)).toBe(1);
  });

  test("runs an initialize smoke request over fake stdio", async () => {
    let spawnedCommand: string[] = [];
    let spawnedEnvironment: Record<string, string | undefined> = {};
    const factory: CodexJsonRpcProcessFactory = ({ command, env }) => {
      spawnedCommand = command;
      spawnedEnvironment = env;
      return new FakeCodexProcess((request, fake) => {
        expect(request).toMatchObject({ id: 1, method: "initialize" });
        fake.sendStdout({ id: request.id, result: { protocolVersion: "fixture" } });
      });
    };

    const result = await runCodexTransportInitializeSmoke(config, { processFactory: factory });

    expect(spawnedCommand).toEqual(["codex", "app-server", "--listen", "stdio://"]);
    expect(spawnedEnvironment.XUANWU_MANAGED_EXECUTION).toBe("1");
    expect(result).toEqual({ protocolVersion: "fixture" });
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

  test("routes gray current-workspace commands through pending approval events", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => {
        events.push(event);
        if ((event.raw as { method?: string } | undefined)?.method === "approval/requested") {
          void transport.resolveApprovalRequest("item-command", { decision: "reject", scope: "turn" });
        }
      },
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                startedAtMs: 1,
                command: "git commit -m test",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "decline" } });
    expect(events).toEqual([
      expect.objectContaining({ raw: expect.objectContaining({ method: "approval/requested" }), status: "pending" }),
      expect.objectContaining({ raw: expect.objectContaining({ method: "approval/resolved" }), status: "deny" })
    ]);
  });

  test("declines deterministic high-risk approval requests without publishing approval events", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => events.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                command: "sudo cat CODEX_API_KEY=fixture-secret /Users/example/private.txt",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "decline" } });
    expect(events).toEqual([]);
  });

  test("accepts exact low-risk approval requests without publishing approval events", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => events.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                command: "git status",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "accept" } });
    expect(events).toEqual([]);
  });

  test("denies unknown permission scope without holding the RPC", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/permissions/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-permissions",
                permissions: { network: true },
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { permissions: {}, scope: "turn" } });
  });

  test("writes fast approval responses before deferred audit hook failures", async () => {
    let fake!: FakeCodexProcess;
    const hookMethods: string[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => {
        hookMethods.push(event.raw?.method ?? "");
        throw new Error("audit unavailable");
      },
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                command: "git status",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "accept" } });
    expect(hookMethods).toEqual([]);
    await flushTimers();
    expect(hookMethods).toEqual(["approval/fast_resolved"]);
  });

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
});

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
