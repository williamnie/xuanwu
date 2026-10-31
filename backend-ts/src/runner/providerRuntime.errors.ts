import { normalizedRunEvent } from "../providers/runEvents.ts";
import { type ExecutorProviderId, type ProviderEvent } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";

export function providerRunErrorEvent(provider: ExecutorProviderId, error: unknown): ProviderEvent {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return {
    error: message,
    provider,
    raw: { method: "provider/run_error", payload: message },
    runEvent: normalizedRunEvent({ kind: "error", method: "provider/run_error", outcome: "failed", provider }),
    status: "failed",
    type: "error"
  };
}

export function policyResolutionErrorEvent(provider: ExecutorProviderId, code: string, message: string): ProviderEvent {
  return {
    error: message,
    provider,
    raw: { method: "execution-policy/resolve_error", payload: { code, message } },
    runEvent: normalizedRunEvent({
      kind: "error",
      method: "execution-policy/resolve_error",
      outcome: "failed",
      provider
    }),
    status: "configuration_error",
    type: "error"
  };
}
