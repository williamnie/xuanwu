import { describe, expect, test } from "bun:test";
import { codexAppServerRpcTimeoutMs, CodexStdioJsonRpcTransport } from "./jsonRpc.ts";
import type { ProviderEvent } from "../types.ts";
import type { CodexJsonRpcProcess } from "./jsonRpc.ts";
import { CodexProcessGroupLifecycle, type ProcessTreeEntry } from "./processLifecycle.ts";

export class FakeCodexProcess implements CodexJsonRpcProcess {
  pid?: number;
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

export class FakeStdin {
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

export const config = {
  command: "codex app-server --listen stdio://",
  cwd: "",
  env: { CODEX_API_KEY: "fixture-secret", SAFE_VALUE: "ok" },
  timeoutMs: 1_000
};

export async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
