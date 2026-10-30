import type { ProviderRuntimeConfig } from "./env.types.ts";

export function cleanValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;

export function buildProviderRuntimeConfig(input: {
  command?: string;
  cwd?: string;
  defaultCommand: string;
  env?: string;
  timeoutMs?: number | string;
}): ProviderRuntimeConfig {
  return {
    command: cleanValue(input.command) ?? input.defaultCommand,
    cwd: cleanValue(input.cwd) ?? "",
    env: parseEnvOverrides(cleanValue(input.env) ?? ""),
    timeoutMs: parsePositiveInteger(input.timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS)
  };
}

export function parseEnvOverrides(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const item of value.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === "") continue;
    env[key] = item.slice(separator + 1).trim();
  }
  return env;
}

export function parsePositiveInteger(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = cleanValue(typeof value === "string" ? value : undefined);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = cleanValue(value)?.toLowerCase();
  if (text === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}
