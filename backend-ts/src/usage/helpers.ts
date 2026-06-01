import type { RateLimits, LimitWindow, TokenEvent, TokenUsage } from "./types.ts";

export function tokenUsage(value: Partial<TokenUsage> | undefined): TokenUsage {
  return {
    cached_input_tokens: numeric(value?.cached_input_tokens),
    input_tokens: numeric(value?.input_tokens),
    output_tokens: numeric(value?.output_tokens),
    reasoning_output_tokens: numeric(value?.reasoning_output_tokens),
    total_tokens: numeric(value?.total_tokens)
  };
}

export function zeroUsage(): TokenUsage {
  return tokenUsage(undefined);
}

export function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.cached_input_tokens += usage.cached_input_tokens;
  target.input_tokens += usage.input_tokens;
  target.output_tokens += usage.output_tokens;
  target.reasoning_output_tokens += usage.reasoning_output_tokens;
  target.total_tokens += usage.total_tokens;
}

export function normalizeRateLimits(value: RateLimits): RateLimits {
  const copy = { ...value };
  copy.primary = normalizeWindow(copy.primary ?? null);
  copy.secondary = normalizeWindow(copy.secondary ?? null);
  return copy;
}

export function timestamp(event: TokenEvent): Date {
  const date = new Date(event.timestamp ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function timestampMs(event: TokenEvent): number {
  return timestamp(event).getTime();
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function isoWeekKey(date: Date): string {
  const probe = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  probe.setDate(probe.getDate() + 4 - (probe.getDay() || 7));
  const yearStart = new Date(probe.getFullYear(), 0, 1);
  const week = Math.ceil((((probe.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${probe.getFullYear()}-W${pad(week)}`;
}

export function parseJSON(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

export function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWindow(window: LimitWindow | null): LimitWindow | null {
  if (!window) return null;
  const used = numeric(window.used_percent);
  return {
    ...window,
    remaining_percent: Math.max(0, 100 - used),
    ...(numeric(window.resets_at) > 0 ? { resets_at_iso: new Date(numeric(window.resets_at) * 1000).toISOString() } : {})
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
