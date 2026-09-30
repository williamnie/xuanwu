import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshUsageIndex, usageIndexIdentity, usageIndexIsValid } from "./usageIndex.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("reuses integrity validation only while the same index files are unchanged", async () => {
  const { root, indexPath } = await fixture();
  const identity = usageIndexIdentity(indexPath);
  expect(identity).toBeDefined();
  const query = spyOn(Database.prototype, "query");
  const checks = () => query.mock.calls.filter(([sql]) => sql === "pragma quick_check").length;
  try {
    expect(usageIndexIsValid(indexPath, root)).toBe(true);
    expect(checks()).toBe(1);

    await refreshUsageIndex(root, indexPath, { verifiedIndexIdentity: identity });
    expect(checks()).toBe(1);

    const currentIdentity = usageIndexIdentity(indexPath);
    const db = new Database(indexPath);
    try {
      db.query("update metadata set value=? where key='indexed_at'").run("externally changed");
      expect(usageIndexIdentity(indexPath)).not.toBe(currentIdentity);
      await refreshUsageIndex(root, indexPath, { verifiedIndexIdentity: currentIdentity });
      expect(checks()).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    query.mockRestore();
  }
});

test("checks schema and source even when the index identity was verified", async () => {
  const { root, indexPath } = await fixture();
  expect(usageIndexIsValid(indexPath, `${root}/different`, usageIndexIdentity(indexPath))).toBe(false);

  const db = new Database(indexPath);
  db.run("pragma user_version=999");
  db.close();
  expect(usageIndexIsValid(indexPath, root, usageIndexIdentity(indexPath))).toBe(false);
  const metrics = await refreshUsageIndex(root, indexPath, { verifiedIndexIdentity: usageIndexIdentity(indexPath) });
  expect(metrics).toMatchObject({ files_scanned: 1, index_rebuilds: 1 });
});

async function fixture(): Promise<{ root: string; indexPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-usage-validation-"));
  roots.push(root);
  await writeFile(join(root, "session.jsonl"), `${JSON.stringify({
    timestamp: "2026-09-30T00:00:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: 10 } } }
  })}\n`);
  const indexPath = join(root, "usage.sqlite");
  await refreshUsageIndex(root, indexPath);
  return { root, indexPath };
}
