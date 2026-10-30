import { expect, test } from "bun:test";

import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  listPiActions,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";

import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";

import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

import {
  NOW,
  fixtureDb,
  tempRoot,
  insertProject,
  insertRunningIssue,
  validDecision,
  noopDecision,
  needsUserDecision
} from "./piIssueSupervisorSchedulerTestFixtures.ts";

export function registerPiIssueSupervisorSchedulerMaintenanceCases() {
  test("asks PI instead of deterministically retrying a failed transient issue", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-deterministic-transient-retry-"));
    upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: ["issue.retry"],
      project_id: "demo"
    });
    insertRunningIssue(db, {
      issueID: 510,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-510",
      turnID: "turn-510"
    });
    db.sqlite.run(
      "update issues set status='failed', error=? where id=510",
      ["needs_user: session_no_recent_progress\nXuanwu Supervisor failed to return a valid decision. Check the configured Agent/model/provider and its decision audit before retrying."]
    );
    db.sqlite.run(
      "update issue_runs set status='failed', ended_at='2026-06-10T07:50:00Z' where issue_id=510"
    );

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      providers: { codex: {
        id: "codex", capabilities: ["sessions"], run: async () => ({ runId: "unused" }),
        listSessionTurns: async () => { throw new Error("terminal failures use the existing PI path"); }
      } },
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      },
      now: NOW,
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
    expect(calls).toBe(1);
    expect(db.sqlite.query<{ status: string }, [number]>(
      "select status from issues where id=?"
    ).get(510)).toEqual({ status: "failed" });
    expect(listIssueSupervisorEvents(db, { issueId: 510 }).map((event) => event.event_type))
      .toEqual(["signal", "decision", "action", "result"]);
    expect(listPiActions(db, { issueId: 510 })).toContainEqual(expect.objectContaining({
      action_type: "issue.supervisor_decision",
      status: "completed"
    }));
  });

  test("re-enters PI after a failed recovery action instead of suppressing the issue forever", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-failed-action-reentry-"));
    insertRunningIssue(db, {
      issueID: 511,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-511",
      turnID: "turn-511"
    });
    db.sqlite.run("update agent_sessions set status='completed' where session_key='codex:thread-511'");
    createIssueSupervisorEvent(db, {
      action_id: "failed-retry-511",
      action_type: "issue.retry",
      decision: "retry_issue",
      diagnosis_code: "session_no_recent_progress",
      event_type: "action",
      issue_id: 511,
      project_id: "demo",
      created_at: "2026-06-10T07:50:00Z"
    });
    createIssueSupervisorEvent(db, {
      action_id: "failed-retry-511",
      action_type: "issue.retry",
      decision: "retry_issue",
      diagnosis_code: "session_no_recent_progress",
      event_type: "result",
      issue_id: 511,
      payload_json: { error: "thread not found", outcome: "failed" },
      project_id: "demo",
      created_at: "2026-06-10T07:50:01Z"
    });

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async (context) => {
        calls += 1;
        expect(context.recovery_history.last_outcome).toBe("failed");
        return validDecision(needsUserDecision("The retry failed and user configuration is required."));
      },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1, skipped: 0 });
    expect(calls).toBe(1);
    expect(listIssueSupervisorEvents(db, { issueId: 511 }).map((event) => event.event_type))
      .toEqual(["action", "result", "signal", "decision", "action", "result"]);
  });

  test("honors recovery cooldown before asking PI for another decision", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-cooldown-project-"));
    upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: ["issue.supervisor_decision"],
      project_id: "demo",
      supervisor_cooldown_seconds: 300
    });
    insertRunningIssue(db, {
      issueID: 506,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-506",
      turnID: "turn-506"
    });
    db.sqlite.run("update agent_sessions set status='idle' where session_key='codex:thread-506'");
    createIssueSupervisorEvent(db, {
      action_type: "issue.retry",
      event_type: "action",
      issue_id: 506,
      project_id: "demo"
    });
    recordPiRecoveryAttempt(db, {
      action_type: "issue.retry",
      budget_window_started_at: "2026-06-09T08:00:00Z",
      created_at: "2026-06-10T07:59:00Z",
      diagnosis_code: "session_no_recent_progress",
      id: "cooldown-506",
      idempotency_key: "cooldown-506",
      issue_id: 506,
      project_id: "demo",
      status: "progress",
      updated_at: "2026-06-10T07:59:00Z"
    });
    const runDecision = async () => {
      calls += 1;
      return validDecision(noopDecision());
    };

    const waiting = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision,
      staleAfterSeconds: 300
    });
    const due = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: new Date("2026-06-10T08:05:01Z"),
      runDecision,
      staleAfterSeconds: 300
    });

    expect(waiting).toMatchObject({ decisions: 0, signaled: 0 });
    expect(due).toMatchObject({ decisions: 1, signaled: 1 });
    expect(calls).toBe(1);
  });
}
