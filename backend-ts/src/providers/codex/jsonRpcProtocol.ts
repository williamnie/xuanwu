import { redactSensitiveText } from "../../util/redact.ts";
import { CodexApprovalBroker } from "./approvalBroker.ts";
import { normalizeCodexEvent } from "./events.ts";
import { CodexProcessGroupLifecycle } from "./processLifecycle.ts";
import { readLines, asError, isRequestId, clearPendingTimeout } from "./jsonRpcIO.ts";
import { type CodexTransportOptions, type PendingRequest, type CodexJsonRpcProcess } from "./jsonRpcModel.ts";

export type JsonRpcResponse = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

export const MAX_STDERR_LINES = 50;

export const CODEX_PROCESS_STRUCTURE_EVENTS = new Set([
  "error",
  "item/completed",
  "item/started",
  "thread/status/changed",
  "turn/completed",
  "turn/started"
]);

export type CodexProtocolHost = {
  options: CodexTransportOptions;
  approvals: CodexApprovalBroker;
  pending: Map<number, PendingRequest>;
  stderrBuffer: string[];
  process(): CodexJsonRpcProcess | undefined;
  processLifecycle: CodexProcessGroupLifecycle;
  write(payload: Record<string, unknown>): void;
  failPending(error: Error): void;
  emitDiagnostic(method: string, text: string, error: string): void;
  releaseSession(sessionID: string, turnID?: string): void;
};

export class CodexProtocolReader {
  constructor(private readonly host: CodexProtocolHost) {}
readStdout(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    void readLines(stream, (line) => this.handleStdoutLine(line), (error) => this.host.failPending(error));
  }

readStderr(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    void readLines(stream, (line) => this.captureStderrLine(line));
  }

private handleStdoutLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch (error) {
      this.host.emitDiagnostic("protocol/error", redactSensitiveText(line), asError(error).message);
      return;
    }
    if (isRequestId(message.id) && typeof message.method === "string") {
      void this.deliverServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === "number") this.deliverResponse(message.id, message);
    if (typeof message.method === "string" && message.id === undefined) this.deliverEvent(message.method, message.params);
  }

private async deliverServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.serverRequestResult(method, params, id);
      this.host.write({ id, result });
    } catch (error) {
      this.host.write({ id, error: { code: -32603, message: asError(error).message } });
    }
  }

private async serverRequestResult(method: string, params: unknown, id: string | number = 0): Promise<unknown> {
    if (this.host.approvals.canHandle(method)) return await this.host.approvals.request(id, method, params);
    if (this.host.options.onServerRequest) return await this.host.options.onServerRequest(method, params);
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
    if (method === "item/tool/call") return { contentItems: [], success: false };
    throw new Error(`unsupported server request: ${method}`);
  }

private deliverEvent(method: string, params: unknown): void {
    const event = normalizeCodexEvent({ method, params });
    if (CODEX_PROCESS_STRUCTURE_EVENTS.has(method)) {
      void this.host.processLifecycle.refresh(this.host.process(), {
        mode: "coalesced",
        reason: "structural_event"
      }).catch((error) => this.host.emitDiagnostic(
        "process/scan_failed",
        "process topology refresh failed",
        asError(error).message
      ));
    }
    if (event.runEvent?.terminal && event.session?.sessionId) {
      this.host.releaseSession(event.session.sessionId, event.session.turnId);
    }
    this.host.options.onEvent?.(event);
  }

private deliverResponse(id: number, message: JsonRpcResponse): void {
    const request = this.host.pending.get(id);
    if (!request) return;
    this.host.pending.delete(id);
    clearPendingTimeout(request);
    if (message.error) {
      request.reject(new Error(`codex rpc ${String(message.error.code ?? "error")}: ${String(message.error.message ?? "unknown error")}`));
      return;
    }
    request.resolve(message.result);
  }

private captureStderrLine(line: string): void {
    const text = redactSensitiveText(line);
    this.host.stderrBuffer.push(text);
    if (this.host.stderrBuffer.length > MAX_STDERR_LINES) this.host.stderrBuffer.shift();
    this.host.emitDiagnostic("process/stderr", text, text);
  }
}
