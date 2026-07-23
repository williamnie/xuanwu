import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listIssueEventsAsync } from "./asyncIssueEvents.ts";
import { openDatabase, type RunnerDatabase } from "./database.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("async Issue event reads", () => {
  test("runs the bounded SQLite query outside the Core event loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-events-worker-"));
    roots.push(root);
    const db = await openDatabase({ stateDir: root });
    try {
      const issueID = fixtureIssue(db);
      for (let index = 0; index < 20; index += 1) {
        db.sqlite.run(
          "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
          [issueID, JSON.stringify({ text: `event-${index}` }), `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`]
        );
      }

      let eventLoopAdvanced = false;
      setTimeout(() => {
        eventLoopAdvanced = true;
      }, 0);
      const pending = listIssueEventsAsync(db.path, issueID, {
        hydrateArtifacts: false,
        limit: 5,
        types: ["issue.log"]
      });
      await Bun.sleep(5);
      expect(eventLoopAdvanced).toBe(true);

      const events = await pending;
      expect(events).toHaveLength(5);
      expect(events.map((event) => JSON.parse(event.payload).text)).toEqual([
        "event-15",
        "event-16",
        "event-17",
        "event-18",
        "event-19"
      ]);
    } finally {
      db.close();
    }
  });
});

function fixtureIssue(db: RunnerDatabase): number {
  db.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values ('demo', 'Demo', '/tmp/demo', ?, ?)",
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  db.sqlite.run(
    "insert into issues (project_id, title, status, created_at, updated_at) values ('demo', 'Worker', 'done', ?, ?)",
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}
