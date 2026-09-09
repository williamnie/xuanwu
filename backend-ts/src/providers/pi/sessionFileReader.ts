import { open, type FileHandle } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionReadInput, SessionTurnsListInput } from "../types.ts";
import type { PiSessionSnapshot } from "./sessionHistory.ts";

export class PiHistoryLimitError extends Error {}

const CHUNK_BYTES = 64 * 1024;
export const PI_HISTORY_LINE_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 32 * 1024 * 1024;
const INDEX_CACHE_ENTRIES = 50_000;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_CONCURRENT_SCANS = 4;
const MAX_CONCURRENT_READS = 16;
let activeReads = 0;
type EntryOffset = {
  id: string; parentId: string | null; start: number; length: number;
  user: boolean; visible: boolean; model: string;
};
type FileIndex = {
  id: string; cwd: string; name: string; createdAt: number; updatedAt: number;
  branch: EntryOffset[]; turns: EntryOffset[][]; entryCount: number;
};
const indexes = new Map<string, FileIndex>();
const pendingIndexes = new Map<string, Promise<FileIndex>>();

// 固定块读取，避免 readline 在无换行异常输出上无限增长；不修复或迁移原文件。
export async function* piJsonlLines(file: FileHandle, size: number) {
  let pending = Buffer.alloc(0);
  let start = 0;
  for (let offset = 0; offset < size;) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    offset += bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    let cursor = 0;
    for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, cursor)) {
      const fragment = bytes.subarray(cursor, newline);
      if (pending.length + fragment.length > PI_HISTORY_LINE_BYTES) throw new PiHistoryLimitError("Pi history line exceeds 16 MiB limit");
      const line = pending.length ? Buffer.concat([pending, fragment]) : fragment;
      yield { text: line.toString("utf8"), start, length: line.length };
      start += line.length + 1;
      pending = Buffer.alloc(0);
      cursor = newline + 1;
    }
    const fragment = bytes.subarray(cursor);
    if (pending.length + fragment.length > PI_HISTORY_LINE_BYTES) throw new PiHistoryLimitError("Pi history line exceeds 16 MiB limit");
    pending = pending.length ? Buffer.concat([pending, fragment]) : Buffer.from(fragment);
  }
  if (pending.length) yield { text: pending.toString("utf8"), start, length: pending.length };
}

export async function readPiSessionFile(path: string, input: SessionReadInput = {}): Promise<PiSessionSnapshot> {
  return withIndex(path, async (file, index) => {
    const firstUser = index.branch.find((entry) => entry.user);
    const previewEntries = firstUser ? await readEntries(file, [firstUser]) : [];
    const entries = input.includeTurns === false ? [] : await readEntries(file, index.branch);
    return {
      ...metadata(index), entries,
      previewEntries,
      model: latestIndexedModel(index.branch)
    };
  });
}

function latestIndexedModel(branch: EntryOffset[]): string {
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]!.model) return branch[index]!.model;
  }
  return "";
}

export async function readPiSessionTurnPage(path: string, input: SessionTurnsListInput) {
  return withIndex(path, async (file, index) => {
    const offset = /^\d+$/.test(input.cursor || "") ? Number(input.cursor) : 0;
    const limit = Number.isFinite(input.limit) ? Math.min(100, Math.max(1, Math.floor(input.limit!))) : 20;
    const ordered = input.sortDirection === "asc" ? index.turns : [...index.turns].reverse();
    const selected = ordered.slice(offset, offset + limit);
    if (selected.flat().reduce((sum, entry) => sum + entry.length, 0) > PAGE_BYTES) throw new PiHistoryLimitError("Pi history page exceeds 32 MiB; request fewer turns");
    const groups: SessionEntry[][] = [];
    for (const entries of selected) groups.push(await readEntries(file, entries));
    return { id: index.id, groups, nextCursor: offset + selected.length < ordered.length ? String(offset + selected.length) : undefined };
  });
}

function metadata(index: FileIndex) {
  const { id, cwd, name, createdAt, updatedAt } = index;
  return { id, cwd, name, createdAt, updatedAt };
}

async function withIndex<T>(path: string, action: (file: FileHandle, index: FileIndex) => Promise<T>): Promise<T> {
  if (activeReads >= MAX_CONCURRENT_READS) throw new PiHistoryLimitError("Pi history is busy; retry the request");
  activeReads++;
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    const key = `${path}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let index = indexes.get(key);
    if (!index) {
      let pending = pendingIndexes.get(key);
      if (!pending) {
        if (pendingIndexes.size >= MAX_CONCURRENT_SCANS) throw new PiHistoryLimitError("Pi history indexing is busy; retry the request");
        pending = buildIndex(file, stat.size, stat.birthtimeMs || stat.ctimeMs, stat.mtimeMs);
        pendingIndexes.set(key, pending);
      }
      try {
        index = await pending;
        if (index.entryCount <= INDEX_CACHE_ENTRIES) {
          // 只缓存偏移与短元数据；不保留历史消息正文。
          indexes.set(key, index);
          while (indexes.size > 4 || [...indexes.values()].reduce((sum, item) => sum + item.entryCount, 0) > INDEX_CACHE_ENTRIES) {
            indexes.delete(indexes.keys().next().value!);
          }
        }
      } finally {
        if (pendingIndexes.get(key) === pending) pendingIndexes.delete(key);
      }
    }
    return await action(file, index);
  } finally {
    try { await file?.close(); } finally { activeReads--; }
  }
}

async function buildIndex(file: FileHandle, size: number, createdMs: number, updatedMs: number): Promise<FileIndex> {
  const byId = new Map<string, EntryOffset>();
  let header: Record<string, unknown> | undefined;
  let leaf: EntryOffset | undefined;
  let name = "";
  for await (const line of piJsonlLines(file, size)) {
    let entry: Record<string, any>;
    try { entry = JSON.parse(line.text); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (!header) {
      if (entry.type !== "session" || typeof entry.id !== "string") throw new Error("Invalid Pi session header");
      header = entry;
      continue;
    }
    if (entry.type === "session") continue;
    const legacy = Number(header.version || 1) < 2;
    const id = legacy ? `legacy-${line.start}` : entry.id;
    if (typeof id !== "string") continue;
    const message = entry.type === "message" ? entry.message : undefined;
    const content = message?.content;
    const hasText = typeof content === "string" ? Boolean(content) : Array.isArray(content) && content.some((item) => item?.type === "text" && item.text);
    const user = message?.role === "user" && hasText;
    const visible = user || message?.role === "toolResult" || (message?.role === "assistant" && Array.isArray(content) && content.some((item) =>
      item?.type === "toolCall" || (item?.type === "text" && item.text) || (item?.type === "thinking" && item.thinking)));
    const model = entry.type === "model_change" ? [entry.provider, entry.modelId].filter(Boolean).join("/")
      : message?.role === "assistant" ? [message.provider, message.model].filter(Boolean).join("/") : "";
    leaf = { id, parentId: legacy ? leaf?.id || null : entry.parentId, start: line.start, length: line.length, user, visible: Boolean(visible), model };
    if (!byId.has(id) && byId.size >= MAX_INDEX_ENTRIES) throw new PiHistoryLimitError("Pi history exceeds 100000 indexed entries; archive or split this session");
    byId.set(id, leaf);
    if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name : "";
  }
  if (!header) throw new Error("Invalid Pi session header");
  const branch: EntryOffset[] = [];
  const seen = new Set<string>();
  while (leaf) {
    if (seen.has(leaf.id)) throw new Error("Pi session history contains a parent cycle");
    seen.add(leaf.id);
    branch.push(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  branch.reverse();
  const turns: EntryOffset[][] = [];
  for (const entry of branch) {
    if (!entry.visible) continue;
    if (entry.user || !turns.length) turns.push([]);
    turns.at(-1)!.push(entry);
  }
  const created = Date.parse(String(header.timestamp || ""));
  return { id: String(header.id), cwd: String(header.cwd || ""), name, createdAt: Math.floor((Number.isFinite(created) ? created : createdMs) / 1000), updatedAt: Math.floor(updatedMs / 1000), branch, turns, entryCount: byId.size };
}

async function readEntries(file: FileHandle, selected: EntryOffset[]): Promise<SessionEntry[]> {
  if (selected.reduce((sum, entry) => sum + entry.length, 0) > PAGE_BYTES) throw new PiHistoryLimitError("Pi history page exceeds 32 MiB; request fewer turns");
  const entries: SessionEntry[] = [];
  for (const entry of selected) {
    const buffer = Buffer.allocUnsafe(entry.length);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, entry.start + offset);
      if (!bytesRead) throw new Error("Pi history changed while reading; retry the request");
      offset += bytesRead;
    }
    const parsed = JSON.parse(buffer.toString("utf8"));
    entries.push({ ...parsed, id: entry.id, parentId: entry.parentId });
  }
  return entries;
}
