import type { RunnerConcurrencyConfig } from "./env.types.ts";
import { cleanValue } from "./env.values.ts";

export const DEFAULT_MAX_PARALLEL_PROJECTS = 1;

export const MAX_PARALLEL_PROJECTS_LIMIT = 8;

export function buildRunnerConcurrencyConfig(input: { maxParallelProjects?: unknown } = {}): RunnerConcurrencyConfig {
  return {
    maxParallelProjects: normalizeMaxParallelProjects(input.maxParallelProjects, DEFAULT_MAX_PARALLEL_PROJECTS)
  };
}

export function normalizeMaxParallelProjects(value: unknown, fallback: number): number {
  const parsed = parsePositiveIntegerValue(value);
  if (parsed === undefined) return fallback;
  return Math.min(parsed, MAX_PARALLEL_PROJECTS_LIMIT);
}

export function parsePositiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = cleanValue(typeof value === "string" ? value : undefined);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
