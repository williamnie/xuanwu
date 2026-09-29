import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readdirSync, readSync, realpathSync } from "node:fs";
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
const READ_CHUNK_BYTES = 8192;
const MAX_EXCERPT_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_EXCERPT_REDACTION_BYTES = 2 * MAX_ALLOWED_BYTES;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 4 * MAX_SEARCH_FILE_BYTES;
const MAX_SEARCH_ENTRIES = 2000;
const SENSITIVE_NAMES = new Set([".env", ".git", ".npmrc", "node_modules", "secrets"]);

type RepoTarget = ReturnType<typeof resolveRepoTarget>;
type ReadBudget = { deadline: number; remaining: number };
type RepoLine = { number: number; oversized: boolean; text: string };
type FileScan = { complete: boolean };
type SearchState = {
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

function excerptSourceLines(lines: string[], excerpt: string, redacted: string): number {
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

function assertReadableFile(target: RepoTarget): void {
  const stat = lstatSync(target.fullPath);
  if (!stat.isFile()) throw new Error("repo path is not a regular file");
  const canonicalRelative = relative(target.rootPath, realpathSync(target.fullPath));
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) throw new Error("repo path is outside project scope");
  assertNotSensitive(canonicalRelative.split(sep).join("/"));
}

// 固定缓冲读取，超长行只报告一次并丢弃内容，避免截断敏感值后再脱敏。
function* scanFileLines(target: RepoTarget, budget: ReadBudget, maxFileBytes: number, scan: FileScan): Generator<RepoLine> {
  assertReadableFile(target);
  const fd = openSync(target.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("repo path is not a regular file");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const line = Buffer.allocUnsafe(MAX_ALLOWED_BYTES);
    let lineBytes = 0;
    let number = 1;
    let oversized = false;
    let bytesRead = 0;
    while (bytesRead < stat.size) {
      if (Date.now() > budget.deadline || budget.remaining <= 0 || bytesRead >= maxFileBytes) return;
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, budget.remaining, maxFileBytes - bytesRead, stat.size - bytesRead), null);
      if (read === 0) break;
      budget.remaining -= read;
      bytesRead += read;
      let offset = 0;
      while (offset < read) {
        if (Date.now() > budget.deadline) return;
        const newline = chunk.subarray(0, read).indexOf(10, offset);
        const end = newline === -1 ? read : newline;
        if (!oversized && lineBytes + end - offset > line.length) {
          oversized = true;
          yield { number, oversized: true, text: "" };
        }
        if (!oversized) {
          chunk.copy(line, lineBytes, offset, end);
          lineBytes += end - offset;
        }
        if (newline === -1) break;
        if (!oversized) {
          const length = lineBytes > 0 && line[lineBytes - 1] === 13 ? lineBytes - 1 : lineBytes;
          yield { number, oversized: false, text: line.toString("utf8", 0, length) };
        }
        number += 1;
        lineBytes = 0;
        oversized = false;
        offset = newline + 1;
      }
    }
    if (!oversized) yield { number, oversized: false, text: line.toString("utf8", 0, lineBytes) };
    scan.complete = true;
  } finally {
    closeSync(fd);
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.toString("utf8", 0, end);
}

function searchTarget(
  target: RepoTarget,
  query: string,
  state: SearchState
): void {
  if (searchHalted(state)) return;
  const stat = lstatSync(target.fullPath);
  if (stat.isDirectory()) return searchDirectory(target, query, state);
  if (!stat.isFile()) return state.skipped.push({ path: target.relativePath, reason: "unsupported file type" }) as never;
  searchFile(target, query, state);
}

function searchDirectory(
  target: RepoTarget,
  query: string,
  state: SearchState
): void {
  const entries: string[] = [];
  const directory = opendirSync(target.fullPath);
  try {
    while (!searchHalted(state)) {
      const entry = directory.readSync();
      if (!entry) break;
      if (state.entriesRemaining <= 0) { state.truncated = true; break; }
      state.entriesRemaining -= 1;
      entries.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (searchHalted(state)) return;
    const childPath = childRelativePath(target.relativePath, entry);
    if (sensitivePath(childPath)) {
      state.skipped.push({ path: childPath, reason: "sensitive path skipped" });
      continue;
    }
    searchTarget({ fullPath: resolve(target.fullPath, entry), relativePath: childPath, rootPath: target.rootPath }, query, state);
  }
}

function searchFile(
  target: RepoTarget,
  query: string,
  state: SearchState
): void {
  const scan = { complete: false };
  let skippedLongLine = false;
  for (const line of scanFileLines(target, state.budget, MAX_SEARCH_FILE_BYTES, scan)) {
    if (line.oversized) { skippedLongLine = true; continue; }
    if (!line.text.includes(query)) continue;
    const redacted = redactSensitiveText(line.text);
    // 保留匹配位置附近上下文，长行命中不应被输出预算切掉。
    let excerptStart = Math.max(0, redacted.indexOf(query) - 200);
    if (excerptStart > 0 && /[\uDC00-\uDFFF]/.test(redacted[excerptStart]!)) excerptStart -= 1;
    const excerpt = utf8Prefix(redacted.slice(excerptStart), DEFAULT_MAX_BYTES);
    state.truncated ||= excerpt !== redacted;
    state.results.push({
      excerpt,
      line_range: { end: line.number, start: line.number },
      matched_text: excerpt,
      path: target.relativePath,
      reason: "query_match",
      source: "repo_search",
      truncated: excerpt !== redacted
    });
    if (state.results.length >= state.limit) { state.halted = true; return truncate(state); }
  }
  if (!scan.complete || skippedLongLine) {
    state.truncated = true;
    state.skipped.push({ path: target.relativePath, reason: !scan.complete ? "file read budget exceeded" : "line read budget exceeded" });
  }
}

function searchHalted(state: SearchState): boolean {
  if (state.halted || state.budget.remaining <= 0 || Date.now() > state.budget.deadline) {
    state.halted = true;
    state.truncated = true;
  }
  return state.halted;
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
