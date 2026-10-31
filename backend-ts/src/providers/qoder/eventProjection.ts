import { redactionRegistry } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { ProviderEvent, ProviderMetadataValue, SessionRef } from "../types.ts";
import type { QoderUsageProjection } from "./sdkFacade.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { QoderEventContext, PROVIDER } from "./events.ts";

export function applyProviderFields(event: ProviderEvent, raw: Record<string, unknown>, context: QoderEventContext): void {
  const type = cleanString(raw.type);
  const subtype = cleanString(raw.subtype);
  if (type === "result") {
    const succeeded = subtype === "success" && raw.is_error === false;
    if (context.interrupted) {
      event.type = "interrupted";
      event.status = "interrupted";
    } else if (succeeded) {
      event.type = "done";
      event.status = "completed";
      event.text = cleanString(raw.result);
    } else {
      event.type = "error";
      event.status = "failed";
      event.error = redactSensitiveText(resultErrorText(raw));
    }
    return;
  }
  if (type === "assistant") {
    event.text = assistantText(objectValue(raw.message));
    return;
  }
  if (type === "system" && subtype === "init") {
    event.status = "running";
    return;
  }
  if (type === "system" && subtype === "api_retry") {
    event.status = "retrying";
    event.error = redactSensitiveText(cleanString(raw.error));
    return;
  }
  if (type === "system" && subtype === "permission_denied") {
    event.status = "denied";
    event.error = redactSensitiveText(cleanString(raw.message));
    return;
  }
  if (type === "system" && subtype.startsWith("task_")) {
    event.status = cleanString(raw.status) || cleanString(objectValue(raw.patch).status) || "running";
    event.text = redactSensitiveText(cleanString(raw.summary) || cleanString(raw.description));
    return;
  }
  if (type === "system" && subtype === "session_state_changed") event.status = cleanString(raw.state);
}

export function providerEventType(raw: Record<string, unknown>): string {
  const type = cleanString(raw.type);
  const subtype = cleanString(raw.subtype);
  if (type === "result") return "result";
  if (type === "assistant") return assistantEventType(objectValue(raw.message));
  if (type === "user" && raw.tool_use_result !== undefined) return "tool_result";
  if (type !== "system") return type === "stream_event" ? "message" : "unknown";
  if (subtype === "init") return "provider.session_started";
  if (subtype === "api_retry") return "provider.retry";
  if (subtype === "permission_denied") return "permission_denied";
  if (subtype === "mirror_error") return "provider.mirror_error";
  if (subtype === "session_state_changed" && cleanString(raw.state) === "requires_action") return "approval_requested";
  if (subtype === "task_started") return "subagent.started";
  if (subtype === "task_progress" || subtype === "task_updated") return "subagent.progress";
  if (subtype === "task_notification") return `subagent.${cleanString(raw.status) || "completed"}`;
  return "unknown";
}

export function assistantEventType(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content) ? message.content.map(objectValue) : [];
  if (blocks.some((block) => cleanString(block.type) === "tool_use")) return "tool_call";
  if (blocks.some((block) => ["tool_result", "tool_use_result"].includes(cleanString(block.type)))) return "tool_result";
  return "message";
}

export function progressMessage(type: string, subtype: string): boolean {
  if (["assistant", "user", "stream_event"].includes(type)) return true;
  return type === "system" && [
    "api_retry", "background_tasks_changed", "files_persisted", "hook_progress", "hook_response", "hook_started",
    "permission_denied", "session_state_changed", "status", "task_notification", "task_progress", "task_started", "task_updated"
  ].includes(subtype);
}

export function nativeMethod(raw: Record<string, unknown>): string {
  const type = cleanString(raw.type) || "unknown";
  const subtype = cleanString(raw.subtype);
  return subtype ? `qoder/${type}/${subtype}` : `qoder/${type}`;
}

export function messageSession(raw: Record<string, unknown>): SessionRef | undefined {
  const sessionId = cleanString(raw.session_id);
  if (!sessionId) return undefined;
  const messageRef = cleanString(raw.type) === "result" ? cleanString(raw.uuid) : "";
  return { provider: PROVIDER, sessionId, ...(messageRef ? { turnId: messageRef } : {}) };
}

export function qoderMetadata(raw: Record<string, unknown>, context: QoderEventContext): Record<string, ProviderMetadataValue> {
  const patch = objectValue(raw.patch);
  return compactMetadata({
    error_code: safeNumber(raw.error_code),
    invocation_ref: context.invocationRef,
    message_ref: cleanString(raw.uuid),
    model: cleanString(raw.model) || cleanString(objectValue(raw.message).model),
    native_subtype: cleanString(raw.subtype),
    native_type: cleanString(raw.type),
    qodercli_version: cleanString(raw.qodercli_version),
    task_id: cleanString(raw.task_id),
    task_status: cleanString(raw.status) || cleanString(patch.status),
    tool_use_id: cleanString(raw.tool_use_id),
    usage_scope: context.resume ? "resume_semantics_unverified" : raw.type === "result" ? "attempt" : ""
  });
}

export function redactedRawSummary(raw: Record<string, unknown>, usageProjection?: QoderUsageProjection): unknown {
  const type = cleanString(raw.type);
  const subtype = cleanString(raw.subtype);
  const summary: Record<string, unknown> = {
    error_code: raw.error_code,
    errors: raw.errors,
    is_error: raw.is_error,
    model: raw.model ?? objectValue(raw.message).model,
    qodercli_version: raw.qodercli_version,
    session_id: raw.session_id,
    status: raw.status ?? raw.state,
    subtype,
    task_id: raw.task_id,
    tool_use_id: raw.tool_use_id,
    type,
    uuid: raw.uuid
  };
  if (type === "assistant") summary.content = contentSummary(objectValue(raw.message).content);
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

export function contentSummary(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const block = objectValue(item);
    return compactObject({
      id: block.id,
      name: block.name,
      text: typeof block.text === "string" ? block.text.slice(0, 1_000) : undefined,
      tool_use_id: block.tool_use_id,
      type: block.type
    });
  });
}

export function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return redactSensitiveText(message.content.map((item) => cleanString(objectValue(item).text)).filter(Boolean).join("\n"));
}

export function resultErrorText(raw: Record<string, unknown>): string {
  const errors = Array.isArray(raw.errors) ? raw.errors.map(cleanString).filter(Boolean) : [];
  return redactSensitiveText(errors.join("; ") || cleanString(raw.result) || cleanString(raw.terminal_reason) || cleanString(raw.subtype));
}

export function compactMetadata(input: Record<string, unknown>): Record<string, ProviderMetadataValue> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.trim() !== "")
  ))) as Record<string, ProviderMetadataValue>;
}

export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

export function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
