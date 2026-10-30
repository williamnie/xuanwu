import { DEFAULT_LIMIT } from "./issueWatchdog.model.ts";

export function hash(value: string): string {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return (output >>> 0).toString(36);
}

export function nextCheck(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString();
}

export function cutoffISO(now: Date, staleAfterMs: number): string {
  return new Date(now.getTime() - staleAfterMs).toISOString();
}

export function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

export function boundedLimit(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : DEFAULT_LIMIT, 1), DEFAULT_LIMIT);
}
