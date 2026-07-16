import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent, providerEventSourceRef, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { NormalizedRunEvent, ProviderEvent, SessionRef } from "../types.ts";

export type CodexWireNotification = { method: string; params?: unknown };

export function normalizeCodexEvent(notification: CodexWireNotification): ProviderEvent {
  const method = notification.method.trim();
  const payload = redactPayload(notification.params);
  const raw = recordValue(payload);
  const event: ProviderEvent = {
    provider: "codex",
    type: eventType(method, raw),
    raw: { method, payload: stableJSON(payload) }
  };
  const session = sessionRef(raw);
  if (session) event.session = session;
  applyFields(event, method, raw);
  event.runEvent = normalizedCodexRunEvent(method, raw, event);
  if (event.type === "raw") event.payload = rawSummary(method, payload);
  return event;
}

function normalizedCodexRunEvent(
  method: string,
  raw: Record<string, unknown>,
  event: ProviderEvent
): NormalizedRunEvent {
  if (method === "turn/started") {
    return normalizedRunEvent({ kind: "started", method, outcome: "running", provider: "codex", session: event.session });
  }
  if (method === "turn/completed") return codexCompletionRunEvent(method, event);
  if (["approval/resolved", "approval/fast_resolved"].includes(method)) {
    return normalizedRunEvent({ kind: "approval_resolved", method, outcome: "running", provider: "codex", session: event.session });
  }
  if (method === "approval/requested") {
    return normalizedRunEvent({ kind: "approval_requested", method, outcome: "waiting_approval", provider: "codex", session: event.session });
  }
  if (["error", "protocol/error", "process/stderr"].includes(method)) {
    return normalizedRunEvent({
      kind: "error",
      method,
      outcome: "failed",
      provider: "codex",
      retryable: raw["willRetry"] === true,
      session: event.session
    });
  }
  if (method === "thread/status/changed" && terminalThreadStatus(event.status)) {
    return normalizedRunEvent({ kind: "error", method, outcome: "failed", provider: "codex", session: event.session });
  }
  if (method === "thread/tokenUsage/updated") return codexUsageRunEvent(method, raw, event.session);
  if (progressMethod(method)) {
    return normalizedRunEvent({ kind: "progress", method, outcome: "running", provider: "codex", session: event.session });
  }
  return unknownRunEvent("codex", method, event.session);
}

function codexCompletionRunEvent(method: string, event: ProviderEvent): NormalizedRunEvent {
  const status = (event.status ?? "").trim().toLowerCase();
  if (["completed", "succeeded", "success"].includes(status)) {
    return normalizedRunEvent({ kind: "completed", method, outcome: "succeeded", provider: "codex", session: event.session });
  }
  const outcome = status === "cancelled" || status === "canceled"
    ? "cancelled"
    : status === "interrupted" ? "interrupted" : "failed";
  return normalizedRunEvent({ kind: "error", method, outcome, provider: "codex", session: event.session });
}

function codexUsageRunEvent(method: string, raw: Record<string, unknown>, session?: SessionRef): NormalizedRunEvent {
  const tokenUsage = recordField(raw, "tokenUsage");
  const total = recordField(tokenUsage, "total");
  const sourceRef = providerEventSourceRef("codex", method, session);
  const cost = providerRunCost({
    sourceRef,
    usage: {
      cached_input_tokens: numericField(total, "cachedInputTokens"),
      input_tokens: numericField(total, "inputTokens"),
      output_tokens: numericField(total, "outputTokens"),
      reasoning_output_tokens: numericField(total, "reasoningOutputTokens"),
      total_tokens: numericField(total, "totalTokens")
    }
  });
  return normalizedRunEvent({
    ...(cost ? { cost } : {}),
    kind: "progress",
    metadata: {
      model_context_window: numericField(tokenUsage, "modelContextWindow"),
      usage_scope: "provider_session_total"
    },
    method,
    outcome: "running",
    provider: "codex",
    session
  });
}

function progressMethod(method: string): boolean {
  return CODEX_PROGRESS_METHODS.has(method);
}

const CODEX_PROGRESS_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/started",
  "item/completed",
  "thread/status/changed",
  "turn/diff/updated",
  "turn/plan/updated",
  "turn/taskProgress/updated"
]);

function terminalThreadStatus(status: string | undefined): boolean {
  return ["systemerror", "failed", "error"].includes((status ?? "").trim().toLowerCase());
}

function applyFields(event: ProviderEvent, method: string, raw: Record<string, unknown>): void {
  switch (method) {
    case "item/agentMessage/delta":
      event.text = stringField(raw, "delta");
      return;
    case "item/commandExecution/outputDelta":
      event.text = stringField(raw, "delta");
      event.command = commandFromPayload(raw);
      return;
    case "item/fileChange/outputDelta":
      event.text = stringField(raw, "delta");
      event.path = pathFromPayload(raw);
      return;
    case "item/fileChange/patchUpdated":
      event.text = patchText(raw);
      event.path = pathFromPayload(raw);
      return;
    case "item/started":
    case "item/completed":
      applyItemLifecycleFields(event, method, raw);
      return;
    case "turn/started":
      event.status = "inProgress";
      return;
    case "turn/completed":
      applyTurnCompletedFields(event, raw);
      return;
    case "thread/status/changed":
      event.status = threadLifecycleStatus(raw);
      return;
    case "error":
    case "protocol/error":
    case "process/stderr":
      event.status = "failed";
      event.error = errorMessage(raw) || stringField(raw, "error") || stringField(raw, "message");
      return;
  }
}

function eventType(method: string, raw: Record<string, unknown>): ProviderEvent["type"] {
  switch (method) {
    case "item/agentMessage/delta":
      return "text";
    case "item/commandExecution/outputDelta":
      return "tool";
    case "item/started":
    case "item/completed":
      return itemType(raw);
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
      return "tool";
    case "turn/started":
      return "text";
    case "turn/completed":
      return "done";
    case "error":
    case "protocol/error":
    case "process/stderr":
      return "error";
    default:
      return "raw";
  }
}

function itemType(raw: Record<string, unknown>): ProviderEvent["type"] {
  const item = recordField(raw, "item");
  const kind = stringField(item, "type");
  return kind === "commandExecution" || kind === "fileChange" ? "tool" : "raw";
}

function applyItemLifecycleFields(event: ProviderEvent, method: string, raw: Record<string, unknown>): void {
  const item = recordField(raw, "item");
  switch (stringField(item, "type")) {
    case "commandExecution":
      event.command = stringField(item, "command");
      event.status = stringField(item, "status");
      event.text = commandLifecycleText(method, item);
      return;
    case "fileChange":
      event.path = pathFromPayload(item);
      event.status = stringField(item, "status");
      event.text = method === "item/completed" ? patchText(item) : "";
      return;
  }
}


function threadLifecycleStatus(raw: Record<string, unknown>): string {
  const status = recordField(raw, "status");
  return stringField(status, "type") || stringField(raw, "status");
}

function applyTurnCompletedFields(event: ProviderEvent, raw: Record<string, unknown>): void {
  const turn = recordField(raw, "turn");
  event.status = stringField(turn, "status") || "failed";
  if (event.status !== "completed") event.error = errorMessage(turn) || "missing turn payload";
  if (event.session?.turnId === undefined) {
    const turnID = stringField(turn, "id");
    if (turnID !== "") event.session = { ...(event.session ?? { provider: "codex", sessionId: stringField(raw, "threadId") }), turnId: turnID };
  }
}

function commandLifecycleText(method: string, item: Record<string, unknown>): string {
  const command = stringField(item, "command");
  if (command === "") return "";
  if (method === "item/started") return `$ ${command}`;
  const status = stringField(item, "status");
  return status !== "" && status !== "completed" ? `! command ${status}: ${command}` : "";
}

function patchText(raw: Record<string, unknown>): string {
  return arrayField(raw, "changes").map((item) => {
    const change = recordValue(item);
    const path = stringField(change, "path");
    const diff = stringField(change, "diff");
    return path || diff ? `--- ${path}\n${diff}\n` : "";
  }).join("");
}

function commandFromPayload(raw: Record<string, unknown>): string {
  return stringField(raw, "command") || stringField(recordField(raw, "item"), "command");
}

function pathFromPayload(raw: Record<string, unknown>): string {
  const direct = stringField(raw, "path");
  if (direct !== "") return direct;
  const itemPath = stringField(recordField(raw, "item"), "path");
  if (itemPath !== "") return itemPath;
  const firstChange = recordValue(arrayField(raw, "changes")[0]);
  return stringField(firstChange, "path");
}

function errorMessage(raw: Record<string, unknown>): string {
  const error = recordField(raw, "error");
  const message = stringField(error, "message");
  const detail = stringField(error, "additionalDetails");
  return `${message} ${detail}`.trim();
}

function sessionRef(raw: Record<string, unknown>): SessionRef | undefined {
  const sessionId = stringField(raw, "threadId");
  const turnId = stringField(raw, "turnId") || stringField(recordField(raw, "turn"), "id");
  if (sessionId === "" && turnId === "") return undefined;
  return { provider: "codex", sessionId, ...(turnId === "" ? {} : { turnId }) };
}

function redactPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) return value;
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, isSensitiveKey(key) ? "[redacted]" : redactPayload(item)]));
}

function isSensitiveKey(key: string): boolean {
  if (SAFE_USAGE_KEYS.has(key)) return false;
  return /(?:token|secret|password|api[_-]?key|access[_-]?key)/i.test(key);
}

const SAFE_USAGE_KEYS = new Set([
  "tokenUsage",
  "cachedInputTokens",
  "inputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "modelContextWindow"
]);

function rawSummary(method: string, payload: unknown): string {
  const body = stableJSON(payload);
  return body.length > 240 ? `${method} ${body.slice(0, 237)}...` : `${method} ${body}`.trim();
}

function stableJSON(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function recordField(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  return recordValue(raw[key]);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayField(raw: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(raw[key]) ? raw[key] as unknown[] : [];
}

function stringField(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? raw[key].trim() : "";
}

function numericField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
