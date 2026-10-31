import { listIssueRuns } from "../db/repositories/issues.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";

import { runIssueWithProvider as runIssueWithProviderRuntime } from "./providerRuntime.ts";

import { normalizeCodexEvent } from "../providers/codex/events.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderEvent, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import type { SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../config/env.ts";
import { QoderExecutorProvider } from "../providers/qoder/provider.ts";
import { createFakeQoderSdkFacade } from "../providers/qoder/sdkFacade.ts";
import { claudeManifest } from "../providers/claude/factory.ts";
import { claudeExecutionPolicyAdapter } from "../providers/claude/executionPolicy.ts";
import { insertIssue, insertProject, useTestDatabase } from "../testing/harness.ts";

export const openFixtureDatabase = useTestDatabase();

export const FAKE_SESSION = { provider: "fake-execution-only" as ExecutorProviderId, sessionId: "fake-session", turnId: "fake-turn" };

export function fakeProvider(
  id: string,
  script: (input: ProviderRunInput, emit: (event: Omit<ProviderEvent, "provider">) => void) => ProviderRunResult | Promise<ProviderRunResult>,
  extra: Partial<ExecutorProvider> = {}
): ExecutorProvider {
  const provider = id as ExecutorProviderId;
  return {
    id: provider,
    capabilities: ["issue_execution"],
    ...extra,
    async run(input) {
      return script(input, (event) => input.onEvent?.({ ...event, provider }));
    }
  };
}

export const loggingProvider = (inputs: ProviderRunInput[] = []) => fakeProvider("fake-execution-only", (input, emit) => {
  inputs.push(input);
  emit({ type: "provider.message", session: FAKE_SESSION, text: "fake provider log" });
  return { runId: "fake-run", session: FAKE_SESSION };
});

export const codexNotifications = (sessionId: string, turnId: string, notifications: () => Array<{ method: string; params: Record<string, unknown> }>) =>
  fakeProvider("codex", (input) => {
    notifications().forEach((notification) => input.onEvent?.(normalizeCodexEvent(notification)));
    return { runId: `codex:${sessionId}:${turnId}`, session: { provider: "codex", sessionId, turnId } };
  });

export const LONG_CHUNKS = Array.from({ length: 513 }, (_, index) => `chunk-${String(index).padStart(3, "0")}\n`);

export const longSessionProvider = () => fakeProvider("codex", (_input, emit) => {
  const session = { provider: "codex" as const, sessionId: "thread-long", turnId: "turn-long" };
  for (const text of LONG_CHUNKS) {
    emit({ type: "text", session, text, raw: { method: "item/agentMessage/delta", payload: JSON.stringify({ delta: text }) } });
  }
  emit({
    type: "done",
    status: "completed",
    session,
    raw: { method: "turn/completed", payload: JSON.stringify({ turn: { id: "turn-long", status: "completed" } }) }
  });
  return { runId: "codex:thread-long:turn-long", session };
});

export function runIssueWithProvider(
  provider: Parameters<typeof runIssueWithProviderRuntime>[0],
  input: Parameters<typeof runIssueWithProviderRuntime>[1]
) {
  if (!input.database || input.issueRunId) return runIssueWithProviderRuntime(provider, input);
  const current = listIssueRuns(input.database, input.issueId).filter((run) => run.ended_at === "").at(-1)
    ?? createIssueRun(input.database, input.issueId);
  return runIssueWithProviderRuntime(provider, { ...input, issueRunId: current.id });
}

export async function runtimeFixture(issueLogMode: "debug" | "normal" = "debug") {
  const db = await openFixtureDatabase();
  insertProject(db, "demo");
  const issueId = insertIssue(db, { title: "Runtime", status: "in_progress", issue_log_mode: issueLogMode });
  const run = (provider: ExecutorProvider, overrides: Partial<Parameters<typeof runIssueWithProviderRuntime>[1]> = {}) =>
    runIssueWithProvider(provider, { database: db, issueId, projectId: "demo", cwd: "/tmp/project", prompt: "issue prompt", ...overrides });
  return { db, issueId, run };
}

export function resolved(overrides: Record<string, string> = {}) {
  return {
    resolved_settings: {
      approval_policy: "", model: "", reasoning_effort: "", sandbox: "", service_tier: "", service_tier_source: "standard", ...overrides
    }
  };
}

export function claudePolicyProvider(status: Record<string, unknown>): Partial<ExecutorProvider> {
  return {
    manifest: claudeManifest(),
    policyAdapter: claudeExecutionPolicyAdapter,
    runtimeStatus: () => status
  } as Partial<ExecutorProvider>;
}

export function qoderProvider(sessionId: string, invocationId: string, script: Parameters<typeof createFakeQoderSdkFacade>[0]): QoderExecutorProvider {
  return new QoderExecutorProvider(buildConfig().providers.qoder!, {
    facade: createFakeQoderSdkFacade(script).facade,
    invocationIdFactory: () => invocationId,
    readiness: {
      installed: true,
      ready: true,
      status: { active_sessions: 0, api_key_configured: true, mode: "sdk", ready: true, version: "1.0.23" }
    },
    sessionIdFactory: () => sessionId
  });
}

export function qoderInit(sessionId: string): SDKSystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.23",
    protocol_version: "1.2.0",
    cwd: "/tmp/project",
    tools: [],
    mcp_servers: [],
    model: "performance",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "qoder-init-1",
    session_id: sessionId
  };
}

export function qoderResult(sessionId: string): SDKResultMessage {
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
    uuid: "qoder-result-1",
    session_id: sessionId
  };
}
