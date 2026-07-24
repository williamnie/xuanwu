import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { normalizedRunEvent } from "../../providers/runEvents.ts";
import { getRun } from "./runs.ts";
import {
  rebuildRunProgressProjection,
  runProgressProjectionStatus
} from "./runProgress.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Run progress repository", () => {
  test("rebuilds provider phase summaries, latest progress, timeline and stalled signal from raw events", async () => {
    const db = await openFixtureDatabase();
    try {
      const { issueID, runID } = insertRunningRun(db);
      insertRunEvent(db, issueID, "2026-01-01T00:05:00.000Z", "progress", "running", "item/completed", "step complete");
      insertRunEvent(db, issueID, "2026-01-01T00:01:00.000Z", "started", "running", "turn/started", "turn started");
      insertRunEvent(db, issueID, "2026-01-01T00:06:00.000Z", "progress", "running", "item/completed", "step complete");
      insertMalformedRunEvent(db, issueID, "2026-01-01T00:07:00.000Z");

      const projection = rebuildRunProgressProjection(db, runID, {
        now: new Date("2026-01-01T00:30:00.000Z"),
        stalledAfterMs: 10 * 60 * 1000
      });
      const detail = getRun(db, runID);

      expect(projection).toMatchObject({
        invalid_event_count: 1,
        latest: { kind: "progress", summary: "step complete" },
        projection_mode: "read_through_rebuild",
        provider_phase: "running",
        replay: {
          duplicate_event_count: 1,
          source_event_count: 4,
          unique_event_count: 2,
          unmapped_event_count: 0
        },
        source_of_truth: "issue_runs+run_attempts+issue_events",
        stalled: {
          detected: true,
          reason: "no_progress_for_threshold",
          since: "2026-01-01T00:05:00.000Z"
        },
        timeline: [{ event_count: 2, phase: "running" }]
      });
      expect(projection?.phase_summary).toMatchObject([{ event_count: 2, phase: "running" }]);
      expect(detail?.progress).toMatchObject({
        attempt_status: "running",
        latest: { source_event_id: expect.any(Number) },
        phase: "running",
        provider_phase: "running"
      });
    } finally {
      db.close();
    }
  });

  test("treats approval wait as attention rather than a stalled execution", async () => {
    const db = await openFixtureDatabase();
    try {
      const { issueID, runID } = insertRunningRun(db);
      insertRunEvent(
        db,
        issueID,
        "2026-01-01T00:01:00.000Z",
        "approval_requested",
        "waiting_approval",
        "approval/requested",
        "approval required"
      );
      const latestNormalizedID = db.sqlite.query<{ id: number }, []>(
        "select max(id) as id from issue_events"
      ).get()?.id ?? 0;
      db.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
        [issueID, JSON.stringify({ type: "raw", text: "newer non-normalized event" }), "2026-01-01T00:02:00.000Z"]
      );

      const projection = rebuildRunProgressProjection(db, runID, {
        now: new Date("2026-01-01T01:00:00.000Z"),
        stalledAfterMs: 10 * 60 * 1000
      });

      expect(projection).toMatchObject({
        provider_phase: "waiting_approval",
        stalled: { detected: false, reason: "waiting_approval" }
      });
      expect(runProgressProjectionStatus(db, new Date("2026-01-01T01:00:00.000Z"))).toMatchObject({
        active_runs: 1,
        latest_source_event_id: latestNormalizedID,
        stalled_runs: 0,
        status: "ready",
        waiting_approval_runs: 1
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-run-progress-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertRunningRun(db: RunnerDatabase): { issueID: number; runID: `xw:run:issue_runs:${string}` } {
  const at = "2026-01-01T00:00:00.000Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values ('demo', 'demo', '/tmp/demo', 'codex', 0, ?, ?)`,
    [at, at]
  );
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values ('demo', 'Progress fixture', 'in_progress', ?, ?)`,
    [at, at]
  );
  const issueID = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()!.id;
  const legacyID = `issue-${issueID}-attempt-1`;
  db.sqlite.run(
    `insert into issue_runs (
      id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
      started_at, ended_at, exit_reason, error
    ) values (?, ?, 1, 'in_progress', 'codex', 'thread-1', 'turn-1', ?, '', '', '')`,
    [legacyID, issueID, at]
  );
  return { issueID, runID: `xw:run:issue_runs:${legacyID}` };
}

function insertRunEvent(
  db: RunnerDatabase,
  issueID: number,
  createdAt: string,
  kind: Parameters<typeof normalizedRunEvent>[0]["kind"],
  outcome: Parameters<typeof normalizedRunEvent>[0]["outcome"],
  method: string,
  text: string
): void {
  const runEvent = normalizedRunEvent({
    kind,
    method,
    outcome,
    provider: "codex",
    session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" }
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({ provider: "codex", raw_method: method, run_event: runEvent, text }), createdAt]
  );
}

function insertMalformedRunEvent(db: RunnerDatabase, issueID: number, createdAt: string): void {
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({
      run_event: {
        contract: "xw.run-event.v1",
        kind: "completed",
        metadata: {},
        outcome: "failed",
        provider: "codex",
        source: { method: "bad", ref: "bad" },
        terminal: true
      }
    }), createdAt]
  );
}
