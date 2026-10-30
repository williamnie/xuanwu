import { expect, test } from "bun:test";

import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  listPiActions,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";

import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

import {
  NOW,
  fixtureDb,
  tempRoot,
  insertProject,
  insertRunningIssue,
  insertIssueEvent,
  validDecision,
  noopDecision
} from "./piIssueSupervisorSchedulerTestFixtures.ts";

export function registerPiIssueSupervisorSchedulerRecoveryCases() {
  test("does not let a legacy action after an invalid decision suppress recovery forever", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-legacy-invalid-action-project-"));
    upsertProjectPiPolicy(db, {
      project_id: "demo",
      supervisor_cooldown_seconds: 300
    });
    insertRunningIssue(db, {
      issueID: 508,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-508",
      turnID: "turn-508"
    });
    insertIssueEvent(db, 508, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
    createIssueSupervisorEvent(db, {
      decision: "needs_user",
      diagnosis_code: "executor_stream_disconnected",
      event_type: "decision_failed",
      issue_id: 508,
      project_id: "demo"
    });
    createIssueSupervisorEvent(db, {
      action_type: "needs_user.escalate",
      decision: "needs_user",
      diagnosis_code: "executor_stream_disconnected",
      event_type: "action",
      issue_id: 508,
      project_id: "demo"
    });
    db.sqlite.run(
      "update issue_supervisor_events set created_at=? where issue_id=?",
      ["2026-06-10T07:50:00Z", 508]
    );

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, signaled: 1, skipped: 0 });
    expect(calls).toBe(1);
  });

  test("does not enter the Supervisor decision boundary while the singleton is disabled", async () => {
    const db = await fixtureDb();
    insertProject(db, "demo", await tempRoot("supervisor-unavailable-project-"));
    db.sqlite.run("update pi_agents set enabled=0 where id='runner-default'");
    insertRunningIssue(db, {
      issueID: 502,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-502",
      turnID: "turn-502"
    });
    insertIssueEvent(db, 502, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 0, signaled: 0 });
    expect(listPiActions(db, { issueId: 502 })).toEqual([]);
    expect(listIssueSupervisorEvents(db, { issueId: 502 })).toEqual([]);
  });

  test("normally active sessions do not call PI", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-skip-project-"));
    insertRunningIssue(db, {
      issueID: 503,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:59:30Z",
      threadID: "thread-503",
      turnID: "turn-503"
    });

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 0, signaled: 0 });
    expect(calls).toBe(0);
  });

  test("recent Provider events prevent a false stale disconnect even when session projection is old", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-recent-provider-event-"));
    insertRunningIssue(db, {
      issueID: 520,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-520",
      turnID: "turn-520"
    });
    db.sqlite.run(
      "insert into issue_events (issue_id, type, payload, created_at) values (520, 'issue.log', ?, '2026-06-10T07:59:30Z')",
      [JSON.stringify({ command: "bun test", status: "running", text: "tests are still producing output" })]
    );

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => { calls += 1; return validDecision(noopDecision()); },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 0, signaled: 0 });
    expect(calls).toBe(0);
  });

  test("ignores stale retry metadata on a completed issue", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-completed-stale-retry-"));
    insertRunningIssue(db, {
      issueID: 509,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-509",
      turnID: "turn-509"
    });
    db.sqlite.run(
      "update issues set status='done', auto_retry_next_at='2026-06-10T07:00:00Z' where id=509"
    );
    db.sqlite.run(
      "update issue_runs set status='done', ended_at='2026-06-10T07:50:00Z' where issue_id=509"
    );

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 0, scanned: 0, signaled: 0 });
    expect(calls).toBe(0);
  });
}
