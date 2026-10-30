import { arrayValue, cleanString, stringList } from "../util/values.ts";
import type { JsonObject } from "./runtime.model.ts";

export function inputEvidenceRefs(input: Readonly<JsonObject>): string[] {
  const item = recordValue(input.inbox_item);
  if (Object.keys(item).length > 0) return stringList(item.evidence_refs);
  const bundle = recordValue(input.context_bundle);
  return stringList(bundle.evidence_refs);
}

export function actionCount(output: unknown): number {
  return arrayValue(recordValue(output).action_proposals).length;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function recordValue(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function safeID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

export function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}
