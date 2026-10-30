import type { SDKMessage, SDKResultMessage } from "@qoder-ai/qoder-agent-sdk";
import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent, providerEventSourceRef, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { NormalizedRunEvent, ProviderEvent, ProviderMetadataValue, SessionRef } from "../types.ts";
import type { QoderUsageProjection } from "./sdkFacade.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { nativeMethod, messageSession, redactedRawSummary, providerEventType, applyProviderFields, compactMetadata, resultErrorText, safeNumber, qoderMetadata, progressMessage } from "./eventProjection.ts";

export const PROVIDER = "qoder" as const;

export type QoderEventContext = {
  interrupted?: boolean;
  invocationRef: string;
  resume?: boolean;
  usage?: QoderUsageProjection;
};

export type QoderFailureCategory =
  | "auth"
  | "configuration"
  | "quota"
  | "policy_input"
  | "transient"
  | "max_turns"
  | "process"
  | "protocol"
  | "timeout"
  | "sdk";

export type QoderFailureDetails = {
  category: QoderFailureCategory;
  code?: number | string;
  errorClass?: string;
  exitCode?: number | null;
  message: string;
  retryable: boolean;
  sessionId?: string;
  signal?: string | null;
};

export function projectQoderMessage(message: SDKMessage, context: QoderEventContext): ProviderEvent {
  const raw = objectValue(message);
  const method = nativeMethod(raw);
  const session = messageSession(raw);
  const event: ProviderEvent = {
    provider: PROVIDER,
    raw: { method, payload: redactedRawSummary(raw, context.usage) },
    type: providerEventType(raw)
  };
  if (session) event.session = session;
  applyProviderFields(event, raw, context);
  event.runEvent = qoderRunEvent(method, raw, event, context);
  if (event.runEvent.kind === "unknown") event.payload = `${method} preserved`;
  return event;
}

export function qoderFailureEvent(details: QoderFailureDetails, invocationRef: string): ProviderEvent {
  const method = `qoder/failure/${details.category}`;
  const session = cleanString(details.sessionId)
    ? { provider: PROVIDER, sessionId: cleanString(details.sessionId) } as const
    : undefined;
  const message = redactSensitiveText(details.message || "Qoder execution failed");
  const metadata = compactMetadata({
    error_category: details.category,
    error_class: details.errorClass,
    error_code: details.code,
    exit_code: details.exitCode,
    invocation_ref: invocationRef,
    process_signal: details.signal
  });
  return {
    error: message,
    provider: PROVIDER,
    raw: { method, payload: metadata },
    runEvent: normalizedRunEvent({
      kind: "error",
      metadata,
      method,
      outcome: "failed",
      provider: PROVIDER,
      retryable: details.retryable,
      session
    }),
    session,
    status: "failed",
    type: "error"
  };
}

export function qoderInterruptedEvent(
  invocationRef: string,
  sessionId: string,
  messageRef = "",
  reason = "Qoder query interrupted"
): ProviderEvent {
  const method = "qoder/control/interrupted";
  const session = cleanString(sessionId)
    ? { provider: PROVIDER, sessionId: cleanString(sessionId), ...(cleanString(messageRef) ? { turnId: cleanString(messageRef) } : {}) }
    : undefined;
  return {
    provider: PROVIDER,
    raw: { method, payload: { invocation_ref: invocationRef } },
    runEvent: normalizedRunEvent({
      kind: "error",
      metadata: { invocation_ref: invocationRef },
      method,
      outcome: "interrupted",
      provider: PROVIDER,
      session
    }),
    session,
    status: "interrupted",
    text: redactSensitiveText(reason),
    type: "interrupted"
  };
}

export function qoderResultFailure(message: SDKResultMessage): QoderFailureDetails {
  const raw = objectValue(message);
  const text = resultErrorText(raw);
  const subtype = cleanString(raw.subtype);
  const errorCode = safeNumber(raw.error_code);
  const classification = classifyQoderFailure(text, subtype, errorCode);
  return {
    ...classification,
    ...(errorCode === undefined ? {} : { code: errorCode }),
    message: text || `Qoder result ${subtype || "failed"}`,
    sessionId: cleanString(raw.session_id)
  };
}

export function classifyQoderFailure(
  message: string,
  code = "",
  numericCode?: number
): Pick<QoderFailureDetails, "category" | "retryable"> {
  const text = `${code} ${message}`.toLowerCase();
  if (/auth|unauthori[sz]ed|forbidden|credential|access.?token/.test(text) || numericCode === 401 || numericCode === 403) {
    return { category: "auth", retryable: false };
  }
  if (/quota|credit|budget|billing|payment/.test(text) || numericCode === 402) {
    return { category: "quota", retryable: false };
  }
  if (/max.?turn/.test(text)) return { category: "max_turns", retryable: false };
  if (/policy|permission|invalid.?input|unsupported|sandbox/.test(text)) {
    return { category: "policy_input", retryable: false };
  }
  if (/timeout|timed out/.test(text)) return { category: "timeout", retryable: true };
  if (/network|temporar|unavailable|overload|rate.?limit|retry|connection|econn|503|502|429/.test(text) ||
      numericCode === 429 || (numericCode !== undefined && numericCode >= 500)) {
    return { category: "transient", retryable: true };
  }
  return { category: "sdk", retryable: false };
}

export function qoderRunEvent(
  method: string,
  raw: Record<string, unknown>,
  event: ProviderEvent,
  context: QoderEventContext
): NormalizedRunEvent {
  const type = cleanString(raw.type);
  const subtype = cleanString(raw.subtype);
  const metadata = qoderMetadata(raw, context);
  if (type === "result") return qoderResultRunEvent(method, raw, event.session, metadata, context);
  if (type === "system" && subtype === "init") {
    return normalizedRunEvent({ kind: "started", metadata, method, outcome: "running", provider: PROVIDER, session: event.session });
  }
  if (type === "system" && subtype === "session_state_changed" && cleanString(raw.state) === "requires_action") {
    return normalizedRunEvent({
      kind: "approval_requested", metadata, method, outcome: "waiting_approval", provider: PROVIDER, session: event.session
    });
  }
  if (type === "system" && subtype === "api_retry") {
    return normalizedRunEvent({
      kind: "progress", metadata, method, outcome: "running", provider: PROVIDER, retryable: true, session: event.session
    });
  }
  if (progressMessage(type, subtype)) {
    return normalizedRunEvent({ kind: "progress", metadata, method, outcome: "running", provider: PROVIDER, session: event.session });
  }
  return {
    ...unknownRunEvent(PROVIDER, method, event.session),
    metadata: { ...unknownRunEvent(PROVIDER, method, event.session).metadata, ...metadata }
  };
}

export function qoderResultRunEvent(
  method: string,
  raw: Record<string, unknown>,
  session: SessionRef | undefined,
  metadata: Record<string, ProviderMetadataValue>,
  context: QoderEventContext
): NormalizedRunEvent {
  if (context.interrupted) {
    return normalizedRunEvent({ kind: "error", metadata, method, outcome: "interrupted", provider: PROVIDER, session });
  }
  const succeeded = cleanString(raw.subtype) === "success" && raw.is_error === false;
  const cost = context.resume ? undefined : qoderResultCost(method, raw, session, context.usage);
  return normalizedRunEvent({
    ...(cost ? { cost } : {}),
    kind: succeeded ? "completed" : "error",
    metadata,
    method,
    outcome: succeeded ? "succeeded" : "failed",
    provider: PROVIDER,
    ...(succeeded ? {} : { retryable: qoderResultFailure(raw as SDKResultMessage).retryable }),
    session
  });
}

export function qoderResultCost(
  method: string,
  raw: Record<string, unknown>,
  session: SessionRef | undefined,
  projection?: QoderUsageProjection
) {
  const usage: Record<string, unknown> = projection?.result
    ? { ...projection.result }
    : objectValue(raw.usage);
  const input = safeNumber(usage.input_tokens);
  const output = safeNumber(usage.output_tokens);
  return providerRunCost({
    sourceRef: providerEventSourceRef(PROVIDER, method, session),
    usage: {
      cached_input_tokens: safeNumber("cached_input_tokens" in usage ? usage.cached_input_tokens : usage.cache_read_input_tokens),
      input_tokens: input,
      output_tokens: output,
      total_tokens: input === undefined || output === undefined ? undefined : input + output
    }
  });
}
