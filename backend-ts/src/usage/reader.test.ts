import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCodexUsage } from "./codex.ts";
import { defaultUsageIndexPath, readUsageSnapshot, resetUsageReaderState } from "./reader.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("usage reader cache", () => {
  test("reuses unchanged files and reads appended usage incrementally", async () => {
    const root = await tempDir();
    const usagePath = await writeUsageJSONL(root, "2026/06/01/session.jsonl", [
      sessionMeta("thread-1", "/tmp/demo"),
      tokenCount(1)
    ]);

    const first = await readUsageSnapshot(root);
    await appendFile(usagePath, `${tokenCount(2)}\n`);
    const second = await readUsageSnapshot(root);
    const third = await readUsageSnapshot(root);

    expect(first.cache).toMatchObject({ files_incremental: 0, files_reused: 0, files_scanned: 1, files_total: 1 });
    expect(first.buckets).toHaveLength(1);
    expect(first.buckets[0]).toMatchObject({ events: 1, usage: { total_tokens: 1 } });
    expect(second.cache).toMatchObject({ files_incremental: 1, files_reused: 0, files_scanned: 0, files_total: 1 });
    expect(second.buckets).toHaveLength(1);
    expect(second.buckets[0]).toMatchObject({ events: 2, usage: { total_tokens: 3 } });
    expect(third.cache).toMatchObject({ files_incremental: 0, files_reused: 1, files_scanned: 0, files_total: 1 });
    expect(third.buckets).toHaveLength(1);
    expect(second.recent.map((record) => record.meta.id)).toEqual(["thread-1", "thread-1"]);
  });

  test("preserves session metadata when token usage arrives after the first scan", async () => {
    const root = await tempDir();
    const usagePath = await writeUsageJSONL(root, "2026/06/01/delayed.jsonl", [
      sessionMeta("thread-delayed", "/tmp/delayed")
    ]);

    const first = await readUsageSnapshot(root);
    await appendFile(usagePath, `${tokenCount(3)}\n`);
    const second = await readUsageSnapshot(root);

    expect(first.buckets).toHaveLength(0);
    expect(second.cache).toMatchObject({ files_incremental: 1, files_reused: 0, files_scanned: 0, files_total: 1 });
    expect(second.buckets).toHaveLength(1);
    expect(second.buckets[0].meta).toEqual({ cwd: "/tmp/delayed", id: "thread-delayed" });
  });

  test("bounds retained records while preserving the full aggregate", async () => {
    const root = await tempDir();
    await writeUsageJSONL(root, "2026/06/01/large.jsonl", [
      sessionMeta("thread-large", "/tmp/large"),
      ...Array.from({ length: 1500 }, (_, index) => tokenCount(index + 1))
    ]);

    const snapshot = await readUsageSnapshot(root);

    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.buckets[0]).toMatchObject({
      events: 1500,
      usage: { total_tokens: 1_125_750 }
    });
    expect(snapshot.recent).toHaveLength(1000);

    const report = await readCodexUsage({ root });
    expect(report).toMatchObject({
      events_scanned: 1500,
      summary: { all_time: { total_tokens: 1_125_750 } }
    });
    const limited = await readCodexUsage({ root, options: { limit: 1 } });
    expect(limited).toMatchObject({
      events_scanned: 1,
      summary: { all_time: { total_tokens: 1500 } }
    });
    const compact = await readCodexUsage({ root, options: { includeDimensions: false } });
    expect(compact).toMatchObject({ compact: true, events_scanned: 1500, project_usage: [] });
  });

  test("reopens the persistent index after process-state reset and reads only appended bytes", async () => {
    const root = await tempDir();
    const usagePath = await writeUsageJSONL(root, "2026/06/01/persistent.jsonl", [
      sessionMeta("thread-persistent", "/tmp/persistent"),
      tokenCount(4)
    ]);
    await readUsageSnapshot(root);

    resetUsageReaderState();
    const cached = await readUsageSnapshot(root, 0, { backgroundRefresh: true });
    const unchanged = await readUsageSnapshot(root);
    expect(cached.freshness.index_version).toBe(1);
    expect(unchanged.cache).toMatchObject({ bytes_read: 0, files_reused: 1, files_scanned: 0 });

    const appended = `${tokenCount(6)}\n`;
    await appendFile(usagePath, appended);
    const incremental = await readUsageSnapshot(root);
    expect(incremental.cache).toMatchObject({
      bytes_read: Buffer.byteLength(appended),
      files_incremental: 1,
      files_scanned: 0
    });
    expect(incremental.buckets[0]).toMatchObject({ events: 2, usage: { total_tokens: 10 } });
  });

  test("keeps arbitrary explicit limits exact across restart", async () => {
    const root = await tempDir();
    await writeUsageJSONL(root, "2026/06/01/limits.jsonl", [
      sessionMeta("thread-limit", "/tmp/limit"),
      ...Array.from({ length: 1205 }, (_, index) => tokenCount(index + 1))
    ]);
    await readUsageSnapshot(root);
    resetUsageReaderState();

    const limited = await readCodexUsage({ root, options: { limit: 1100 } });
    expect(limited).toMatchObject({
      events_scanned: 1100,
      summary: { all_time: { total_tokens: sumRange(106, 1205) } }
    });
  });

  test("isolates malformed lines and rebuilds only a truncated file", async () => {
    const root = await tempDir();
    const changed = await writeUsageJSONL(root, "2026/06/01/changed.jsonl", [
      sessionMeta("thread-changed", "/tmp/changed"),
      "{broken-json",
      tokenCount(8)
    ]);
    await writeUsageJSONL(root, "2026/06/01/stable.jsonl", [
      sessionMeta("thread-stable", "/tmp/stable"),
      tokenCount(5)
    ]);
    const first = await readUsageSnapshot(root);
    expect(first.cache.corrupt_lines).toBe(1);
    expect(first.buckets.reduce((total, item) => total + item.usage.total_tokens, 0)).toBe(13);

    await writeFile(changed, `${sessionMeta("thread-changed", "/tmp/changed")}\n${tokenCount(3)}\n`);
    const rebuilt = await readUsageSnapshot(root);
    expect(rebuilt.cache).toMatchObject({ corrupt_lines: 0, files_reused: 1, files_scanned: 1 });
    expect(rebuilt.buckets.reduce((total, item) => total + item.usage.total_tokens, 0)).toBe(8);
  });

  test("atomically recreates an incompatible index without touching sessions", async () => {
    const root = await tempDir();
    const usagePath = await writeUsageJSONL(root, "2026/06/01/recovery.jsonl", [
      sessionMeta("thread-recovery", "/tmp/recovery"),
      tokenCount(9)
    ]);
    await readUsageSnapshot(root);
    const indexPath = defaultUsageIndexPath(root);
    const db = new Database(indexPath);
    db.run("pragma user_version = 999");
    db.close();
    await writeFile(`${indexPath}.lock`, JSON.stringify({ pid: 999_999_999 }));
    await writeFile(`${indexPath}.tmp-abandoned`, "partial-index");
    resetUsageReaderState();

    const recovered = await readUsageSnapshot(root);
    expect(recovered.cache).toMatchObject({ files_scanned: 1, index_rebuilds: 1 });
    expect(recovered.buckets[0]?.usage.total_tokens).toBe(9);
    expect(await Bun.file(`${indexPath}.tmp-abandoned`).exists()).toBe(false);
    expect(await Bun.file(usagePath).text()).toContain("thread-recovery");
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-usage-reader-"));
  tempRoots.push(root);
  return root;
}

async function writeUsageJSONL(root: string, name: string, lines: string[]): Promise<string> {
  const path = join(root, ...name.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

function sessionMeta(id: string, cwd: string): string {
  return JSON.stringify({ type: "session_meta", payload: { cwd, id } });
}

function tokenCount(total: number): string {
  return JSON.stringify({
    timestamp: "2026-06-01T08:00:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: total } } }
  });
}

function sumRange(first: number, last: number): number {
  return ((first + last) * (last - first + 1)) / 2;
}
