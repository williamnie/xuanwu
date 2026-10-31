import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { cleanString } from "../../util/values.ts";
import { resolveRepoTarget, SENSITIVE_NAMES, MAX_ALLOWED_BYTES, DEFAULT_MAX_BYTES } from "./repoReadActions.ts";

export function walkTree(target: ReturnType<typeof resolveRepoTarget>, state: {
  entries: number; items: unknown[]; limit: number; maxDepth: number; skipped: Array<{ path: string; reason: string }>; truncated: boolean;
}, depth: number): void {
  if (state.truncated || depth > state.maxDepth) return;
  const stat = lstatSync(target.fullPath);
  state.items.push({ path: target.relativePath, reason: "directory_entry", source: "repo_tree", type: stat.isDirectory() ? "directory" : "file" });
  state.entries += 1;
  if (!stat.isDirectory() || depth === state.maxDepth) return;
  for (const entry of sortedEntries(target.fullPath)) {
    if (state.entries >= state.limit) return truncate(state);
    const childPath = childRelativePath(target.relativePath, entry);
    if (sensitivePath(childPath)) {
      state.skipped.push({ path: childPath, reason: "sensitive path skipped" });
      continue;
    }
    walkTree({ fullPath: resolve(target.fullPath, entry), relativePath: childPath, rootPath: target.rootPath }, state, depth + 1);
  }
}

export function assertNotSensitive(path: string): void {
  if (sensitivePath(path)) throw new Error(`sensitive repo path is blocked: ${path}`);
}

export function sensitivePath(path: string): boolean {
  return path.split("/").some((segment) => (
    SENSITIVE_NAMES.has(segment) ||
    segment.startsWith(".env") ||
    /token|secret|password|credential/i.test(segment)
  ));
}

export function sortedEntries(path: string): string[] {
  return readdirSync(path).sort((a, b) => a.localeCompare(b));
}

export function childRelativePath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

export function summary(raw: Record<string, unknown>, key: "items" | "results") {
  const rows = (raw[key] as Array<Record<string, unknown>>).slice(0, 10);
  return {
    paths: rows.map((row) => row.path).filter(Boolean),
    result_count: (raw[key] as unknown[]).length,
    skipped_count: Array.isArray(raw.skipped) ? raw.skipped.length : 0,
    source: raw.source,
    truncated: raw.truncated
  };
}

export function byteLimit(value: unknown): number {
  return boundedInteger(value, 1, MAX_ALLOWED_BYTES, DEFAULT_MAX_BYTES);
}

export function cleanQuery(value: unknown): string {
  const text = cleanString(value);
  if (text.length === 0) throw new Error("repo search query is required");
  return text.slice(0, 120);
}

export function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function truncate(state: { truncated: boolean }): void {
  state.truncated = true;
}
