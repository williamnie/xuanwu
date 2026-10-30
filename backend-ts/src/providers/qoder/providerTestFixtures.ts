import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKSystemInitMessage, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { checkManifest } from "../core/conformance.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderEvent } from "../types.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";
import type { QoderSessionFunctions } from "./sessionHistory.ts";

export const qoderConfig = buildConfig().providers.qoder!;

export const readyProbe: QoderRuntimeProbe = {
  installed: true,
  ready: true,
  status: {
    active_sessions: 0,
    api_key_configured: true,
    auth_configured: true,
    auth_mode: "pat-env",
    auth_source: "environment",
    executable_ready: true,
    mode: "sdk",
    ready: true,
    version: "1.0.23",
    platform_profile: { cli_version: "1.1.23", protocol_version: "1.2.0", sdk_version: "1.0.23" }
  }
};

export function init(sessionId = "qoder-session-9"): SDKSystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.23",
    protocol_version: "1.2.0",
    cwd: "/fixture/project",
    tools: [],
    mcp_servers: [],
    model: "performance",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "init-1",
    session_id: sessionId
  };
}

export function taskNotification(status: "completed" | "failed" | "stopped", sessionId = "qoder-session-9"): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "t1",
    status,
    output_file: "",
    summary: "subagent update",
    uuid: `task-${status}`,
    session_id: sessionId
  };
}

export function sdkResult(sessionId = "qoder-session-9", overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 1,
      iterations: [],
      output_tokens: 1,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: ""
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-1",
    session_id: sessionId,
    ...overrides
  } as SDKResultMessage;
}

export function provider(
  facade: QoderSdkFacade,
  ids: { invocation?: string; session?: string } = {},
  sessionFunctions?: Partial<QoderSessionFunctions>
): QoderExecutorProvider {
  return new QoderExecutorProvider(qoderConfig, {
    facade,
    invocationIdFactory: () => ids.invocation ?? "qoder-inv-1",
    readiness: readyProbe,
    sessionIdFactory: () => ids.session ?? "qoder-session-9",
    sessionFunctions
  });
}

export const sessionInfo: SDKSessionInfo = {
    sessionId: "qoder-session-9",
    summary: "Qoder session",
    firstPrompt: "hello",
    cwd: "/fixture/project",
    createdAt: 1_700_000_000_000,
    lastModified: 1_700_000_100_000
  };

export const history = [{
    type: "user",
    uuid: "user-1",
    session_id: sessionInfo.sessionId,
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    parent_agent_id: null
  }] as SessionMessage[];

export class ConcurrentFacade implements QoderSdkFacade {
  readonly available = true;
  readonly interrupted: string[] = [];
  private readonly active = new Map<string, {
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void;
    options: QoderRunOptions;
    resolve: (outcome: QoderQueryResult) => void;
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
      onMessage?.(init(options.sessionId), { interrupted: false });
      this.readyCount += 1;
      if (this.readyCount === 2) this.resolveReady();
    });
  }

  async interrupt(invocationKey: string): Promise<void> {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("not active");
    this.interrupted.push(invocationKey);
    const sessionId = active.options.sessionId ?? "";
    const result = sdkResult(sessionId, { uuid: `result-${invocationKey}` });
    active.onMessage?.(result, { interrupted: true });
    this.active.delete(invocationKey);
    active.resolve({
      invocationRef: invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: "interrupted"
    });
  }

  succeed(invocationKey: string): void {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("not active");
    const sessionId = active.options.sessionId ?? "";
    const result = sdkResult(sessionId, { uuid: `result-${invocationKey}` });
    active.onMessage?.(result, { interrupted: false });
    this.active.delete(invocationKey);
    active.resolve({
      invocationRef: invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: "succeeded"
    });
  }

  activeCount(): number { return this.active.size; }
  async listModels() { return []; }
  processLeases() {
    return [...this.active.keys()].map((invocationOwner, index) => ({
      commandLabel: "fake-qoder",
      invocationOwner,
      pid: 1000 + index,
      startedAt: "2026-08-12T00:00:00Z"
    }));
  }
  async close(): Promise<void> { this.active.clear(); }
}
