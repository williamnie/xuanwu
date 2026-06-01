import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readUsageSnapshot } from "./reader.ts";

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

    expect(first.cache).toEqual({ files_incremental: 0, files_reused: 0, files_scanned: 1, files_total: 1 });
    expect(first.records).toHaveLength(1);
    expect(second.cache).toEqual({ files_incremental: 1, files_reused: 0, files_scanned: 0, files_total: 1 });
    expect(second.records).toHaveLength(2);
    expect(third.cache).toEqual({ files_incremental: 0, files_reused: 1, files_scanned: 0, files_total: 1 });
    expect(third.records).toHaveLength(2);
    expect(second.records.map((record) => record.meta.id)).toEqual(["thread-1", "thread-1"]);
  });

  test("preserves session metadata when token usage arrives after the first scan", async () => {
    const root = await tempDir();
    const usagePath = await writeUsageJSONL(root, "2026/06/01/delayed.jsonl", [
      sessionMeta("thread-delayed", "/tmp/delayed")
    ]);

    const first = await readUsageSnapshot(root);
    await appendFile(usagePath, `${tokenCount(3)}\n`);
    const second = await readUsageSnapshot(root);

    expect(first.records).toHaveLength(0);
    expect(second.cache).toEqual({ files_incremental: 1, files_reused: 0, files_scanned: 0, files_total: 1 });
    expect(second.records).toHaveLength(1);
    expect(second.records[0].meta).toEqual({ cwd: "/tmp/delayed", id: "thread-delayed" });
  });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-usage-reader-"));
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
