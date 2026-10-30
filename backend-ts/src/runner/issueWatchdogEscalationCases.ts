import { expect, test } from "bun:test";

import { listNotifications } from "../db/repositories/notifications.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";

import { isProjectLoopActive, setProjectLoopMaxParallelProjects } from "./projectLoopManager.ts";

import {
  NOW,
  STALE,
  fixtureDatabase,
  FixtureProvider,
  insertProject,
  insertIssue,
  insertOpenRun,
  watchdog,
  eventTypes,
  latestPayload,
  waitFor
} from "./issueWatchdogTestFixtures.ts";

export function registerIssueWatchdogEscalationCases() {
  test("keeps a queued issue quiet while the same project already has active work", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    setProjectLoopMaxParallelProjects(3);
    insertProject(db, "demo", provider.id);
    const running = insertIssue(db, "running", "in_progress");
    insertOpenRun(db, running, provider.id, STALE);
    const queued = insertIssue(db, "queued", "todo");

    for (let minute = 0; minute < 10; minute += 1) {
      const result = await watchdog(db, provider, new Date(NOW.getTime() + minute * 60_000));
      expect(result).toMatchObject({ escalated: 0, kicked: 0, skippedBusy: 1, waiting: 1 });
    }

    expect(provider.inputs).toEqual([]);
    expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);
    expect(latestPayload(db, queued, "issue.watchdog_waiting")).toMatchObject({
      not_runnable_reason: "project_serial_wait",
      root_blocker: [expect.objectContaining({ issue_id: running })]
    });
  });

  test("records one capacity wait without needs_user noise and kicks after capacity releases", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    insertProject(db, "busy", provider.id);
    insertProject(db, "demo", provider.id);
    const busy = insertIssue(db, "running", "in_progress", "busy");
    insertOpenRun(db, busy, provider.id, STALE);
    const waiting = insertIssue(db, "capacity wait", "todo");

    for (let minute = 0; minute < 10; minute += 1) {
      const result = await watchdog(db, provider, new Date(NOW.getTime() + minute * 60_000));
      expect(result).toMatchObject({ kicked: 0, skippedBusy: 1, waiting: 1 });
    }
    expect(eventTypes(db, waiting).filter((type) => type === "issue.watchdog_waiting")).toHaveLength(1);
    expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

    db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW.toISOString(), busy]);
    db.sqlite.run("update issue_runs set status='done', ended_at=? where issue_id=?", [NOW.toISOString(), busy]);
    const released = await watchdog(db, provider, new Date(NOW.getTime() + 11 * 60_000));
    expect(released.kicked).toBe(1);
    await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
    expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
  });

  test("alerts once when a terminal provider Session leaves an in-progress Issue and open Run", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const issueID = insertIssue(db, "terminal mismatch", "in_progress");
      insertOpenRun(db, issueID, provider.id, STALE);
      db.sqlite.run(
        "update issue_runs set provider_session_id=?, provider_turn_id=? where issue_id=?",
        ["thread-terminal", "turn-terminal", issueID]
      );
      db.sqlite.run(
        `insert into agent_sessions
          (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
         values (?, ?, ?, 'demo', ?, 'completed', ?, ?, ?)`,
        [
          `${provider.id}:thread-terminal`,
          provider.id,
          "thread-terminal",
          issueID,
          JSON.stringify({ provider_turn_id: "turn-terminal" }),
          STALE,
          STALE
        ]
      );

      const first = await watchdog(db, provider, NOW);
      const duplicate = await watchdog(db, provider, new Date(NOW.getTime() + 30_000));

      expect(first).toMatchObject({ attentioned: 1, candidates: 1, escalated: 1, scanned: 1 });
      expect(duplicate).toMatchObject({ attentioned: 0, escalated: 0 });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toContainEqual(
        expect.objectContaining({
          alert_type: "issue_runtime_mismatch_terminal_session_open_run",
          issue_id: issueID
        })
      );
      expect(listNotifications(db, { projectID: "demo" })).toContainEqual(
        expect.objectContaining({ event: "pi.needs_user", issue_id: issueID })
      );
      expect(eventTypes(db, issueID)).toContain("issue.watchdog_runtime_mismatch");

      db.sqlite.run(
        "update issues set status='pending_verification', updated_at=? where id=?",
        [NOW.toISOString(), issueID]
      );
      db.sqlite.run(
        "update issue_runs set status='done', ended_at=? where issue_id=?",
        [NOW.toISOString(), issueID]
      );
      await watchdog(db, provider, new Date(NOW.getTime() + 60_000));
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
}
