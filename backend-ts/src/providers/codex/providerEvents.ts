import { effectiveCodexHome } from "../../config/codexServer.ts";
import { CodexAdapter } from "./adapter.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { AppEvent } from "../../events/bus.ts";
import type { ProviderRunInput, ProviderRunResult, SessionCreateResult, ProviderEvent } from "../types.ts";
import type { CodexInitializeResult, TurnStartResult } from "./adapter.ts";
import { CodexStdioJsonRpcTransport } from "./jsonRpc.ts";
import { type CodexThreadTitleGenerator } from "./threadNaming.ts";
import { CodexAppEventSink, CodexEventHub, DEFAULT_DEVELOPER_INSTRUCTIONS, PROVIDER_CODEX } from "./providerModel.ts";
import { CodexExecutorProvider } from "./provider.ts";
import { payloadText, compactAppEvent } from "./providerOptions.ts";

export function createCodexExecutorProvider(
  config: ProviderRuntimeConfig,
  appEventSink?: CodexAppEventSink,
  options: { ownershipFile?: string; generateTitle?: CodexThreadTitleGenerator } = {}
): CodexExecutorProvider {
  const events = new CodexEventHub();
  const publish = (event: ProviderEvent) => {
    events.publish(event);
    if (isApprovalProviderEvent(event) || event.raw?.method === "thread/name/updated") appEventSink?.(codexProviderAppEvent(event));
  };
  const transport = new CodexStdioJsonRpcTransport(config, {
    onDiagnostic: publish,
    onEvent: publish,
    ownershipFile: options.ownershipFile
  });
  return new CodexExecutorProvider(new CodexAdapter(transport), DEFAULT_DEVELOPER_INSTRUCTIONS, events, transport, options.generateTitle, effectiveCodexHome(config));
}

export function codexProviderAppEvent(event: ProviderEvent): AppEvent {
  const rawPayload = payloadText(event.raw?.payload);
  return compactAppEvent({
    type: "codex.event",
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    method: event.raw?.method,
    raw_method: event.raw?.method,
    raw_payload: rawPayload,
    payload: rawPayload ?? payloadText(event.payload),
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error
  });
}

export function isApprovalProviderEvent(event: ProviderEvent): boolean {
  return event.raw?.method === "approval/requested" ||
    event.raw?.method === "approval/resolved" ||
    event.raw?.method === "approval/fast_resolved";
}

export function sessionRef(turn: TurnStartResult): ProviderRunResult["session"] {
  return { provider: PROVIDER_CODEX, sessionId: turn.provider_session_id, turnId: turn.turn_id };
}

export function runID(turn: TurnStartResult): string {
  const turnID = turn.turn_id || "pending-turn";
  return `${PROVIDER_CODEX}:${turn.provider_session_id}:${turnID}`;
}

export function turnStartedEvent(
  turn: TurnStartResult,
  input: ProviderRunInput,
  initialized: CodexInitializeResult
): ProviderEvent {
  const session = sessionRef(turn);
  return {
    provider: PROVIDER_CODEX,
    type: "turn_started",
    status: "inProgress",
    session,
    runEvent: normalizedRunEvent({
      kind: "started",
      metadata: {
        model: input.model,
        protocol_version: initialized.protocolVersion,
        provider_name: initialized.serverInfo?.name,
        provider_version: initialized.serverInfo?.version,
        service_tier: input.serviceTier
      },
      method: "turn/start",
      outcome: "running",
      provider: PROVIDER_CODEX,
      session
    })
  };
}

export function createResult(threadID: string): SessionCreateResult {
  return { id: `${PROVIDER_CODEX}:${threadID}`, provider: PROVIDER_CODEX, provider_session_id: threadID, thread_id: threadID };
}
