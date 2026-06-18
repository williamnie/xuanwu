import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { CodexStdioJsonRpcTransport, type CodexJsonRpcProcess } from "../providers/codex/jsonRpc.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { force: true, recursive: true });
});

describe("Codex approvals compatibility API", () => {
  test("auto-approves exact low-risk app-server approval requests without SSE events", async () => {
    const database = await openFixtureDatabase();
    const bus = new EventBus();
    const events: unknown[] = [];
    const unsubscribe = bus.observe((event) => events.push(event));
    let fake!: FakeCodexProcess;
    let turnRequestId: unknown;
    let approvalResponse: unknown;
    try {
      const transport = new CodexStdioJsonRpcTransport(codexConfig(), {
        onEvent: (event) => bus.publish({ provider: event.provider, type: event.type }),
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

      const pendingTurn = transport.request("turn/start", { threadId: "thread-http" });

      await expect(pendingTurn).resolves.toEqual({ turn: { id: "turn-http" } });
      expect(approvalResponse).toEqual({ id: "approval-http", result: { decision: "accept" } });
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      database.close();
    }
  });
});

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
