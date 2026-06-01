import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { clean, parseJSON } from "./helpers.ts";
import type { TokenEvent, UsageMeta, UsageRecord } from "./types.ts";

export async function readUsageRecords(root: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  for (const path of await jsonlFiles(root)) await scanUsageFile(path, records);
  return records;
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

async function scanUsageFile(path: string, records: UsageRecord[]): Promise<void> {
  const meta = { cwd: "", id: "" };
  const reader = createInterface({ crlfDelay: Infinity, input: createReadStream(path, { encoding: "utf8" }) });
  for await (const line of reader) handleUsageLine(line, meta, records);
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
