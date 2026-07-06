import type { RunnerDatabase } from "../database.ts";
import type { IntakeRunStatus } from "./intakeRuns.ts";

export type JsonObject = Record<string, unknown>;

export function requiredStringList(value: unknown, label: string): string[] {
  const items = stringList(value);
  if (items.length === 0) throw new Error(`${label} is required`);
  return items;
}

export function stringList(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map(cleanString).filter(Boolean))];
}

export function objectArray(value: unknown): JsonObject[] {
  return (Array.isArray(value) ? value : []).map(objectValue).filter((item) => Object.keys(item).length > 0);
}

export function jsonObject(value: unknown): JsonObject {
  try { return objectValue(JSON.parse(jsonText(value, "{}"))); } catch { return {}; }
}

export function jsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(jsonText(value, "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function runStatus(value: unknown): IntakeRunStatus {
  const status = cleanString(value);
  return status === "succeeded" || status === "failed" ? status : "running";
}

export function confidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is required`);
  return value;
}

export function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

export function requiredString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function jsonText(value: unknown, fallback: string): string {
  const text = cleanString(value);
  return text === "" ? fallback : text;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}
