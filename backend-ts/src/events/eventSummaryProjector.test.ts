import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  getEventProjectionWatermark,
  listEventSummaryProjection,
  listSourceIssueEvents,
  upsertEventSummaryProjection
} from "../db/repositories/eventSummaryProjection.ts";
import {
  persistPlannedIssueLogArtifact,
  planIssueLogPayloadExternalization
} from "../db/repositories/issueEvents.ts";
import { queryEventSummaries } from "./eventSummaryQuery.ts";
import { projectPendingEventSummaries, projectSourceIssueEvent } from "./eventSummaryProjector.ts";
import {
  clearCompactEventSummaryProjection,
  listCompactEventSummaryProjection,
  projectPendingCompactEventSummaries,
  updateEventSummaryProjectionSwitch
} from "../db/repositories/compactEventSummaryProjection.ts";
import { createDefaultRouter } from "../http/server.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("event summary projector", () => {
  test("replays the same batch idempotently and resumes from its committed watermark", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssueEvents(db);
      const first = projectPendingEventSummaries(db, { batchSize: 2, maxBatches: 1 });

      expect(first).toMatchObject({ batches: 1, paused: true, projected_rows: 2 });
      expect(first.watermark).toMatchObject({ last_event_id: 2, projected_row_count: 2 });

      const resumed = projectPendingEventSummaries(db, { batchSize: 2 });
      const beforeReplay = listEventSummaryProjection(db);
      expect(resumed).toMatchObject({ batches: 1, paused: false, projected_rows: 2 });
      expect(resumed.watermark).toMatchObject({ last_event_id: 4, projected_row_count: 4 });

      db.sqlite.run(`update event_projection_watermarks
        set last_event_id=0, projected_row_count=0 where projection_id='issue_events_summary_v1'`);
      const replay = projectPendingEventSummaries(db, { batchSize: 4 });

      expect(replay).toMatchObject({ batches: 1, paused: false, projected_rows: 4 });
      expect(listEventSummaryProjection(db)).toEqual(beforeReplay);
      expect(queryEventSummaries(db, { issueID }).items).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  test("keeps non-log facts exact while bounding raw issue.log summaries", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssueEvents(db);
      const result = queryEventSummaries(db, { issueID });
      const created = result.items.find((item) => item.type === "issue.created");
      const log = result.items.find((item) => item.type === "issue.log");

      expect(result).toMatchObject({
        schema_version: "xuanwu.event-summary-query.v1",
        source_of_truth: "issue_events",
        watermark: { last_event_id: 4, lag_rows: 0, status: "ready" }
      });
      expect(created?.payload).toBe('{"title":"Projection fixture"}');
      expect(created?.summary_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(log).toMatchObject({
        raw_method: "item/agentMessage/delta",
        policy_id: "raw_operational",
        retention_tier: "R1_OPERATIONAL"
      });
      expect(JSON.parse(log?.payload ?? "{}")).toEqual({
        type: "agent_message_delta",
        raw_method: "item/agentMessage/delta",
        text: "x".repeat(16 * 1024)
      });
      expect(Buffer.byteLength(log?.payload ?? "")).toBeLessThan(log?.source_payload_bytes ?? 0);
      expect(log?.source_sha256).toMatch(/^[a-f0-9]{64}$/);

      const raw = db.sqlite.query<{ payload: string }, [number]>(
        "select payload from issue_events where id=?"
      ).get(log!.source_event_id);
      expect(JSON.parse(raw?.payload ?? "{}").text.startsWith(JSON.parse(log!.payload).text)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("serves cursor metadata and filtered summaries through the query API", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssueEvents(db);
      const router = createDefaultRouter({ database: db });
      const response = await router.handle(new Request(
        `http://127.0.0.1:3008/api/issues/${issueID}/event-summaries?exclude_type=issue.log&limit=2`
      ));
      const body = await response.json() as {
        items: Array<Record<string, unknown>>;
        watermark: Record<string, unknown>;
      };

      expect(response.status).toBe(200);
      expect(body.items.map((item: Record<string, unknown>) => item.type)).toEqual([
        "issue.status_changed",
        "issue.comment"
      ]);
      expect(body.watermark).toMatchObject({ last_event_id: 4, projected_row_count: 4, lag_rows: 0 });
      expect(getEventProjectionWatermark(db).last_event_id).toBe(4);
      const missing = await router.handle(new Request(
        "http://127.0.0.1:3008/api/issues/999/event-summaries"
      ));
      expect(missing.status).toBe(404);
    } finally {
      db.close();
    }
  });

  test("dual-reads compact rows and fails closed on a parity conflict", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssueEvents(db);
      projectPendingEventSummaries(db);
      projectPendingCompactEventSummaries(db);
      updateEventSummaryProjectionSwitch(db, {
        cutover_at: "",
        expectedRevision: 0,
        observation_expires_at: "2099-01-02T00:00:00.000Z",
        observation_started_at: "2026-01-01T00:00:00.000Z",
        read_version: "v1",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });

      expect(queryEventSummaries(db, { issueID }).items).toHaveLength(4);
      db.sqlite.run("delete from event_summary_projection_compact where source_event_id=2");
      expect(() => queryEventSummaries(db, { issueID })).toThrow("event summary projection parity conflict");
    } finally {
      db.close();
    }
  });

  test("retains the V1 stored-reference compatibility mode across compact rebuilds", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssueEvents(db);
      const original = JSON.stringify({
        raw_method: "item/completed",
        text: "large output ".repeat(8_000),
        type: "tool"
      });
      const plan = planIssueLogPayloadExternalization(original, 0)!;
      persistPlannedIssueLogArtifact(db, plan);
      db.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
        [issueID, plan.stored_payload, "2026-01-01T00:00:04Z"]
      );
      projectPendingEventSummaries(db);
      const storedSource = listSourceIssueEvents(db, {
        afterID: 4,
        hydrateIssueLogs: false,
        limit: 1
      })[0]!;
      upsertEventSummaryProjection(db, projectSourceIssueEvent(storedSource, "2026-01-01T00:00:05Z"));

      projectPendingCompactEventSummaries(db);

      expect(listCompactEventSummaryProjection(db, { issueID })).toEqual(
        listEventSummaryProjection(db, { issueID }).map((row) => ({ ...row, projected_at: "" }))
      );
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from event_summary_projection_compat_modes"
      ).get()?.count).toBe(1);
      clearCompactEventSummaryProjection(db);
      projectPendingCompactEventSummaries(db);
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from event_summary_projection_compat_modes"
      ).get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "event-summary-projector-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedIssueEvents(db: RunnerDatabase): number {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  db.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
    values ('demo', 'Projection fixture', 'in_progress', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
  const insert = db.sqlite.query(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)"
  );
  insert.run(issueID, "issue.created", '{"title":"Projection fixture"}', "2026-01-01T00:00:00Z");
  insert.run(issueID, "issue.log", JSON.stringify({
    type: "agent_message_delta",
    raw_method: "item/agentMessage/delta",
    text: "x".repeat(32 * 1024),
    raw_payload: "must-not-enter-summary"
  }), "2026-01-01T00:00:01Z");
  insert.run(issueID, "issue.status_changed", '{"status":"done"}', "2026-01-01T00:00:02Z");
  insert.run(issueID, "issue.comment", '{"author":"user","body":"keep exact"}', "2026-01-01T00:00:03Z");
  return issueID;
}
