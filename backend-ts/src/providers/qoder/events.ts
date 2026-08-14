import type { SDKMessage, SDKResultMessage } from "@qoder-ai/qoder-agent-sdk";
import { redactionRegistry } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent, providerEventSourceRef, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { NormalizedRunEvent, ProviderEvent, ProviderMetadataValue, SessionRef } from "../types.ts";
import type { QoderUsageProjection } from "./sdkFacade.ts";

const PROVIDER = "qoder" as const;

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
  const raw = recordValue(message);
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
  const session = clean(details.sessionId)
    ? { provider: PROVIDER, sessionId: clean(details.sessionId) } as const
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
  const session = clean(sessionId)
    ? { provider: PROVIDER, sessionId: clean(sessionId), ...(clean(messageRef) ? { turnId: clean(messageRef) } : {}) }
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
  const raw = recordValue(message);
  const text = resultErrorText(raw);
  const subtype = clean(raw.subtype);
  const errorCode = safeNumber(raw.error_code);
  const classification = classifyQoderFailure(text, subtype, errorCode);
  return {
    ...classification,
    ...(errorCode === undefined ? {} : { code: errorCode }),
    message: text || `Qoder result ${subtype || "failed"}`,
    sessionId: clean(raw.session_id)
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

function qoderRunEvent(
  method: string,
  raw: Record<string, unknown>,
  event: ProviderEvent,
  context: QoderEventContext
): NormalizedRunEvent {
  const type = clean(raw.type);
  const subtype = clean(raw.subtype);
  const metadata = qoderMetadata(raw, context);
  if (type === "result") return qoderResultRunEvent(method, raw, event.session, metadata, context);
  if (type === "system" && subtype === "init") {
    return normalizedRunEvent({ kind: "started", metadata, method, outcome: "running", provider: PROVIDER, session: event.session });
  }
  if (type === "system" && subtype === "session_state_changed" && clean(raw.state) === "requires_action") {
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

function qoderResultRunEvent(
  method: string,
  raw: Record<string, unknown>,
  session: SessionRef | undefined,
  metadata: Record<string, ProviderMetadataValue>,
  context: QoderEventContext
): NormalizedRunEvent {
  if (context.interrupted) {
    return normalizedRunEvent({ kind: "error", metadata, method, outcome: "interrupted", provider: PROVIDER, session });
  }
  const succeeded = clean(raw.subtype) === "success" && raw.is_error === false;
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

function qoderResultCost(
  method: string,
  raw: Record<string, unknown>,
  session: SessionRef | undefined,
  projection?: QoderUsageProjection
) {
  const usage: Record<string, unknown> = projection?.result
    ? { ...projection.result }
    : recordValue(raw.usage);
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

function applyProviderFields(event: ProviderEvent, raw: Record<string, unknown>, context: QoderEventContext): void {
  const type = clean(raw.type);
  const subtype = clean(raw.subtype);
  if (type === "result") {
    const succeeded = subtype === "success" && raw.is_error === false;
    if (context.interrupted) {
      event.type = "interrupted";
      event.status = "interrupted";
    } else if (succeeded) {
      event.type = "done";
      event.status = "completed";
      event.text = clean(raw.result);
    } else {
      event.type = "error";
      event.status = "failed";
      event.error = redactSensitiveText(resultErrorText(raw));
    }
    return;
  }
  if (type === "assistant") {
    event.text = assistantText(recordValue(raw.message));
    return;
  }
  if (type === "system" && subtype === "init") {
    event.status = "running";
    return;
  }
  if (type === "system" && subtype === "api_retry") {
    event.status = "retrying";
    event.error = redactSensitiveText(clean(raw.error));
    return;
  }
  if (type === "system" && subtype === "permission_denied") {
    event.status = "denied";
    event.error = redactSensitiveText(clean(raw.message));
    return;
  }
  if (type === "system" && subtype.startsWith("task_")) {
    event.status = clean(raw.status) || clean(recordValue(raw.patch).status) || "running";
    event.text = redactSensitiveText(clean(raw.summary) || clean(raw.description));
    return;
  }
  if (type === "system" && subtype === "session_state_changed") event.status = clean(raw.state);
}

function providerEventType(raw: Record<string, unknown>): string {
  const type = clean(raw.type);
  const subtype = clean(raw.subtype);
  if (type === "result") return "result";
  if (type === "assistant") return assistantEventType(recordValue(raw.message));
  if (type === "user" && raw.tool_use_result !== undefined) return "tool_result";
  if (type !== "system") return type === "stream_event" ? "message" : "unknown";
  if (subtype === "init") return "provider.session_started";
  if (subtype === "api_retry") return "provider.retry";
  if (subtype === "permission_denied") return "permission_denied";
  if (subtype === "mirror_error") return "provider.mirror_error";
  if (subtype === "session_state_changed" && clean(raw.state) === "requires_action") return "approval_requested";
  if (subtype === "task_started") return "subagent.started";
  if (subtype === "task_progress" || subtype === "task_updated") return "subagent.progress";
  if (subtype === "task_notification") return `subagent.${clean(raw.status) || "completed"}`;
  return "unknown";
}

function assistantEventType(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content) ? message.content.map(recordValue) : [];
  if (blocks.some((block) => clean(block.type) === "tool_use")) return "tool_call";
  if (blocks.some((block) => ["tool_result", "tool_use_result"].includes(clean(block.type)))) return "tool_result";
  return "message";
}

function progressMessage(type: string, subtype: string): boolean {
  if (["assistant", "user", "stream_event"].includes(type)) return true;
  return type === "system" && [
    "api_retry", "background_tasks_changed", "files_persisted", "hook_progress", "hook_response", "hook_started",
    "permission_denied", "session_state_changed", "status", "task_notification", "task_progress", "task_started", "task_updated"
  ].includes(subtype);
}

function nativeMethod(raw: Record<string, unknown>): string {
  const type = clean(raw.type) || "unknown";
  const subtype = clean(raw.subtype);
  return subtype ? `qoder/${type}/${subtype}` : `qoder/${type}`;
}

function messageSession(raw: Record<string, unknown>): SessionRef | undefined {
  const sessionId = clean(raw.session_id);
  if (!sessionId) return undefined;
  const messageRef = clean(raw.type) === "result" ? clean(raw.uuid) : "";
  return { provider: PROVIDER, sessionId, ...(messageRef ? { turnId: messageRef } : {}) };
}

function qoderMetadata(raw: Record<string, unknown>, context: QoderEventContext): Record<string, ProviderMetadataValue> {
  const patch = recordValue(raw.patch);
  return compactMetadata({
    error_code: safeNumber(raw.error_code),
    invocation_ref: context.invocationRef,
    message_ref: clean(raw.uuid),
    model: clean(raw.model) || clean(recordValue(raw.message).model),
    native_subtype: clean(raw.subtype),
    native_type: clean(raw.type),
    qodercli_version: clean(raw.qodercli_version),
    task_id: clean(raw.task_id),
    task_status: clean(raw.status) || clean(patch.status),
    tool_use_id: clean(raw.tool_use_id),
    usage_scope: context.resume ? "resume_semantics_unverified" : raw.type === "result" ? "attempt" : ""
  });
}

function redactedRawSummary(raw: Record<string, unknown>, usageProjection?: QoderUsageProjection): unknown {
  const type = clean(raw.type);
  const subtype = clean(raw.subtype);
  const summary: Record<string, unknown> = {
    error_code: raw.error_code,
    errors: raw.errors,
    is_error: raw.is_error,
    model: raw.model ?? recordValue(raw.message).model,
    qodercli_version: raw.qodercli_version,
    session_id: raw.session_id,
    status: raw.status ?? raw.state,
    subtype,
    task_id: raw.task_id,
    tool_use_id: raw.tool_use_id,
    type,
    uuid: raw.uuid
  };
  if (type === "assistant") summary.content = contentSummary(recordValue(raw.message).content);
  if (type === "result") {
    summary.duration_ms = raw.duration_ms;
    summary.stop_reason = raw.stop_reason;
    summary.terminal_reason = raw.terminal_reason;
    summary.usage = raw.usage;
    summary.model_usage = raw.modelUsage;
    summary.total_credits = raw.total_credits;
    summary.usage_projection = usageProjection;
  }
  return redactionRegistry.redactValue(compactObject(summary));
}

function contentSummary(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const block = recordValue(item);
    return compactObject({
      id: block.id,
      name: block.name,
      text: typeof block.text === "string" ? block.text.slice(0, 1_000) : undefined,
      tool_use_id: block.tool_use_id,
      type: block.type
    });
  });
}

function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return redactSensitiveText(message.content.map((item) => clean(recordValue(item).text)).filter(Boolean).join("\n"));
}

function resultErrorText(raw: Record<string, unknown>): string {
  const errors = Array.isArray(raw.errors) ? raw.errors.map(clean).filter(Boolean) : [];
  return redactSensitiveText(errors.join("; ") || clean(raw.result) || clean(raw.terminal_reason) || clean(raw.subtype));
}

function compactMetadata(input: Record<string, unknown>): Record<string, ProviderMetadataValue> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.trim() !== "")
  ))) as Record<string, ProviderMetadataValue>;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
