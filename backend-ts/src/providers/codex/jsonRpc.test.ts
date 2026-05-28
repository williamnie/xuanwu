import { describe, expect, test } from "bun:test";
import { CodexStdioJsonRpcTransport, runCodexTransportInitializeSmoke } from "./jsonRpc.ts";
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
  test("runs an initialize smoke request over fake stdio", async () => {
    let spawnedCommand: string[] = [];
    const factory: CodexJsonRpcProcessFactory = ({ command }) => {
      spawnedCommand = command;
      return new FakeCodexProcess((request, fake) => {
        expect(request).toMatchObject({ id: 1, method: "initialize" });
        fake.sendStdout({ id: request.id, result: { protocolVersion: "fixture" } });
      });
    };

    const result = await runCodexTransportInitializeSmoke(config, { processFactory: factory });

    expect(spawnedCommand).toEqual(["codex", "app-server", "--listen", "stdio://"]);
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
});

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
