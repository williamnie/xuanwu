import { expect, test } from "bun:test";

import {
  listIssueSupervisorEvents,
  listPiActions,
  listPiGuardianEvents,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";

import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";

import type { ExecutorProvider } from "../providers/types.ts";
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
  resumeDecision,
  needsUserDecision,
  SupervisorProvider
} from "./piIssueSupervisorSchedulerTestFixtures.ts";

export function registerPiIssueSupervisorSchedulerSchedulingCases() {
  test("completion during PI reasoning invalidates a pending needs-user escalation", async () => {
    const db = await fixtureDb();
    insertProject(db, "demo", await tempRoot("supervisor-decision-race-"));
    insertRunningIssue(db, { issueID: 494, projectID: "demo", threadID: "thread-494", turnID: "turn-494", sessionUpdatedAt: "2026-06-10T07:00:00Z" });
    let status = "interrupted";
    const provider: ExecutorProvider = { id: "codex", capabilities: ["sessions"], run: async () => ({ runId: "unused" }),
      listSessionTurns: async () => ({ data: [{ id: "turn-494", status, items: [] }] }) };
    await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, providers: { codex: provider },
      runDecision: async () => { status = "completed"; return validDecision(needsUserDecision("No progress")); } });
    expect(listPiActions(db, { issueId: 494 })).toEqual([]);
    expect(db.sqlite.query("select status from issue_runs where issue_id=494").get()).toEqual({ status: "succeeded" });
  });

  test("reconciles the completed native turn before an exhausted budget can escalate", async () => {
    const db = await fixtureDb();
    insertProject(db, "demo", await tempRoot("supervisor-completed-native-"));
    insertRunningIssue(db, { issueID: 496, projectID: "demo", threadID: "thread-496", turnID: "turn-496", sessionUpdatedAt: "2026-06-10T07:00:00Z" });
    for (let index = 0; index < 6; index++) recordPiRecoveryAttempt(db, {
      id: `exhausted-${index}`, idempotency_key: `exhausted-${index}`, issue_id: 496, project_id: "demo",
      action_type: "issue.retry", diagnosis_code: "session_no_recent_progress", status: "executing",
      budget_window_started_at: "2026-06-10T07:00:00Z", created_at: "2026-06-10T07:00:00Z"
    });
    let reads = 0;
    const provider: ExecutorProvider = {
      id: "codex", capabilities: ["sessions"], run: async () => { throw new Error("must not start"); },
      async listSessionTurns(_id, options) {
        reads++;
        expect(options).toEqual({ limit: 1, itemsView: "full", sortDirection: "desc" });
        return { data: [{ id: "turn-496", status: "completed", items: [
          { id: "result", type: "agentMessage", phase: "final_answer", text: "33 tests passed.\nRUNNER_OUTCOME: completed" }
        ] }] };
      }
    };
    const input = { database: db, now: NOW, providers: { codex: provider }, runDecision: async () => { throw new Error("must request acceptance instead of recovery"); } };
    await runPiIssueSupervisorSchedulerOnce(input);
    await runPiIssueSupervisorSchedulerOnce(input);
    expect(reads).toBe(1);
    expect(db.sqlite.query("select status from issues where id=496").get()).toEqual({ status: "in_progress" });
    expect(db.sqlite.query("select status from issue_runs where issue_id=496").get()).toEqual({ status: "succeeded" });
    expect(listIssueEvents(db, 496).filter((event) => event.type === "issue.pi_acceptance_requested.v1")).toHaveLength(1);
    expect(listPiActions(db, { issueId: 496 })).toEqual([]);
  });

  test("a live native turn and a newer turn are never blindly resumed", async () => {
    const db = await fixtureDb();
    insertProject(db, "demo", await tempRoot("supervisor-live-native-"));
    insertRunningIssue(db, { issueID: 495, projectID: "demo", threadID: "thread-495", turnID: "turn-495", sessionUpdatedAt: "2026-06-10T07:00:00Z" });
    const provider: ExecutorProvider = { id: "codex", capabilities: ["sessions"], run: async () => ({ runId: "unused" }),
      listSessionTurns: async () => ({ data: [{ id: "turn-495", status: "inProgress", items: [] }] }) };
    const input = { database: db, now: NOW, providers: { codex: provider }, runDecision: async () => { throw new Error("must not resume"); } };
    expect((await runPiIssueSupervisorSchedulerOnce(input)).decisions).toBe(0);
    provider.listSessionTurns = async () => ({ data: [{ id: "newer-turn", status: "completed", items: [] }] });
    expect((await runPiIssueSupervisorSchedulerOnce(input)).decisions).toBe(0);
    provider.listSessionTurns = async () => { throw new Error("transport disconnected"); };
    expect((await runPiIssueSupervisorSchedulerOnce(input)).decisions).toBe(0);
    expect(db.sqlite.query("select status from issue_runs where issue_id=495").get()).toEqual({ status: "in_progress" });
  });

  test("uses the five-minute scheduler stale threshold when no override is provided", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-default-stale-project-"));
    insertRunningIssue(db, {
      issueID: 497,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:54:00Z",
      threadID: "thread-497",
      turnID: "turn-497"
    });

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      }
    });

    expect(result).toMatchObject({ decisions: 1, failed: 0, scanned: 1, signaled: 1 });
    expect(calls).toBe(1);
    expect(listIssueSupervisorEvents(db, { issueId: 497 }))
      .toContainEqual(expect.objectContaining({
        diagnosis_code: "session_no_recent_progress",
        event_type: "signal"
      }));
  });

  test("invokes PI for a dispatchable watchdog signal instead of stopping at a hardcoded candidate", async () => {
    const db = await fixtureDb();
    let calls = 0;
    insertProject(db, "demo", await tempRoot("supervisor-watchdog-project-"));
    insertRunningIssue(db, {
      issueID: 498,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-498",
      turnID: "turn-498"
    });
    insertIssueEvent(db, 498, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      runDecision: async () => {
        calls += 1;
        return validDecision(noopDecision());
      },
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, failed: 0, scanned: 1, signaled: 1, skipped: 0 });
    expect(calls).toBe(1);
    expect(listIssueSupervisorEvents(db, { issueId: 498 }).map((event) => event.event_type))
      .toEqual(["signal", "decision", "action", "result"]);
    expect(listPiActions(db, { issueId: 498 })).toContainEqual(expect.objectContaining({
      action_type: "issue.supervisor_decision",
      status: "completed"
    }));
    expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([]);
  });

  test("applies the valid PI decision through Action Gate and executor provider", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    insertProject(db, "demo", await tempRoot("supervisor-autonomous-project-"));
    upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: ["session.resume_followup"],
      project_id: "demo"
    });
    insertRunningIssue(db, {
      issueID: 500,
      projectID: "demo",
      sessionUpdatedAt: "2026-06-10T07:45:00Z",
      threadID: "thread-500",
      turnID: "turn-500"
    });
    insertIssueEvent(db, 500, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

    const result = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: NOW,
      providers: { codex: provider },
      runDecision: async () => validDecision(resumeDecision()),
      staleAfterSeconds: 300
    });

    expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
    expect(provider.calls).toEqual([{
      prompt: "Inspect current state and continue safely.",
      sessionId: "thread-500"
    }]);
    expect(listPiActions(db, { issueId: 500 })).toContainEqual(expect.objectContaining({
      action_type: "session.resume_followup",
      gate_decision: "execute",
      status: "completed"
    }));
    expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([]);
  });
}
