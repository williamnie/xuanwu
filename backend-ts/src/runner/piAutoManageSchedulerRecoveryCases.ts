import { expect, test } from "bun:test";

import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createPiAction, listPiActions, pausePiHeartbeat, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { listPiRecoveryAttempts } from "../db/repositories/pi/recoveryAttempts.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { EventBus, type AppEvent } from "../events/bus.ts";

import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { isProjectLoopActive } from "./projectLoopManager.ts";
import { insertRow } from "../testing/harness.ts";
import {
  FakePiCycleRunner,
  openFixtureDatabase,
  insertProject,
  insertTodoIssue,
  insertSettings,
  NOW,
  validDecision,
  needsUserDecision,
  runOutageScheduleClosure,
  expectDeferredOutageClaim,
  insertFailedIssueRunSession,
  InitializeTimeoutProvider,
  WatchdogSessionProvider,
  insertDelegation,
  heartbeatRunCount,
  waitUntil
} from "./piAutoManageSchedulerTestFixtures.ts";

export function registerPiAutoManageSchedulerRecoveryCases() {
  test("escalates a deterministic failed autonomous issue instead of spending a blind retry", async () => {
    const db = await openFixtureDatabase();
    const bus = new EventBus();
    const observed: AppEvent[] = [];
    const detach = bus.observe((event) => observed.push(event));
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "demo", 0);
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        allowed_supervisor_actions_json: ["issue.retry", "needs_user.escalate"]
      });
      insertSettings(db, "demo");
      insertFailedIssueRunSession(db, 520);

      const first = await runScheduleLayerCycle({
        bus,
        database: db,
        runProjectCycle: runner.run.bind(runner),
        runSupervisorDecision: async () => validDecision(needsUserDecision()),
        watchdogNow: NOW
      });

      expect(first.supervisor).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(first.guardianActionDispatch).toMatchObject({ completed: 0, failed: 0, scanned: 0 });
      expect(listPiActions(db, { issueId: 520 })[0]).toMatchObject({
        action_type: "needs_user.escalate",
        status: "completed"
      });
      expect(getIssue(db, 520)).toMatchObject({ status: "failed" });
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toMatchObject([
        expect.objectContaining({ event: "pi.needs_user", issue_id: 520 })
      ]);
      expect(observed).toContainEqual(expect.objectContaining({
        issueId: 520,
        projectId: "demo",
        type: "pi.needs_user"
      }));
      expect(listPiRecoveryAttempts(db, { issueId: 520 })).toEqual([]);
    } finally {
      detach();
    }
  });

  test("executes approved Guardian needs-user escalation during schedule layer cycle", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    insertProject(db, "demo", 0);
    insertRow(db, "issues", {
      id: 611, project_id: "demo", title: "Needs user issue", status: "in_progress",
      created_at: "2026-06-22T08:00:00Z", updated_at: "2026-06-22T08:35:07Z"
    });
    createPiAction(db, {
      action_type: "needs_user.escalate",
      gate_decision: "execute",
      id: "guardian-needs-user",
      issue_id: 611,
      payload_json: JSON.stringify({
        diagnosis_code: "provider_auth_failed",
        issue_id: 611,
        message: "Provider unavailable",
        next_step: "Refresh provider credentials.",
        provider: "codex"
      }),
      project_id: "demo",
      source: "pi_guardian_orchestrator",
      status: "approved"
    });

    const result = await runScheduleLayerCycle({
      database: db,
      runProjectCycle: runner.run.bind(runner),
      runSupervisor: false,
      watchdogNow: NOW
    });

    expect(result.guardianActionDispatch).toMatchObject({ completed: 1, failed: 0, scanned: 1 });
    expect(listPiActions(db, { issueId: 611 })[0]).toMatchObject({
      action_type: "needs_user.escalate",
      status: "completed"
    });
    expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toMatchObject([
      expect.objectContaining({ event: "pi.needs_user", issue_id: 611 })
    ]);
    expect(listIssueEvents(db, 611).filter((event) => event.type === "issue.comment")).toHaveLength(1);
  });

  test("always-on issue watchdog starts stale todo issues without PI auto-manage settings", async () => {
    const db = await openFixtureDatabase();
    const provider = new WatchdogSessionProvider();
    const runner = new FakePiCycleRunner();
    insertProject(db, "demo", 1);
    insertTodoIssue(db, 801, "Stale todo", "2026-06-22T08:00:00Z");

    const result = await runScheduleLayerCycle({
      database: db,
      providers: { codex: provider },
      runProjectCycle: runner.run.bind(runner),
      runSupervisor: false,
      watchdogNow: NOW
    });

    expect(result.issueWatchdog).toMatchObject({ candidates: 1, escalated: 0, kicked: 1 });
    expect(runner.calls).toEqual([]);
    await waitUntil(() => provider.inputs.length === 1);
    expect(provider.inputs.map((input) => input.issueId)).toEqual([801]);
    expect(getIssue(db, 801)).toMatchObject({ attempt_count: 1, status: "in_progress" });
    expect(getAgentSession(db, "codex:thread-801")).toMatchObject({ issue_id: 801, status: "running" });
    await waitUntil(() => !isProjectLoopActive("demo"));
  });

  test("always-on issue watchdog re-kicks stale todos that remain sessionless after a kick", async () => {
    const db = await openFixtureDatabase();
    const provider = new WatchdogSessionProvider();
    const runner = new FakePiCycleRunner();
    insertProject(db, "demo", 1);
    insertTodoIssue(db, 802, "Still stale todo", "2026-06-22T08:00:00Z");
    insertRow(db, "issue_events", {
      issue_id: 802, type: "issue.watchdog_kicked", payload: JSON.stringify({ reason: "test" }), created_at: "2026-06-22T08:10:00Z"
    });

    const result = await runScheduleLayerCycle({
      database: db,
      providers: { codex: provider },
      runProjectCycle: runner.run.bind(runner),
      runSupervisor: false,
      watchdogNow: NOW
    });

    expect(result.issueWatchdog).toMatchObject({ candidates: 1, escalated: 0, kicked: 1 });
    await waitUntil(() => provider.inputs.length === 1);
    expect(provider.inputs.map((input) => input.issueId)).toEqual([802]);
    expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toEqual([]);
    await waitUntil(() => !isProjectLoopActive("demo"));
  });

  test("routes a provider initialize outage to PI acceptance without a hardcoded retry", async () => {
    const db = await openFixtureDatabase();
    const provider = new InitializeTimeoutProvider();
    const runner = new FakePiCycleRunner();
    insertProject(db, "demo", 1, "claude");
    insertTodoIssue(db, 701, "Provider outage first", "2026-06-22T08:00:00Z");
    insertTodoIssue(db, 702, "Ordinary follow-up", "2026-06-22T08:01:00Z");

    await runProjectLoopOnce({
      database: db,
      projectId: "demo",
      providers: { claude: provider }
    });

    expectDeferredOutageClaim(db, provider);

    const result = await runOutageScheduleClosure(db, runner);

    expect(result.first.supervisor).toMatchObject({ scanned: 0, signaled: 0 });
    expect(result.first.guardianDecisions).toMatchObject({ created: 1 });
    expect(result.second.guardianActionDispatch).toMatchObject({ completed: 0, failed: 0, scanned: 0 });
    expect(runner.calls).toEqual([]);
    expect(getIssue(db, 702)).toMatchObject({ attempt_count: 0, status: "todo" });

    expect(listPiActions(db, { issueId: 701 })).toEqual([]);
    expect(getIssue(db, 701)).toMatchObject({
      auto_retry_reason: "",
      status: "in_progress"
    });
  });

  test("does not run delegation heartbeats while project heartbeat is paused", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    insertProject(db, "project-a", 1);
    insertDelegation(db, "delegation-paused", "project-a");
    pausePiHeartbeat(db, { scopeId: "project-a", scopeType: "project" });

    const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

    expect(result.delegations).toEqual({ scanned: 0, skipped: 0, started: 0 });
    expect(result.supervisor).toMatchObject({ decisions: 0, failed: 0 });
    expect(heartbeatRunCount(db)).toBe(0);
  });
}
