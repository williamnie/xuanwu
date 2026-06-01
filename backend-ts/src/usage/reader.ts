import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { clean, parseJSON } from "./helpers.ts";
import type { TokenEvent, UsageMeta, UsageRecord } from "./types.ts";

type FileSnapshot = { lastMeta: UsageMeta; mtimeMs: number; records: UsageRecord[]; size: number };
type UsageSnapshot = {
  cache: { files_incremental: number; files_reused: number; files_scanned: number; files_total: number };
  records: UsageRecord[];
};

const snapshotCache = new Map<string, Map<string, FileSnapshot>>();

export async function readUsageRecords(root: string): Promise<UsageRecord[]> {
  return (await readUsageSnapshot(root)).records;
}

export async function readUsageSnapshot(root: string): Promise<UsageSnapshot> {
  const files = await jsonlFiles(root);
  const previous = snapshotCache.get(root) ?? new Map<string, FileSnapshot>();
  const next = new Map<string, FileSnapshot>();
  const records: UsageRecord[] = [];
  const cache = { files_incremental: 0, files_reused: 0, files_scanned: 0, files_total: files.length };
  for (const path of files) {
    const snapshot = await readFileSnapshot(path, previous.get(path), cache);
    next.set(path, snapshot);
    records.push(...snapshot.records);
  }
  snapshotCache.set(root, next);
  return { cache, records };
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectJsonlFiles(root, files);
  return files.sort();
}

async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectJsonlFiles(path, files);
    else if (entry.isFile() && extname(entry.name) === ".jsonl") files.push(path);
  }
}

async function scanUsageFile(path: string, records: UsageRecord[]): Promise<UsageMeta> {
  const meta = { cwd: "", id: "" };
  const reader = createInterface({ crlfDelay: Infinity, input: createReadStream(path, { encoding: "utf8" }) });
  for await (const line of reader) handleUsageLine(line, meta, records);
  return meta;
}

async function readFileSnapshot(
  path: string,
  previous: FileSnapshot | undefined,
  cache: UsageSnapshot["cache"]
): Promise<FileSnapshot> {
  const current = await stat(path);
  if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
    cache.files_reused += 1;
    return previous;
  }
  if (previous && current.size > previous.size) return await appendFileSnapshot(path, previous, current.size, current.mtimeMs, cache);
  const records: UsageRecord[] = [];
  const lastMeta = await scanUsageFile(path, records);
  cache.files_scanned += 1;
  return { lastMeta, mtimeMs: current.mtimeMs, records, size: current.size };
}

async function appendFileSnapshot(
  path: string,
  previous: FileSnapshot,
  size: number,
  mtimeMs: number,
  cache: UsageSnapshot["cache"]
): Promise<FileSnapshot> {
  const records = previous.records.slice();
  const meta = { ...previous.lastMeta };
  const reader = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(path, { encoding: "utf8", start: previous.size })
  });
  for await (const line of reader) handleUsageLine(line, meta, records);
  cache.files_incremental += 1;
  return { lastMeta: meta, mtimeMs, records, size };
}

function handleUsageLine(line: string, meta: UsageMeta, records: UsageRecord[]): void {
  if (line.includes("session_meta")) {
    updateSessionMeta(line, meta);
    return;
  }
  if (!line.includes("token_count")) return;
  const event = parseJSON(line) as TokenEvent | null;
  if (event?.type !== "event_msg" || event.payload?.type !== "token_count") return;
  records.push({ event, meta: { ...meta } });
}

function updateSessionMeta(line: string, meta: UsageMeta): void {
  const session = parseJSON(line) as { payload?: { cwd?: string; id?: string }; type?: string } | null;
  if (session?.type !== "session_meta") return;
  meta.cwd = clean(session.payload?.cwd);
  meta.id = clean(session.payload?.id);
}
