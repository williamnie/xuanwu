import { redactSensitiveText } from "../../util/redact.ts";
import type { ImReplyDraftFilter, SQLValue } from "./imReplyOutboxTypes.ts";

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function filterQuery(filter: ImReplyDraftFilter): { args: SQLValue[]; where: string } {
  const conditions: string[] = [];
  const args: SQLValue[] = [];
  addFilter(conditions, args, "source=?", filter.source);
  addFilter(conditions, args, "status=?", filter.status);
  return { args, where: conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "" };
}

export function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function integerRow(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

export function positiveID(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function cleanValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function safeContent(value: unknown): string {
  return redactSensitiveText(cleanValue(value)).trim();
}

export function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

export function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function addFilter(conditions: string[], args: SQLValue[], condition: string, value: unknown): void {
  const text = cleanValue(value);
  if (text === "") return;
  conditions.push(condition);
  args.push(text);
}
