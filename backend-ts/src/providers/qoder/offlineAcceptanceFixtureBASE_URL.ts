import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKSystemInitMessage, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { type QoderQueryResult, type QoderRunOptions, type QoderSdkFacade } from "./sdkFacade.ts";

export const BASE_URL = "http://127.0.0.1:3008";

export const roots: string[] = [];

export class SequentialFacade implements QoderSdkFacade {
  readonly available = true;
  readonly calls: QoderRunOptions[] = [];

  async run(
    _prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void
  ): Promise<QoderQueryResult> {
    this.calls.push({ ...options });
    const sequence = this.calls.length;
    const sessionId = options.resume ?? options.sessionId ?? "";
    onMessage?.(qoderInit(sessionId), { interrupted: false });
    if (sequence === 1) {
      onMessage?.({ type: "future_event", session_id: sessionId, uuid: "future-1" } as unknown as SDKMessage, {
        interrupted: false
      });
      onMessage?.({
        type: "assistant",
        message: {
          content: [{ text: "QODER_PERSONAL_ACCESS_TOKEN=fixture-secret", type: "text" }],
          model: "performance",
          role: "assistant"
        },
        request_id: "request-1",
        session_id: sessionId,
        uuid: "assistant-1"
      } as unknown as SDKMessage, { interrupted: false });
    }
    const result = qoderResult(sessionId, sequence);
    onMessage?.(result, { interrupted: false });
    return {
      invocationRef: options.invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: "succeeded"
    };
  }

  activeCount(): number { return 0; }
  async listModels() { return []; }
  processLeases() { return []; }
  async interrupt(): Promise<void> { throw new Error("no active Qoder invocation"); }
  async close(): Promise<void> {}
}

export class HeldFacade implements QoderSdkFacade {
  readonly available = true;
  readonly interrupted: string[] = [];
  private readonly active = new Map<string, {
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void;
    options: QoderRunOptions;
    resolve: (result: QoderQueryResult) => void;
  }>();
  private readyCount = 0;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  run(
    _prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void
  ): Promise<QoderQueryResult> {
    return new Promise((resolve) => {
      this.active.set(options.invocationKey, { onMessage, options, resolve });
      onMessage?.(qoderInit(options.sessionId ?? ""), { interrupted: false });
      this.readyCount += 1;
      if (this.readyCount === 2) this.resolveReady();
    });
  }

  async interrupt(invocationKey: string): Promise<void> {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("Qoder invocation is not active");
    this.interrupted.push(invocationKey);
    this.finish(invocationKey, true);
  }

  succeed(invocationKey: string): void { this.finish(invocationKey, false); }
  activeCount(): number { return this.active.size; }
  async listModels() { return []; }
  processLeases() {
    return [...this.active.keys()].map((invocationOwner, index) => ({
      commandLabel: "qoder-q6-fixture",
      invocationOwner,
      pid: 7_000 + index,
      startedAt: "2026-08-12T00:00:00Z"
    }));
  }
  async close(): Promise<void> { this.active.clear(); }

  private finish(invocationKey: string, interrupted: boolean): void {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("Qoder invocation is not active");
    const sessionId = active.options.sessionId ?? "";
    const result = qoderResult(sessionId, Number(invocationKey.split("-").at(-1)));
    active.onMessage?.(result, { interrupted });
    this.active.delete(invocationKey);
    active.resolve({
      invocationRef: invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: interrupted ? "interrupted" : "succeeded"
    });
  }
}

export function historyFunctions() {
  const info: SDKSessionInfo = {
    createdAt: 1_723_420_800_000,
    cwd: "/fixture/qoder-q6",
    firstPrompt: "Run the isolated Qoder fixture without network access.",
    lastModified: 1_723_420_801_000,
    sessionId: "qoder-q6-session-1",
    summary: "Qoder Q6 offline fixture"
  };
  const messages = [{
    message: { role: "user", content: "Run the fixture" },
    parent_agent_id: null,
    parent_tool_use_id: null,
    session_id: info.sessionId,
    type: "user",
    uuid: "history-user-1"
  }, {
    message: { role: "assistant", content: [{ type: "text", text: "fixture completed" }] },
    parent_agent_id: null,
    parent_tool_use_id: null,
    request_id: "history-request-1",
    session_id: info.sessionId,
    type: "assistant",
    uuid: "history-assistant-1"
  }] as unknown as SessionMessage[];
  return {
    async getSessionInfo(sessionId: string) { return sessionId === info.sessionId ? info : undefined; },
    async getSessionMessages(sessionId: string, options?: { offset?: number }) {
      return sessionId === info.sessionId && (options?.offset ?? 0) === 0 ? messages : [];
    },
    async listSessions() { return [info]; }
  };
}

export function qoderInit(sessionId: string): SDKSystemInitMessage {
  return {
    apiKeySource: "none",
    cwd: "/fixture/qoder-q6",
    mcp_servers: [],
    model: "performance",
    output_style: "default",
    permissionMode: "dontAsk",
    plugins: [],
    protocol_version: "1.2.0",
    qodercli_version: "1.1.23",
    session_id: sessionId,
    skills: [],
    slash_commands: [],
    subtype: "init",
    tools: [],
    type: "system",
    uuid: `qoder-q6-init-${sessionId}`
  };
}

export function qoderResult(
  sessionId: string,
  sequence: number,
  overrides: Partial<SDKResultMessage> = {}
): SDKResultMessage {
  return {
    duration_api_ms: 5,
    duration_ms: 8,
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: "RUNNER_OUTCOME: completed | Qoder Q6 fixture completed",
    session_id: sessionId,
    stop_reason: "end_turn",
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 10,
      iterations: [],
      output_tokens: 4,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: ""
    },
    uuid: `qoder-q6-result-${sequence}`,
    ...overrides
  } as SDKResultMessage;
}
