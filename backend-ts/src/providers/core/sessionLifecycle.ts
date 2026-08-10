import { normalizedRunEvent } from "../runEvents.ts";
import type {
  ExecutorProviderId,
  ProviderEvent,
  ProviderMetadataValue,
  SessionRef
} from "../types.ts";

export type ProviderSessionStartedOptions = {
  metadata?: Record<string, ProviderMetadataValue | null | undefined>;
  method: string;
  status?: string;
  turnId?: string;
};

/**
 * Provider-neutral durable Session identity builder. Provider adapters should
 * publish this identity as soon as the native runtime has reserved it, before
 * a prompt/turn can fail.
 */
export function durableProviderSessionRef(
  provider: ExecutorProviderId,
  sessionId: string,
  turnId = ""
): SessionRef {
  const session = sessionId.trim();
  const turn = turnId.trim();
  if (session === "") throw new Error(`provider "${provider}" returned an empty durable session ref`);
  return { provider, sessionId: session, ...(turn ? { turnId: turn } : {}) };
}

/**
 * Shared lifecycle event consumed by providerRuntime. Emitting this event is
 * enough for Run/Attempt/agent_sessions to persist the durable Session link;
 * adapters remain responsible for projecting later native transcript events.
 */
export function providerSessionStartedEvent(
  provider: ExecutorProviderId,
  sessionId: string,
  options: ProviderSessionStartedOptions
): ProviderEvent {
  const session = durableProviderSessionRef(provider, sessionId, options.turnId);
  const method = options.method.trim() || "provider/session_started";
  const status = options.status?.trim() || "running";
  return {
    provider,
    raw: { method },
    runEvent: normalizedRunEvent({
      kind: "started",
      metadata: options.metadata,
      method,
      outcome: "running",
      provider,
      session
    }),
    session,
    status,
    type: "provider.session_started"
  };
}
