import { expect, test } from "bun:test";

import {
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
  compactProjectionStatus,
  listCompactEventSummaryProjection,
  projectPendingCompactEventSummaries,
  updateEventSummaryProjectionSwitch
} from "../db/repositories/compactEventSummaryProjection.ts";

import { BackgroundProjectionWorker } from "./projectionWorker.ts";
import { retireLegacyEventSummaryProjection } from "./compactEventSummaryProjectionService.ts";

import { fixtureDatabase, seedIssueEvents } from "./eventSummaryProjectorTestFixtures.ts";

export function registerEventSummaryProjectorReadsCases() {
  test("uses the persisted compact watermark when the V2 reader is active", async () => {
    const db = await fixtureDatabase();
    const issueID = seedIssueEvents(db);
    const projected = projectPendingCompactEventSummaries(db);
    updateEventSummaryProjectionSwitch(db, {
      cutover_at: "2026-01-02T00:00:00.000Z",
      expectedRevision: 0,
      observation_expires_at: "2026-01-02T00:00:00.000Z",
      observation_started_at: "2026-01-01T00:00:00.000Z",
      read_version: "v2",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    expect(projected.watermark).toMatchObject({ last_event_id: 4, projected_row_count: 4 });
    expect(projectPendingCompactEventSummaries(db)).toMatchObject({
      batches: 0,
      paused: false,
      projected_rows: 0,
      watermark: { last_event_id: 4, projected_row_count: 4 }
    });
    expect(compactProjectionStatus(db)).toMatchObject({
      last_event_id: 4,
      projected_row_count: 4,
      status: "ready"
    });
    expect(queryEventSummaries(db, { issueID }).watermark).toMatchObject({
      projection_id: "issue_events_summary_v2",
      last_event_id: 4,
      projected_row_count: 4
    });
  });

  test("retains the V1 stored-reference compatibility mode across compact rebuilds", async () => {
    const db = await fixtureDatabase();
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
  });

  test("keeps compact summaries readable after raw source events move to cold archive", async () => {
    const db = await fixtureDatabase();
    const issueID = seedIssueEvents(db);
    projectPendingCompactEventSummaries(db);
    const before = listCompactEventSummaryProjection(db, { issueID });

    db.sqlite.run("delete from issue_events where issue_id=?", [issueID]);

    expect(listCompactEventSummaryProjection(db, { issueID })).toEqual(before);
    expect(before.map((row) => row.event_created_at)).toEqual([
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:01Z",
      "2026-01-01T00:00:02Z",
      "2026-01-01T00:00:03Z"
    ]);
  });

  test("associates an event with a run across mixed ISO timestamp precision", async () => {
    const db = await fixtureDatabase();
    const issueID = seedIssueEvents(db);
    db.sqlite.run(`insert into issue_runs (
        id, issue_id, attempt, status, started_at, ended_at
      ) values (?, ?, 1, 'done', ?, ?)`, [
      "issue-run-mixed-timestamp-precision",
      issueID,
      "2026-01-01T00:00:02.500Z",
      "2026-01-01T00:00:03.500Z"
    ]);

    expect(listSourceIssueEvents(db, { afterID: 3, limit: 1 })[0]?.run_id)
      .toBe("issue-run-mixed-timestamp-precision");
  });

  test("preserves the legacy run association while rebuilding the compact projection", async () => {
    const db = await fixtureDatabase();
    const issueID = seedIssueEvents(db);
    projectPendingEventSummaries(db);
    db.sqlite.run(`insert into issue_runs (
        id, issue_id, attempt, status, started_at, ended_at
      ) values (?, ?, 1, 'done', ?, ?)`, [
      "issue-run-created-after-v1-projection",
      issueID,
      "2026-01-01T00:00:02.500Z",
      "2026-01-01T00:00:03.500Z"
    ]);

    projectPendingCompactEventSummaries(db);

    const legacy = listEventSummaryProjection(db, { issueID }).find((row) => row.source_event_id === 4);
    const compact = listCompactEventSummaryProjection(db, { issueID }).find((row) => row.source_event_id === 4);
    expect(legacy?.run_id).toBe("");
    expect(compact?.run_id).toBe(legacy?.run_id);
  });

  test("retires legacy projection after V2 cutover and does not rebuild it in the background", async () => {
    const db = await fixtureDatabase();
    const issueID = seedIssueEvents(db);
    projectPendingEventSummaries(db);
    projectPendingCompactEventSummaries(db);
    updateEventSummaryProjectionSwitch(db, {
      cutover_at: "2026-01-02T00:00:00.000Z",
      expectedRevision: 0,
      observation_expires_at: "2026-01-02T00:00:00.000Z",
      observation_started_at: "2026-01-01T00:00:00.000Z",
      read_version: "v2",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    const retired = retireLegacyEventSummaryProjection({
      actor: "operator",
      actorKind: "user",
      apply: true,
      auditRef: "pi_action_events:legacy-retire-test",
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath: db.path,
      reason: "focused compact projection retirement test"
    });
    expect(retired).toMatchObject({ applied: true, after: { legacy_rows: 0 } });

    db.sqlite.run(
      "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.comment', '{}', ?)",
      [issueID, "2026-01-01T00:00:04Z"]
    );
    new BackgroundProjectionWorker(db).runOnce();

    expect(listEventSummaryProjection(db, { issueID })).toHaveLength(0);
    expect(listCompactEventSummaryProjection(db, { issueID })).toHaveLength(5);
  });
}
