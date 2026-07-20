import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordIssueLogEvent } from "../db/repositories/issueEvents.ts";
import type { ProviderEvent } from "../providers/types.ts";
import { createIssueLogPersistence } from "./issueLogPersistence.ts";

const tempRoots: string[] = [];
const session = { provider: "codex" as const, sessionId: "benchmark-thread", turnId: "benchmark-turn" };

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { recursive: true, force: true });
});

describe("issue.log bounded storage benchmark", () => {
  test("reduces equivalent Run DB rows and payload bytes by at least 70 percent", async () => {
    const baseline = await fixture("baseline");
    const bounded = await fixture("bounded");
    try {
      const events = benchmarkEvents();
      const baselineBefore = allocatedBytes(baseline.db);
      for (const event of events) recordIssueLogEvent(baseline.db, baseline.issueID, event);
      const baselineAfter = storage(baseline.db, baseline.issueID, baselineBefore);

      const boundedBefore = allocatedBytes(bounded.db);
      const persistence = createIssueLogPersistence((event) => {
        recordIssueLogEvent(bounded.db, bounded.issueID, event);
      });
      events.forEach((event) => persistence.push(event));
      persistence.flush();
      const boundedAfter = storage(bounded.db, bounded.issueID, boundedBefore);

      expect(baselineAfter.rows).toBe(events.length);
      expect(boundedAfter.rows).toBeLessThan(baselineAfter.rows * 0.3);
      expect(boundedAfter.payloadBytes).toBeLessThan(baselineAfter.payloadBytes * 0.3);
      expect(boundedAfter.allocatedGrowthBytes).toBeLessThan(baselineAfter.allocatedGrowthBytes * 0.3);
      expect({ baseline: baselineAfter, bounded: boundedAfter }).toEqual({
        baseline: { allocatedGrowthBytes: 1_081_344, payloadBytes: 724_103, rows: 5_122 },
        bounded: { allocatedGrowthBytes: 102_400, payloadBytes: 77_333, rows: 131 }
      });
    } finally {
      baseline.db.close();
      bounded.db.close();
    }
  });
});

function benchmarkEvents(): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (let index = 0; index < 4_096; index += 1) {
    const text = `message-${String(index).padStart(4, "0")}\n`;
    events.push({
      provider: "codex",
      type: "text",
      session,
      text,
      raw: { method: "item/agentMessage/delta", payload: JSON.stringify({ delta: text }) }
    });
  }
  for (let index = 0; index < 1_024; index += 1) {
    events.push({
      provider: "codex",
      type: "raw",
      session,
      payload: `diff-${index}`,
      raw: { method: "turn/diff/updated", payload: JSON.stringify({ diff: `diff-${index}` }) }
    });
  }
  events.push({
    provider: "codex",
    type: "raw",
    session,
    raw: {
      method: "item/completed",
      payload: JSON.stringify({ item: { id: "message-final", type: "agentMessage", text: "final answer", phase: "final_answer" } })
    }
  });
  events.push({ provider: "codex", type: "done", session, status: "completed", raw: { method: "turn/completed", payload: "completed" } });
  return events;
}

async function fixture(name: string): Promise<{ db: RunnerDatabase; issueID: number }> {
  const root = await mkdtemp(join(tmpdir(), `issue-log-benchmark-${name}-`));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [name, name, `/tmp/${name}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  db.sqlite.run(
    "insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [name, "Storage benchmark", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const issueID = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()!.id;
  return { db, issueID };
}

function storage(db: RunnerDatabase, issueID: number, allocatedBefore: number): {
  allocatedGrowthBytes: number;
  payloadBytes: number;
  rows: number;
} {
  const row = db.sqlite.query<{ bytes: number; rows: number }, [number]>(`
    select count(*) as rows, coalesce(sum(length(cast(payload as blob))), 0) as bytes
    from issue_events where issue_id=? and type='issue.log'
  `).get(issueID)!;
  return {
    allocatedGrowthBytes: allocatedBytes(db) - allocatedBefore,
    payloadBytes: Number(row.bytes),
    rows: Number(row.rows)
  };
}

function allocatedBytes(db: RunnerDatabase): number {
  return db.sqlite.query<{ bytes: number }, []>(`
    select page_count * page_size as bytes from pragma_page_count(), pragma_page_size()
  `).get()!.bytes;
}
