import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { redactSensitiveText } from "../../util/redact.ts";
import { RepoTarget, ReadBudget, FileScan, RepoLine, assertReadableFile, READ_CHUNK_BYTES, MAX_ALLOWED_BYTES, SearchState, MAX_SEARCH_FILE_BYTES, DEFAULT_MAX_BYTES } from "./repoReadActions.ts";
import { childRelativePath, sensitivePath, truncate } from "./repoReadPaths.ts";

// 固定缓冲读取，超长行只报告一次并丢弃内容，避免截断敏感值后再脱敏。
export function* scanFileLines(target: RepoTarget, budget: ReadBudget, maxFileBytes: number, scan: FileScan): Generator<RepoLine> {
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

export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.toString("utf8", 0, end);
}

export function searchTarget(
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

export function searchDirectory(
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

export function searchFile(
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

export function searchHalted(state: SearchState): boolean {
  if (state.halted || state.budget.remaining <= 0 || Date.now() > state.budget.deadline) {
    state.halted = true;
    state.truncated = true;
  }
  return state.halted;
}
