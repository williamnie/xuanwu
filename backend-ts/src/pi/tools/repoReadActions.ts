import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Project } from "../../db/repositories/projects.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString } from "../../util/values.ts";
import { scanFileLines, utf8Prefix, searchTarget } from "./repoReadScanning.ts";
import { byteLimit, boundedInteger, cleanQuery, walkTree, summary, assertNotSensitive } from "./repoReadPaths.ts";

export type RepoReadExcerptInput = { max_bytes?: number; max_lines?: number; path: string; start_line?: number };

export type RepoSearchInput = { max_results?: number; path?: string; query: string };

export type RepoTreeInput = { max_depth?: number; max_entries?: number; path?: string };

export const DEFAULT_MAX_BYTES = 4096;

export const MAX_ALLOWED_BYTES = 65536;

export const DEFAULT_MAX_LINES = 40;

export const MAX_ALLOWED_LINES = 80;

export const DEFAULT_MAX_RESULTS = 20;

export const MAX_ALLOWED_RESULTS = 50;

export const DEFAULT_TREE_DEPTH = 2;

export const MAX_TREE_DEPTH = 4;

export const DEFAULT_TREE_ENTRIES = 100;

export const MAX_TREE_ENTRIES = 200;

export const SEARCH_TIMEOUT_MS = 250;

export const READ_CHUNK_BYTES = 8192;

export const MAX_EXCERPT_SCAN_BYTES = 8 * 1024 * 1024;

export const MAX_EXCERPT_REDACTION_BYTES = 2 * MAX_ALLOWED_BYTES;

export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

export const MAX_SEARCH_TOTAL_BYTES = 4 * MAX_SEARCH_FILE_BYTES;

export const MAX_SEARCH_ENTRIES = 2000;

export const SENSITIVE_NAMES = new Set([".env", ".git", ".npmrc", "node_modules", "secrets"]);

export type RepoTarget = ReturnType<typeof resolveRepoTarget>;

export type ReadBudget = { deadline: number; remaining: number };

export type RepoLine = { number: number; oversized: boolean; text: string };

export type FileScan = { complete: boolean };

export type SearchState = {
  budget: ReadBudget; entriesRemaining: number; halted: boolean; limit: number;
  results: unknown[]; skipped: Array<{ path: string; reason: string }>; truncated: boolean;
};

export function readRepoExcerpt(project: Project, input: RepoReadExcerptInput) {
  const target = resolveRepoTarget(project.cwd, input.path);
  const maxBytes = byteLimit(input.max_bytes);
  let start = boundedInteger(input.start_line, 1, Number.MAX_SAFE_INTEGER, 1);
  const maxLines = boundedInteger(input.max_lines, 1, MAX_ALLOWED_LINES, DEFAULT_MAX_LINES);
  const budget = { deadline: Date.now() + SEARCH_TIMEOUT_MS, remaining: MAX_EXCERPT_SCAN_BYTES };
  const scan = { complete: false };
  const selected: string[] = [];
  let selectedBytes = 0;
  let last: RepoLine | undefined;
  let truncated = false;
  let windowComplete = false;
  let omitted = "";
  for (const line of scanFileLines(target, budget, MAX_EXCERPT_SCAN_BYTES, scan)) {
    last = line;
    if (line.number < start) continue;
    if (selected.length >= maxLines) { truncated = true; break; }
    if (line.oversized) { omitted = "[line exceeds read budget]"; break; }
    const nextBytes = selectedBytes + Buffer.byteLength(line.text) + (selected.length > 0 ? 1 : 0);
    if (nextBytes > MAX_EXCERPT_REDACTION_BYTES) { omitted = "[excerpt exceeds read budget]"; break; }
    selected.push(line.text);
    selectedBytes = nextBytes;
    windowComplete = selected.length === maxLines;
  }
  // 保留请求超出 EOF 时返回最后一行的既有行为；预算耗尽不冒充 EOF。
  if (selected.length === 0 && last && scan.complete) {
    start = last.number;
    if (last.oversized) omitted = "[line exceeds read budget]";
    else selected.push(last.text);
  }
  windowComplete ||= scan.complete;
  // 输出预算不能提前切断跨行脱敏窗口；读取预算不足时不返回可能包含秘密前缀的残片。
  if (!windowComplete && !omitted && selected.length > 0) omitted = "[excerpt exceeds read budget]";
  const redacted = omitted || redactSensitiveText(selected.join("\n"));
  const excerpt = utf8Prefix(redacted, maxBytes);
  const sourceLines = omitted ? Math.max(1, (last?.number ?? start) - start + 1) : excerptSourceLines(selected, excerpt, redacted);
  return {
    excerpt,
    line_range: { end: start + sourceLines - 1, start },
    path: target.relativePath,
    reason: "requested_excerpt",
    source: "repo_read_excerpt",
    truncated: truncated || !scan.complete || Boolean(omitted) || excerpt !== redacted
  };
}

export function excerptSourceLines(lines: string[], excerpt: string, redacted: string): number {
  if (excerpt === "" && redacted !== "") return 0;
  // 反查覆盖输出前缀的最短原始行窗口，保留跨行敏感值被压成一行时的源行号。
  for (let count = 1; count <= lines.length; count += 1) {
    if (redactSensitiveText(lines.slice(0, count).join("\n")).startsWith(excerpt)) return count;
  }
  return lines.length;
}

export function searchRepo(project: Project, input: RepoSearchInput) {
  const query = cleanQuery(input.query);
  const base = resolveRepoTarget(project.cwd, input.path || ".");
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const state: SearchState = {
    budget: { deadline, remaining: MAX_SEARCH_TOTAL_BYTES },
    entriesRemaining: MAX_SEARCH_ENTRIES,
    halted: false,
    limit: boundedInteger(input.max_results, 1, MAX_ALLOWED_RESULTS, DEFAULT_MAX_RESULTS),
    results: [] as unknown[],
    skipped: [] as Array<{ path: string; reason: string }>,
    truncated: false
  };
  searchTarget(base, query, state);
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

export function resolveRepoTarget(root: string, requestedPath: string) {
  const rootPath = realpathSync(root);
  const cleanPath = cleanRelativePath(requestedPath);
  const fullPath = resolve(rootPath, cleanPath);
  const rel = relative(rootPath, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("repo path is outside project scope");
  const relativePath = rel === "" ? "." : rel.split(sep).join("/");
  assertNotSensitive(relativePath);
  return { fullPath, relativePath, rootPath };
}

export function cleanRelativePath(value: string): string {
  const text = cleanString(value) || ".";
  if (text.includes("\0")) throw new Error("repo path contains invalid characters");
  if (isAbsolute(text)) throw new Error("absolute repo paths are not allowed");
  const segments = text.split(/[\\/]+/).filter(Boolean);
  if (segments.includes("..")) throw new Error("repo path is outside project scope");
  return segments.join(sep) || ".";
}

export function assertReadableFile(target: RepoTarget): void {
  const stat = lstatSync(target.fullPath);
  if (!stat.isFile()) throw new Error("repo path is not a regular file");
  const canonicalRelative = relative(target.rootPath, realpathSync(target.fullPath));
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) throw new Error("repo path is outside project scope");
  assertNotSensitive(canonicalRelative.split(sep).join("/"));
}
