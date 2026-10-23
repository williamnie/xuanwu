import { createHash } from "node:crypto";

/** Total coercions for loosely-typed input (request bodies, JSON payloads, SQLite rows). */

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ISO-8601 timestamp truncated to whole seconds. */
export function isoSeconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
