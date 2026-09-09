import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiExecutorProvider } from "./provider.ts";
import { readPiSessionFile, readPiSessionTurnPage } from "./sessionFileReader.ts";
import { publicPiSessionDetail, piTranscriptTurns } from "./sessionHistory.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(entries: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-history-async-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return path;
}
const header = { type: "session", version: 3, id: "history", cwd: "/tmp/project", timestamp: "2026-09-01T00:00:00Z" };
function user(id: string, parentId: string | null, text = id) {
  return { type: "message", id, parentId, message: { role: "user", content: text } };
}
function answer(id: string, parentId: string, text = id) {
  return { type: "message", id, parentId, message: { role: "assistant", provider: "test", model: "model", content: [{ type: "text", text }] } };
}

test("metadata and native turn pages follow the active branch and never rewrite the source", async () => {
  const path = await fixture([header, user("u1", null, "你好"), answer("a1", "u1"), user("discarded", "a1"),
    answer("discarded-answer", "discarded"), user("u2", "a1"), answer("a2", "u2"),
    { type: "session_info", id: "name", parentId: "a2", name: "Named session" }]);
  const before = await readFile(path, "utf8");
  const detail = publicPiSessionDetail(await readPiSessionFile(path, { includeTurns: false }));
  expect(detail).toMatchObject({ name: "Named session", preview: "你好", model: "test/model", turns: [] });
  const latest = await readPiSessionTurnPage(path, { limit: 1 });
  expect(latest.groups.flatMap(piTranscriptTurns).map((turn) => turn.id)).toEqual(["u2"]);
  expect(latest.nextCursor).toBe("1");
  const older = await readPiSessionTurnPage(path, { limit: 1, cursor: latest.nextCursor });
  expect(older.groups.flatMap(piTranscriptTurns).map((turn) => turn.id)).toEqual(["u1"]);
  expect(older.nextCursor).toBeUndefined();
  expect((await readPiSessionTurnPage(path, { sortDirection: "asc" })).groups.flatMap(piTranscriptTurns).map((turn) => turn.id)).toEqual(["u1", "u2"]);
  expect(await readFile(path, "utf8")).toBe(before);
});

test("metadata and turns share compact discovery, with cache invalidated after append", async () => {
  const path = await fixture([header, user("u1", null), answer("a1", "u1")]);
  const subject = new PiExecutorProvider({ sessionFunctions: { resolve: async () => path, read: readPiSessionFile, readTurns: readPiSessionTurnPage } });
  const [detail, turns] = await Promise.all([subject.readSession("history", { includeTurns: false }), subject.listSessionTurns("history", { limit: 1 })]);
  expect(detail.turns).toEqual([]);
  expect(turns.data.map((turn) => turn.id)).toEqual(["u1"]);
  await appendFile(path, `\n${JSON.stringify(user("u2", "a1"))}\n`);
  expect((await subject.listSessionTurns("history", { limit: 1 })).data.map((turn) => turn.id)).toEqual(["u2"]);
  await expect(subject.listSessionTurns("wrong-session", {})).rejects.toThrow("mismatched history");
});

test("legacy histories receive stable read-only IDs and malformed lines are skipped", async () => {
  const path = await fixture([{ ...header, version: 1 }, user("ignored", null), answer("also-ignored", "ignored")]);
  await appendFile(path, "\n{broken");
  const before = await readFile(path, "utf8");
  const first = await readPiSessionFile(path);
  const second = await readPiSessionFile(path);
  expect(first.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
  expect(piTranscriptTurns(first.entries)).toHaveLength(1);
  expect(await readFile(path, "utf8")).toBe(before);
});

test("large history yields to the event loop and returns only the requested turn payload", async () => {
  const entries: unknown[] = [header];
  for (let i = 0; i < 200; i++) {
    entries.push(user(`u${i}`, i ? `a${i - 1}` : null));
    entries.push(answer(`a${i}`, `u${i}`, "汉".repeat(12_000)));
  }
  const path = await fixture(entries);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const page = await readPiSessionTurnPage(path, { limit: 1 });
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0]).toHaveLength(2);
    expect(page.groups[0]?.[0]?.id).toBe("u199");
    expect(ticks).toBeGreaterThan(0);
  } finally { clearInterval(timer); }
});

test("a parent cycle fails explicitly instead of hanging the server", async () => {
  const path = await fixture([header, user("u1", "a1"), answer("a1", "u1")]);
  await expect(readPiSessionFile(path)).rejects.toThrow("parent cycle");
});

test("concurrent history reads reject excess work and release capacity after completion", async () => {
  const path = await fixture([header, user("u1", null), answer("a1", "u1", "x".repeat(100_000))]);
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => readPiSessionFile(path, { includeTurns: false })));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
  const failures = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
  expect(failures).toHaveLength(16);
  expect(failures.every((failure) => failure.reason.message.includes("busy"))).toBe(true);
  expect((await readPiSessionFile(path, { includeTurns: false })).id).toBe("history");
});

test("unbounded entry metadata is rejected without caching a partial index", async () => {
  const entries: unknown[] = [header];
  for (let i = 0; i <= 100_000; i++) entries.push({ type: "label", id: String(i), parentId: i ? String(i - 1) : null });
  const path = await fixture(entries);
  await expect(readPiSessionFile(path, { includeTurns: false })).rejects.toThrow("exceeds 100000 indexed entries");
  await writeFile(path, [header, user("u1", null)].map((entry) => JSON.stringify(entry)).join("\n"));
  expect((await readPiSessionFile(path, { includeTurns: false })).id).toBe("history");
});
