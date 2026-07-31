import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiUsage } from "./pi.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("PI SDK daily token usage", () => {
  test("aggregates assistant calls by local day and project without counting user/tool records", async () => {
    const root = await tempRoot();
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    await writeFile(first, [
      record("2026-07-30T10:10:00.000Z", "user", {}),
      record("2026-07-30T10:20:00.000Z", "assistant", {
        cacheRead: 20, cacheWrite: 5, input: 10, output: 3, totalTokens: 38
      }),
      JSON.stringify({ type: "custom", timestamp: "2026-07-30T10:30:00.000Z" })
    ].join("\n"));
    await writeFile(second, [
      record("2026-07-31T01:00:00.000Z", "assistant", {
        cacheRead: 4, input: 6, output: 2, totalTokens: 12
      }),
      record("2026-07-31T02:00:00.000Z", "assistant", {
        cacheRead: 0, input: 5, output: 1, totalTokens: 6
      })
    ].join("\n"));

    const report = await readPiUsage({
      now: new Date("2026-07-31T03:00:00.000Z"),
      sessions: [
        { conversation_id: "first", project_id: "demo", session_file: first },
        { conversation_id: "second", project_id: "other", session_file: second }
      ]
    });

    expect(report).toMatchObject({
      assistant_calls: 3,
      files_missing: 0,
      sessions_scanned: 2,
      summary: {
        all_time: {
          cached_input_tokens: 24,
          cache_write_input_tokens: 5,
          input_tokens: 50,
          output_tokens: 6,
          total_tokens: 56,
          uncached_input_tokens: 21
        },
        today: { total_tokens: 18 }
      }
    });
    expect(report.daily).toEqual([
      expect.objectContaining({ assistant_calls: 1, key: "2026-07-30" }),
      expect.objectContaining({ assistant_calls: 2, key: "2026-07-31" })
    ]);
    expect(report.project_usage).toEqual([
      expect.objectContaining({ assistant_calls: 1, project_id: "demo", sessions: 1 }),
      expect.objectContaining({ assistant_calls: 2, project_id: "other", sessions: 1 })
    ]);
  });

  test("re-reads a growing session and reports missing files without failing the report", async () => {
    const root = await tempRoot();
    const path = join(root, "growing.jsonl");
    await writeFile(path, `${record("2026-07-31T01:00:00.000Z", "assistant", {
      input: 2, output: 1, totalTokens: 3
    })}\n`);
    const sessions = [
      { conversation_id: "growing", project_id: "", session_file: path },
      { conversation_id: "missing", project_id: "demo", session_file: join(root, "missing.jsonl") }
    ];

    const first = await readPiUsage({ now: new Date("2026-07-31T03:00:00.000Z"), sessions });
    await writeFile(path, [
      record("2026-07-31T01:00:00.000Z", "assistant", { input: 2, output: 1, totalTokens: 3 }),
      record("2026-07-31T02:00:00.000Z", "assistant", { input: 4, output: 2, totalTokens: 6 })
    ].join("\n"));
    const second = await readPiUsage({ now: new Date("2026-07-31T03:00:00.000Z"), sessions });

    expect(first).toMatchObject({
      assistant_calls: 1,
      files_missing: 1,
      summary: { today: { total_tokens: 3 } }
    });
    expect(second).toMatchObject({
      assistant_calls: 2,
      files_missing: 1,
      project_usage: [expect.objectContaining({ project_id: "runner-global" })],
      summary: { today: { total_tokens: 9 } }
    });
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runner-pi-usage-"));
  roots.push(root);
  return root;
}

function record(timestamp: string, role: string, usage: Record<string, number>): string {
  return JSON.stringify({
    message: { role, usage },
    timestamp,
    type: "message"
  });
}
