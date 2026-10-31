import type { ProviderEvent } from "../providers/types.ts";
import { objectValue } from "../util/values.ts";
import { CHUNK_METHODS } from "./issueLogPersistence.model.ts";

export function rawObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return objectValue(value);
}

export function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function boundedUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= byteLimit) return value;
  let end = Math.max(0, byteLimit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function chunkKey(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  if (!CHUNK_METHODS.has(method) || typeof event.text !== "string") return "";
  return JSON.stringify([
    event.provider,
    event.type,
    method,
    event.session?.sessionId ?? "",
    event.session?.turnId ?? "",
    event.command ?? "",
    event.path ?? ""
  ]);
}

export function sampleKey(event: ProviderEvent): string {
  return JSON.stringify([
    event.provider,
    event.raw?.method ?? "",
    event.session?.sessionId ?? "",
    event.session?.turnId ?? ""
  ]);
}

export function eventFingerprint(event: ProviderEvent): string {
  return JSON.stringify([
    event.type,
    event.raw?.method ?? "",
    event.raw?.payload ?? null,
    event.payload ?? null,
    event.text ?? "",
    event.status ?? "",
    event.error ?? ""
  ]);
}

export function isTerminalEvent(event: ProviderEvent): boolean {
  const method = event.raw?.method ?? "";
  return event.type === "done" || event.type === "error" ||
    method === "turn/completed" || method === "error" || method === "protocol/error";
}
