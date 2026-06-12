import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus, type AppEvent } from "../events/bus.ts";
import { CodexAdapter } from "../providers/codex/adapter.ts";
import { CodexStdioJsonRpcTransport, type CodexJsonRpcProcess } from "../providers/codex/jsonRpc.ts";
import { codexProviderAppEvent } from "../providers/codex/provider.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { force: true, recursive: true });
});

describe("Codex approvals compatibility API", () => {
  test("resolves pending app-server approval requests and emits SSE events", async () => {
    const database = await openFixtureDatabase();
    const bus = new EventBus();
    const subscription = bus.subscribe();
    let fake!: FakeCodexProcess;
    let turnRequestId: unknown;
    let approvalResponse: Record<string, unknown> | null = null;
    try {
      const transport = new CodexStdioJsonRpcTransport(codexConfig(), {
        onEvent: (event) => bus.publish(codexProviderAppEvent(event)),
        processFactory: () => {
          fake = new FakeCodexProcess((request, process) => {
            if (request.method === "turn/start") {
              turnRequestId = request.id;
              process.sendStdout({
                id: "approval-http",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: "thread-http",
                  turnId: "turn-http",
                  itemId: "approval-http",
                  command: "git status",
                  cwd: "/repo"
                }
              });
            }
            if (request.id === "approval-http" && request.result) {
              approvalResponse = request;
              process.sendStdout({ id: turnRequestId, result: { turn: { id: "turn-http" } } });
            }
          });
          return fake;
        }
      });
      const adapter = new CodexAdapter(transport);
      const router = createDefaultRouter({
        bus,
        database,
        providers: { codex: approvalProvider(adapter) }
      });

      const pendingTurn = transport.request("turn/start", { threadId: "thread-http" });
      const requested = await nextMethod(subscription, "approval/requested");

      expect(requested).toMatchObject({
        type: "codex.event",
        provider: "codex",
        method: "approval/requested",
        threadId: "thread-http",
        turnId: "turn-http"
      });
      expect(JSON.parse(String(requested.payload))).toMatchObject({
        id: "approval-http",
        method: "item/commandExecution/requestApproval",
        params: { command: "git status", cwd: "/repo" }
      });

      const resolvedResponse = await router.handle(jsonRequest("/api/codex/approvals/approval-http/resolve", {
        decision: "approve_session",
        scope: "session"
      }));
      const resolved = await nextMethod(subscription, "approval/resolved");

      expect(resolvedResponse.status).toBe(200);
      await expect(pendingTurn).resolves.toEqual({ turn: { id: "turn-http" } });
      expect(approvalResponse).toEqual({ id: "approval-http", result: { decision: "acceptForSession" } });
      expect(resolved).toMatchObject({
        type: "codex.event",
        method: "approval/resolved"
      });
      expect(JSON.parse(String(resolved.payload))).toMatchObject({
        id: "approval-http",
        decision: "approve_session",
        scope: "session"
      });
    } finally {
      subscription.close();
      database.close();
    }
  });
});

function approvalProvider(adapter: CodexAdapter): ExecutorProvider {
  return {
    id: "codex",
    capabilities: ["approvals"],
    run: async (_input: ProviderRunInput) => { throw new Error("not implemented"); },
    resolveApproval: (requestId, decision) => adapter.resolveApproval(requestId, decision).then(() => undefined)
  };
}

async function nextMethod(subscription: ReturnType<EventBus["subscribe"]>, method: string): Promise<AppEvent> {
  for (let index = 0; index < 5; index += 1) {
    const event = await subscription.next();
    if (event?.method === method) return event;
  }
  throw new Error(`missing event ${method}`);
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-approval-api-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: root });
}

function codexConfig() {
  return {
    command: "codex app-server --listen stdio://",
    cwd: "",
    env: {},
    timeoutMs: 1_000
  };
}

class FakeCodexProcess implements CodexJsonRpcProcess {
  readonly stdin = new FakeStdin((line) => this.onRequest(line));
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private exitResolve!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => { this.exitResolve = resolve; });

  constructor(private readonly handler: (request: Record<string, unknown>, fake: FakeCodexProcess) => void) {
    this.stdout = new ReadableStream<Uint8Array>({ start: (controller) => { this.stdoutController = controller; } });
    this.stderr = new ReadableStream<Uint8Array>({ start: (controller) => { this.stderrController = controller; } });
  }

  kill(): void {
    this.stdoutController.close();
    this.stderrController.close();
    this.exitResolve(0);
  }

  sendStdout(value: unknown): void {
    this.stdoutController.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  }

  private onRequest(line: string): void {
    this.handler(JSON.parse(line) as Record<string, unknown>, this);
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
