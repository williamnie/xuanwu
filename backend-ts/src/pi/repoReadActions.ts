import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Project } from "../db/repositories/projects.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type RepoReadExcerptInput = { max_bytes?: number; max_lines?: number; path: string; start_line?: number };
export type RepoSearchInput = { max_results?: number; path?: string; query: string };
export type RepoTreeInput = { max_depth?: number; max_entries?: number; path?: string };

const DEFAULT_MAX_BYTES = 4096;
const MAX_ALLOWED_BYTES = 65536;
const DEFAULT_MAX_LINES = 40;
const MAX_ALLOWED_LINES = 80;
const DEFAULT_MAX_RESULTS = 20;
const MAX_ALLOWED_RESULTS = 50;
const DEFAULT_TREE_DEPTH = 2;
const MAX_TREE_DEPTH = 4;
const DEFAULT_TREE_ENTRIES = 100;
const MAX_TREE_ENTRIES = 200;
const SEARCH_TIMEOUT_MS = 250;
const SENSITIVE_NAMES = new Set([".env", ".git", ".npmrc", "node_modules", "secrets"]);

export function readRepoExcerpt(project: Project, input: RepoReadExcerptInput) {
  const target = resolveRepoTarget(project.cwd, input.path);
  assertReadableFile(target, byteLimit(input.max_bytes));
  const lines = readFileSync(target.fullPath, "utf8").split(/\r?\n/);
  const start = boundedInteger(input.start_line, 1, Math.max(1, lines.length), 1);
  const maxLines = boundedInteger(input.max_lines, 1, MAX_ALLOWED_LINES, DEFAULT_MAX_LINES);
  const selected = lines.slice(start - 1, start - 1 + maxLines);
  return {
    excerpt: redactSensitiveText(selected.join("\n")),
    line_range: { end: start + selected.length - 1, start },
    path: target.relativePath,
    reason: "requested_excerpt",
    source: "repo_read_excerpt",
    truncated: start - 1 + maxLines < lines.length
  };
}

export function searchRepo(project: Project, input: RepoSearchInput) {
  const query = cleanQuery(input.query);
  const base = resolveRepoTarget(project.cwd, input.path || ".");
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const state = {
    limit: boundedInteger(input.max_results, 1, MAX_ALLOWED_RESULTS, DEFAULT_MAX_RESULTS),
    results: [] as unknown[],
    skipped: [] as Array<{ path: string; reason: string }>,
    truncated: false
  };
  searchTarget(base, query, state, deadline);
  return { query, results: state.results, skipped: state.skipped, source: "repo_search", truncated: state.truncated };
}

export function readRepoTree(project: Project, input: RepoTreeInput = {}) {
  const root = resolveRepoTarget(project.cwd, input.path || ".");
  const state = {
    entries: 0,
    items: [] as unknown[],
    limit: boundedInteger(input.max_entries, 1, MAX_TREE_ENTRIES, DEFAULT_TREE_ENTRIES),
    maxDepth: boundedInteger(input.max_depth, 0, MAX_TREE_DEPTH, DEFAULT_TREE_DEPTH),
    skipped: [] as Array<{ path: string; reason: string }>,
    truncated: false
  };
  walkTree(root, state, 0);
  return { items: state.items, skipped: state.skipped, source: "repo_tree", truncated: state.truncated };
}

export function summarizeRepoToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return { type: typeof result };
  const raw = result as Record<string, unknown>;
  if (Array.isArray(raw.results)) return summary(raw, "results");
  if (Array.isArray(raw.items)) return summary(raw, "items");
  return {
    line_range: raw.line_range,
    path: raw.path,
    source: raw.source,
    truncated: raw.truncated
  };
}

function resolveRepoTarget(root: string, requestedPath: string) {
  const rootPath = realpathSync(root);
  const cleanPath = cleanRelativePath(requestedPath);
  const fullPath = resolve(rootPath, cleanPath);
  const rel = relative(rootPath, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("repo path is outside project scope");
  const relativePath = rel === "" ? "." : rel.split(sep).join("/");
  assertNotSensitive(relativePath);
  return { fullPath, relativePath, rootPath };
}

function cleanRelativePath(value: string): string {
  const text = cleanString(value) || ".";
  if (text.includes("\0")) throw new Error("repo path contains invalid characters");
  if (isAbsolute(text)) throw new Error("absolute repo paths are not allowed");
  const segments = text.split(/[\\/]+/).filter(Boolean);
  if (segments.includes("..")) throw new Error("repo path is outside project scope");
  return segments.join(sep) || ".";
}

function assertReadableFile(target: ReturnType<typeof resolveRepoTarget>, maxBytes: number): void {
  const stat = lstatSync(target.fullPath);
  if (!stat.isFile()) throw new Error("repo path is not a regular file");
  if (stat.size > maxBytes) throw new Error(`repo file exceeds max read bytes (${maxBytes})`);
}

function searchTarget(
  target: ReturnType<typeof resolveRepoTarget>,
  query: string,
  state: { limit: number; results: unknown[]; skipped: Array<{ path: string; reason: string }>; truncated: boolean },
  deadline: number
): void {
  if (state.truncated || Date.now() > deadline) return truncate(state);
  const stat = lstatSync(target.fullPath);
  if (stat.isDirectory()) return searchDirectory(target, query, state, deadline);
  if (!stat.isFile()) return state.skipped.push({ path: target.relativePath, reason: "unsupported file type" }) as never;
  if (stat.size > DEFAULT_MAX_BYTES) {
    state.skipped.push({ path: target.relativePath, reason: "file exceeds max read bytes" });
    return;
  }
  searchFile(target, query, state);
}

function searchDirectory(
  target: ReturnType<typeof resolveRepoTarget>,
  query: string,
  state: { limit: number; results: unknown[]; skipped: Array<{ path: string; reason: string }>; truncated: boolean },
  deadline: number
): void {
  for (const entry of sortedEntries(target.fullPath)) {
    if (state.truncated || Date.now() > deadline) return truncate(state);
    const childPath = childRelativePath(target.relativePath, entry);
    if (sensitivePath(childPath)) {
      state.skipped.push({ path: childPath, reason: "sensitive path skipped" });
      continue;
    }
    searchTarget({ fullPath: resolve(target.fullPath, entry), relativePath: childPath, rootPath: target.rootPath }, query, state, deadline);
  }
}

function searchFile(
  target: ReturnType<typeof resolveRepoTarget>,
  query: string,
  state: { limit: number; results: unknown[]; skipped: Array<{ path: string; reason: string }>; truncated: boolean }
): void {
  const lines = readFileSync(target.fullPath, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.includes(query)) continue;
    state.results.push({
      excerpt: redactSensitiveText(line),
      line_range: { end: index + 1, start: index + 1 },
      matched_text: redactSensitiveText(line),
      path: target.relativePath,
      reason: "query_match",
      source: "repo_search"
    });
    if (state.results.length >= state.limit) return truncate(state);
  }
}

function walkTree(target: ReturnType<typeof resolveRepoTarget>, state: {
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

function assertNotSensitive(path: string): void {
  if (sensitivePath(path)) throw new Error(`sensitive repo path is blocked: ${path}`);
}

function sensitivePath(path: string): boolean {
  return path.split("/").some((segment) => (
    SENSITIVE_NAMES.has(segment) ||
    segment.startsWith(".env") ||
    /token|secret|password|credential/i.test(segment)
  ));
}

function sortedEntries(path: string): string[] {
  return readdirSync(path).sort((a, b) => a.localeCompare(b));
}

function childRelativePath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function summary(raw: Record<string, unknown>, key: "items" | "results") {
  const rows = (raw[key] as Array<Record<string, unknown>>).slice(0, 10);
  return {
    paths: rows.map((row) => row.path).filter(Boolean),
    result_count: (raw[key] as unknown[]).length,
    skipped_count: Array.isArray(raw.skipped) ? raw.skipped.length : 0,
    source: raw.source,
    truncated: raw.truncated
  };
}

function byteLimit(value: unknown): number {
  return boundedInteger(value, 1, MAX_ALLOWED_BYTES, DEFAULT_MAX_BYTES);
}

function cleanQuery(value: unknown): string {
  const text = cleanString(value);
  if (text.length === 0) throw new Error("repo search query is required");
  return text.slice(0, 120);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function truncate(state: { truncated: boolean }): void {
  state.truncated = true;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
