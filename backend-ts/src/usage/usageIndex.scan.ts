import { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { clean, dayKey, timestamp, timestampMs, tokenUsage } from "./helpers.ts";
import type { TokenEvent, UsageMeta } from "./types.ts";
import { READ_CHUNK_BYTES, MAX_LINE_BYTES } from "./usageIndex.model.ts";
import type { FileDescriptor } from "./usageIndex.model.ts";
import { tailChecksum } from "./usageIndex.filesystem.ts";
import { INSERT_EVENT, UPSERT_BUCKET } from "./usageIndex.sql.ts";
import { compactInfo } from "./usageIndex.storage.ts";

export async function scanFile(
  db: Database,
  descriptor: FileDescriptor,
  start: number,
  initialMeta: UsageMeta,
  initialCorrupt: number
): Promise<{ bytesRead: number; corruptLines: number; lastMeta: UsageMeta; offset: number; tailChecksum: string }> {
  const meta = { ...initialMeta };
  let corruptLines = initialCorrupt;
  let offset = start;
  let pending = Buffer.alloc(0);
  let pendingStart = start;
  let droppingOversize = false;
  if (descriptor.size <= start) {
    return {
      bytesRead: 0,
      corruptLines,
      lastMeta: meta,
      offset: start,
      tailChecksum: await tailChecksum(descriptor.path, start)
    };
  }
  const handle = await open(descriptor.path, "r");
  try {
    let position = start;
    while (position < descriptor.size) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, descriptor.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const value = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
      pending = pending.length === 0 ? value : Buffer.concat([pending, value]);
      while (true) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const line = pending.subarray(0, newline > 0 && pending[newline - 1] === 0x0d ? newline - 1 : newline);
        if (droppingOversize) {
          corruptLines += 1;
          droppingOversize = false;
        } else {
          corruptLines += processLine(db, descriptor.path, pendingStart, line, meta) ? 0 : 1;
        }
        const consumed = newline + 1;
        pendingStart += consumed;
        offset = pendingStart;
        pending = pending.subarray(consumed);
      }
      if (pending.length > MAX_LINE_BYTES) {
        pendingStart += pending.length;
        pending = Buffer.alloc(0);
        droppingOversize = true;
      }
    }
  } finally {
    await handle.close();
  }
  if (!droppingOversize && pending.length > 0) {
    const valid = processLine(db, descriptor.path, pendingStart, pending, meta);
    if (valid) offset = descriptor.size;
  }
  return {
    bytesRead: Math.max(0, descriptor.size - start),
    corruptLines,
    lastMeta: meta,
    offset,
    tailChecksum: await tailChecksum(descriptor.path, offset)
  };
}

export function processLine(db: Database, path: string, byteOffset: number, line: Buffer, meta: UsageMeta): boolean {
  const text = line.toString("utf8").trim();
  if (text === "") return true;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as { payload?: { cwd?: unknown; id?: unknown; type?: unknown }; timestamp?: string; type?: unknown };
  if (record.type === "session_meta") {
    meta.cwd = clean(record.payload?.cwd);
    meta.id = clean(record.payload?.id);
    return true;
  }
  if (record.type !== "event_msg" || record.payload?.type !== "token_count") return true;
  const event = value as TokenEvent;
  insertEvent(db, path, byteOffset, event, meta);
  return true;
}

export function insertEvent(db: Database, path: string, byteOffset: number, event: TokenEvent, meta: UsageMeta): void {
  const at = timestamp(event);
  const atMs = timestampMs(event);
  const info = event.payload?.info;
  const limits = event.payload?.rate_limits;
  const usage = tokenUsage(info?.last_token_usage);
  db.query(INSERT_EVENT).run(
    path,
    byteOffset,
    atMs,
    at.toISOString(),
    meta.cwd,
    meta.id,
    info ? JSON.stringify(compactInfo(info)) : null,
    limits ? JSON.stringify(limits) : null,
    usage.cached_input_tokens,
    usage.input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  );
  if (!info) return;
  db.query(UPSERT_BUCKET).run(
    path,
    dayKey(at),
    meta.cwd,
    meta.id,
    atMs,
    1,
    usage.cached_input_tokens,
    usage.input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  );
}
