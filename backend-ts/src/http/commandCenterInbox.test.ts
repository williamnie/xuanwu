import { expect, test } from "bun:test";
import { buildCommandCenterInbox, COMMAND_CENTER_INBOX_CONTRACT, type InboxItem, type InboxReaders, type InboxSource } from "./commandCenterInbox.ts";

function item(source: InboxSource, id: string, time = "2026-10-15T00:00:00.000Z"): InboxItem {
  return { source, key: `${source}:${id}`, actionable: source !== "preparing", occurred_at: time, work_id: null, project_id: null, attention_id: null };
}
function readers(items: InboxItem[]): InboxReaders {
  return Object.fromEntries(["human_review", "preparing", "failed_work", "attention"].map(source => [source, () => items.filter(item => item.source === source)])) as InboxReaders;
}
function page(items: InboxItem[], params = "") {
  return buildCommandCenterInbox(new Request(`http://fixture/api/command-center/inbox${params ? `?${params}` : ""}`), readers(items));
}
test("Inbox orders actionable sources by instant and key, then preparing, counting the full successful set", () => {
  const items = [item("preparing", "new", "2026-10-16T00:00:00Z"), item("human_review", "old", "2026-10-14T00:00:00Z"), item("failed_work", "a"), item("attention", "b"), item("attention", "a", "2026-10-15T00:00:00Z")];
  const result = page(items, "limit=3");
  expect(result.items.map(item => item.key)).toEqual(["attention:a", "attention:b", "failed_work:a"]);
  expect(result).toMatchObject({ contract: COMMAND_CENTER_INBOX_CONTRACT, total: 5, counts: { human_review: 1, failed_work: 1, preparing: 1, attention: 2 }, complete: true, failed_sources: [] });
  expect(result.next_cursor).not.toBeNull();
  expect(page(items, `limit=3&cursor=${result.next_cursor}`).items.map(item => item.key)).toEqual(["human_review:old", "preparing:new"]);
});
test("Inbox live keyset keeps unchanged rows once, picks later insertions and exposes earlier insertions on refresh", () => {
  const items = Array.from({ length: 7 }, (_, i) => item("attention", String(i), `2026-10-${String(15 - i).padStart(2, "0")}T00:00:00Z`));
  const first = page(items, "limit=2");
  const after = item("attention", "later", "2026-10-13T12:00:00Z");
  const before = item("attention", "newest", "2026-10-16T00:00:00Z");
  items.push(before, after);
  let cursor = first.next_cursor;
  const keys = first.items.map(item => item.key);
  while (cursor) {
    const result = page(items, `limit=2&cursor=${cursor}`);
    keys.push(...result.items.map(item => item.key)); cursor = result.next_cursor;
  }
  expect(new Set(keys).size).toBe(8);
  expect(keys).toHaveLength(8);
  expect(keys).toContain(after.key);
  expect(keys).not.toContain(before.key);
  expect(page(items).items[0].key).toBe(before.key);
});
test("Inbox rejects unknown, repeated, invalid limits and malformed or version-mismatched cursors before source reads", () => {
  let called = false;
  const sourceReaders = Object.fromEntries(["human_review", "preparing", "failed_work", "attention"].map(source => [source, () => { called = true; return []; }])) as InboxReaders;
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const params of ["other=1", "limit=0", "limit=51", "limit=1.5", "limit=", "limit=2&limit=2", "cursor=", "cursor=%", "cursor=e30", "cursor=a&cursor=b", `cursor=${encoded({ version: "v0", group: 0, key: "attention:1", occurred_at: "2026-10-15T00:00:00Z" })}`, `cursor=${encoded({ version: COMMAND_CENTER_INBOX_CONTRACT, group: 1, key: "attention:1", occurred_at: "2026-10-15T00:00:00Z" })}`]) {
    expect(() => buildCommandCenterInbox(new Request(`http://fixture/inbox?${params}`), sourceReaders)).toThrow();
  }
  expect(called).toBe(false);
});
test("Inbox isolates unavailable sources, never reports their absence as a complete empty queue", () => {
  const sourceReaders = readers([item("failed_work", "1"), item("attention", "1")]);
  sourceReaders.human_review = () => { throw new Error("private diagnostic must not escape"); };
  const result = buildCommandCenterInbox(new Request("http://fixture/inbox"), sourceReaders);
  expect(result).toMatchObject({ complete: false, failed_sources: ["human_review"], total: 2 });
  expect(JSON.stringify(result)).not.toContain("private diagnostic");
  expect(page([])).toMatchObject({ complete: true, total: 0, items: [], next_cursor: null });
  const allFailed = Object.fromEntries(Object.keys(sourceReaders).map(source => [source, sourceReaders.human_review])) as InboxReaders;
  expect(buildCommandCenterInbox(new Request("http://fixture/inbox"), allFailed)).toMatchObject({ complete: false, total: 0, failed_sources: ["human_review", "preparing", "failed_work", "attention"] });
});
