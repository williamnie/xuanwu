import { expect, test } from "bun:test";

import { getIssue } from "../db/repositories/issues.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";

import { runAutoRunIssueWatchdogOnce } from "./issueWatchdog.ts";
import { isProjectLoopActive } from "./projectLoopManager.ts";

import {
  NOW,
  STALE,
  fixtureDatabase,
  FixtureProvider,
  insertProject,
  insertIssue,
  addDependency,
  watchdog,
  resetClaimToSameTodoState,
  eventTypes,
  latestPayload,
  waitFor
} from "./issueWatchdogTestFixtures.ts";

export function registerIssueWatchdogReadinessCases() {
  test("keeps long dependency waits bounded, dedupes blocker Attention, then auto-recovers", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    insertProject(db, "demo", provider.id);
    const blocker = insertIssue(db, "blocker", "in_progress");
    const waiting = insertIssue(db, "waiting", "todo");
    addDependency(db, waiting, blocker);

    for (let hour = 0; hour < 24; hour += 1) {
      const result = await watchdog(db, provider, new Date(NOW.getTime() + hour * 60 * 60 * 1000));
      expect(result).toMatchObject({ kicked: 0, waiting: 1 });
    }

    expect(eventTypes(db, waiting).filter((type) => type === "issue.watchdog_waiting")).toHaveLength(1);
    expect(eventTypes(db, waiting)).not.toContain("issue.watchdog_kicked");
    expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

    db.sqlite.run("update issues set status='failed', updated_at=? where id=?", [NOW.toISOString(), blocker]);
    await watchdog(db, provider, new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    await watchdog(db, provider, new Date(NOW.getTime() + 26 * 60 * 60 * 1000));
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);
    expect(listNotifications(db, { projectID: "demo" })).toEqual([]);

    db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW.toISOString(), blocker]);
    const recovered = await watchdog(db, provider, new Date(NOW.getTime() + 27 * 60 * 60 * 1000));
    expect(recovered).toMatchObject({ kicked: 1, waiting: 0 });
    await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
    expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);
  });

  test("retries a runnable issue three times before asking the user once", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    insertProject(db, "demo", provider.id);
    const issueID = insertIssue(db, "stuck", "todo");
    const originalUpdatedAt = getIssue(db, issueID)?.updated_at ?? STALE;

    const first = await watchdog(db, provider, NOW, 60_000);
    expect(first.kicked).toBe(1);
    await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
    resetClaimToSameTodoState(db, issueID, originalUpdatedAt);

    const second = await watchdog(db, provider, new Date(NOW.getTime() + 61_000), 60_000);
    expect(second).toMatchObject({ escalated: 0, kicked: 1 });
    await waitFor(() => provider.inputs.length === 2 && !isProjectLoopActive("demo"));
    resetClaimToSameTodoState(db, issueID, originalUpdatedAt);

    const third = await watchdog(db, provider, new Date(NOW.getTime() + 2 * 61_000), 60_000);
    expect(third).toMatchObject({ escalated: 0, kicked: 1 });
    await waitFor(() => provider.inputs.length === 3 && !isProjectLoopActive("demo"));
    resetClaimToSameTodoState(db, issueID, originalUpdatedAt);

    const escalated = await watchdog(db, provider, new Date(NOW.getTime() + 3 * 61_000), 60_000);
    const duplicate = await watchdog(db, provider, new Date(NOW.getTime() + 5 * 60_000), 60_000);
    expect(escalated).toMatchObject({ attentioned: 1, escalated: 1, kicked: 0 });
    expect(duplicate).toMatchObject({ attentioned: 0, escalated: 0, kicked: 0 });
    expect(listNotifications(db, { projectID: "demo" })).toHaveLength(1);
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);
    expect(eventTypes(db, issueID).filter((type) => type === "issue.watchdog_kicked")).toHaveLength(3);
    expect(eventTypes(db, issueID).filter((type) => type === "issue.watchdog_needs_user")).toHaveLength(1);

    db.sqlite.run("update issues set updated_at=? where id=?", ["2026-07-19T01:00:00.000Z", issueID]);
    const reactivated = await watchdog(db, provider, new Date(NOW.getTime() + 6 * 60_000), 60_000);
    expect(reactivated.kicked).toBe(1);
    await waitFor(() => provider.inputs.length === 4 && !isProjectLoopActive("demo"));
  });

  test("kicks a fresh deferred todo as soon as provider cooldown expires", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const deferred = insertIssue(db, "retry provider startup", "todo");
      db.sqlite.run(`update issues set updated_at=?, auto_retry_next_at=?,
        auto_retry_reason=?, error=? where id=?`, [
        NOW.toISOString(),
        new Date(NOW.getTime() + 30_000).toISOString(),
        `provider_infra_transient:${provider.id}`,
        "codex thread/start timed out",
        deferred
      ]);

      const waiting = await runAutoRunIssueWatchdogOnce({
        database: db,
        now: new Date(NOW.getTime() + 29_999),
        providers: { [provider.id]: provider },
        staleAfterMs: 60_000
      });
      expect(waiting).toMatchObject({ candidates: 0, kicked: 0 });
      expect(provider.inputs).toEqual([]);

      const due = await runAutoRunIssueWatchdogOnce({
        database: db,
        now: new Date(NOW.getTime() + 30_000),
        providers: { [provider.id]: provider },
        staleAfterMs: 60_000
      });
      expect(due).toMatchObject({ candidates: 1, kicked: 1 });
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      expect(provider.inputs.map((input) => input.issueId)).toEqual([deferred]);
    } finally {
      db.close();
    }
  });

  test("keeps project hold quiet and reports provider unavailability as deduped Attention, not needs_user", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const waiting = insertIssue(db, "held then provider unavailable", "todo");
      db.sqlite.run(`insert into project_holds
        (project_id, reason, message, hold_since, next_check_at, updated_at)
        values ('demo', 'user_pause', 'maintenance', ?, ?, ?)`, [
        STALE, "2026-07-20T00:10:00.000Z", STALE
      ]);

      const held = await runAutoRunIssueWatchdogOnce({
        database: db, now: NOW, providers: {}, staleAfterMs: 60_000
      });
      expect(held).toMatchObject({ attentioned: 0, kicked: 0, waiting: 1 });
      expect(latestPayload(db, waiting, "issue.watchdog_waiting")).toMatchObject({
        next_check_at: "2026-07-20T00:10:00.000Z",
        not_runnable_reason: "project_hold",
        root_blocker: { project_id: "demo", reason: "user_pause" }
      });

      db.sqlite.run("delete from project_holds where project_id='demo'");
      const unavailable = await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 60_000), providers: {}, staleAfterMs: 60_000
      });
      const duplicate = await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 2 * 60_000), providers: {}, staleAfterMs: 60_000
      });
      expect(unavailable).toMatchObject({ attentioned: 1, kicked: 0, waiting: 1 });
      expect(duplicate).toMatchObject({ attentioned: 0, kicked: 0, waiting: 1 });
      expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);

      const recovered = await watchdog(db, provider, new Date(NOW.getTime() + 3 * 60_000));
      expect(recovered.kicked).toBe(1);
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

      resetClaimToSameTodoState(db, waiting, STALE);
      const reactivated = await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 4 * 60_000), providers: {}, staleAfterMs: 60_000
      });
      expect(reactivated).toMatchObject({ attentioned: 1, kicked: 0, waiting: 1 });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);

      db.sqlite.run("update pi_guardian_alerts set status='acked' where project_id='demo'");
      db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW.toISOString(), waiting]);
      await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 5 * 60_000), providers: {}, staleAfterMs: 60_000
      });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "acked" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(2);
    } finally {
      db.close();
    }
  });
}
