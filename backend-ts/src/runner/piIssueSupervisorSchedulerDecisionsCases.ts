import { expect, test } from "bun:test";

import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  listPiActions,
  listPiGuardianAlerts,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";

import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

import {
  NOW,
  fixtureDb,
  tempRoot,
  insertProject,
  insertRunningIssue,
  insertIssueEvent,
  validDecision,
  noopDecision,
  stateRepairDecision,
  needsUserDecision
} from "./piIssueSupervisorSchedulerTestFixtures.ts";

export function registerPiIssueSupervisorSchedulerDecisionsCases() {
  test("lets PI choose the current state-manager repair for a completed Session with an open Run", async () => {
    const db = await fixtureDb();
    insertProject(db, "demo", await tempRoot("supervisor-state-repair-project-"));
    upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: ["issue.state_repair"],
      project_id: "demo"
    });
    insertRunningIssue(db, {
      issueID: 512,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-512",
      turnID: "turn-512"
    });
    db.sqlite.run("update agent_sessions set status='completed' where session_key='codex:thread-512'");

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async (context) => {
        expect(context.state_diagnostics).toEqual([
          expect.objectContaining({
            code: "in_progress_session_ended",
            recommended_actions: [
              expect.objectContaining({
                operation: "request_pi_decision"
              })
            ]
          })
        ]);
        return validDecision(stateRepairDecision());
      },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
    expect(db.sqlite.query<{ status: string }, [number]>(
      "select status from issues where id=?"
    ).get(512)).toEqual({ status: "in_progress" });
    expect(db.sqlite.query<{ ended_at: string; status: string }, [number]>(
      "select status, ended_at from issue_runs where issue_id=?"
    ).get(512)).toMatchObject({ status: "succeeded", ended_at: expect.any(String) });
    expect(listIssueEvents(db, 512, { types: ["issue.pi_acceptance_requested.v1"] })).toHaveLength(1);
    expect(listPiActions(db, { issueId: 512 })).toContainEqual(expect.objectContaining({
      action_type: "issue.state_repair",
      gate_decision: "execute",
      status: "completed"
    }));
    expect(listIssueSupervisorEvents(db, { issueId: 512 }).map((event) => event.event_type))
      .toEqual(["signal", "decision", "action", "result"]);
  });

  test("keeps issue lifecycle unchanged when PI output is invalid", async () => {
    const db = await fixtureDb();
    insertProject(db, "demo", await tempRoot("supervisor-invalid-project-"));
    upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: ["needs_user.escalate"],
      project_id: "demo"
    });
    insertRunningIssue(db, {
      issueID: 501,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-501",
      turnID: "turn-501"
    });
    insertIssueEvent(db, 501, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
    const alarm = needsUserDecision("PI Supervisor returned invalid JSON.");

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => ({
        decision: alarm,
        error: "invalid supervisor decision JSON",
        raw_text: "not json",
        valid: false
      }),
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, failed: 1, signaled: 1 });
    expect(listPiActions(db, { issueId: 501 })).toEqual([]);
    expect(db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(501))
      .toEqual({ status: "in_progress" });
  });

  test("cooldowns an audited invalid decision before asking PI again", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-invalid-cooldown-project-"));
    upsertProjectPiPolicy(db, {
      project_id: "demo",
      supervisor_cooldown_seconds: 300
    });
    insertRunningIssue(db, {
      issueID: 507,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-507",
      turnID: "turn-507"
    });
    insertIssueEvent(db, 507, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
    createIssueSupervisorEvent(db, {
      decision: "noop",
      diagnosis_code: "executor_stream_disconnected",
      event_type: "decision_failed",
      issue_id: 507,
      project_id: "demo",
      created_at: "2026-06-10T07:59:00Z"
    });
    db.sqlite.run(
      "update issue_supervisor_events set created_at=? where issue_id=? and event_type='decision_failed'",
      ["2026-06-10T07:59:00Z", 507]
    );
    const runDecision = async () => {
      calls += 1;
      return validDecision(noopDecision());
    };

    const cooling = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision,
      staleAfterSeconds: 300
    });
    const due = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: new Date("2026-06-10T08:04:01Z"),
      runDecision,
      staleAfterSeconds: 300
    });

    expect(cooling).toMatchObject({ decisions: 0, skipped: 1 });
    expect(due).toMatchObject({ decisions: 1, signaled: 1 });
    expect(calls).toBe(1);
  });

  test("never converts repeated PI runtime errors into a deterministic Issue failure", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-invalid-budget-project-"));
    insertRunningIssue(db, {
      issueID: 513,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-513",
      turnID: "turn-513"
    });
    db.sqlite.run("update agent_sessions set status='completed' where session_key='codex:thread-513'");
    for (const createdAt of ["2026-06-10T07:48:00Z", "2026-06-10T07:54:00Z"]) {
      createIssueSupervisorEvent(db, {
        decision: "noop",
        diagnosis_code: "session_no_recent_progress",
        event_type: "decision_failed",
        issue_id: 513,
        project_id: "demo",
        created_at: createdAt
      });
    }

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      },
      staleAfterSeconds: 300
    });
    expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
    expect(calls).toBe(1);
    expect(db.sqlite.query<{ status: string }, [number]>(
      "select status from issues where id=?"
    ).get(513)).toEqual({ status: "in_progress" });
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);
    expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
    expect(listIssueSupervisorEvents(db, { issueId: 513 }).map((event) => event.event_type))
      .toEqual(["decision_failed", "decision_failed", "decision_failed", "signal", "decision", "action", "result"]);
  });
}
