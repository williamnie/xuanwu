import { redactSensitiveText } from "../../util/redact.ts";
import type { ProviderEvent, SessionRef } from "../types.ts";

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
  if (event.type === "raw") event.payload = rawSummary(method, payload);
  return event;
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
  return /(?:token|secret|password|api[_-]?key|access[_-]?key)/i.test(key);
}

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
