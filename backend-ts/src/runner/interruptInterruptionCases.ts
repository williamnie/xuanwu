import { expect, test } from "bun:test";

import { getIssue } from "../db/repositories/issues.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { cancelIssueWithInterrupt, retryIssueWithInterrupt } from "./interrupt.ts";

import {
  openFixtureDatabase,
  InterruptCaptureProvider,
  ActiveInterruptProvider,
  RestartableExecutionProvider,
  insertProject,
  insertIssue,
  insertOpenRun,
  insertAgentSession,
  latestRun,
  latestAttempt,
  listEvents,
  eventWithType,
  waitFor
} from "./interruptTestFixtures.ts";

export function registerInterruptInterruptionCases() {
  test("cancel interrupts the linked Codex turn once and remains idempotent", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "thread-cancel", "turn-cancel");
    insertOpenRun(db, issueId);

    const issue = await cancelIssueWithInterrupt(db, issueId, { providers: { codex: provider } });
    const repeat = await cancelIssueWithInterrupt(db, issueId, { providers: { codex: provider } });
    const eventTypes = listEvents(db).map((event) => event.type);

    expect(issue.status).toBe("cancelled");
    expect(repeat.status).toBe("cancelled");
    expect(provider.interrupts).toEqual([{
      session: { provider: "codex", sessionId: "thread-cancel", turnId: "turn-cancel" },
      reason: "issue_cancel"
    }]);
    expect(eventTypes).toContain("issue.interrupt_requested");
    expect(eventTypes).toContain("issue.interrupted");
    expect(latestRun(db, issueId)).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
    expect(latestAttempt(db, issueId)).toMatchObject({ status: "interrupted" });
  });

  test("cancel interrupts an active Pi run before Session or Turn refs exist", async () => {
    const db = await openFixtureDatabase();
    const provider = new ActiveInterruptProvider();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "", "");
    insertOpenRun(db, issueId, "pi-coding-agent");

    const issue = await cancelIssueWithInterrupt(db, issueId, {
      providers: { "pi-coding-agent": provider }
    });

    expect(issue.status).toBe("cancelled");
    expect(provider.interrupts).toEqual([{
      reason: "issue_cancel",
      session: { provider: "pi-coding-agent", sessionId: "" }
    }]);
    expect(eventWithType(db, "issue.interrupted")).toBeDefined();
    expect(latestRun(db, issueId)).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
  });

  test("cancel closes the run and records diagnostics when Codex interrupt times out", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ hang: true });
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "thread-slow", "turn-slow");
    insertOpenRun(db, issueId);

    const startedAt = Date.now();
    const issue = await cancelIssueWithInterrupt(db, issueId, {
      interruptTimeoutMs: 5,
      providers: { codex: provider }
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(issue.status).toBe("cancelled");
    expect(provider.interrupts).toHaveLength(1);
    expect(latestRun(db, issueId)).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
    expect(eventWithType(db, "issue.interrupt_failed")?.payload).toContain("timed out");
  });

  test("retry interrupts the old turn before closing and requeueing its run", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "thread-retry", "turn-retry");
    insertOpenRun(db, issueId);

    const issue = await retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } });

    expect(issue.status).toBe("todo");
    expect(provider.interrupts).toEqual([{
      session: { provider: "codex", sessionId: "thread-retry", turnId: "turn-retry" },
      reason: "issue_retry"
    }]);
    expect(latestRun(db, issueId)).toMatchObject({
      status: "cancelled",
      exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueId}-attempt-2`
    });
    expect(eventWithType(db, "issue.interrupted")?.payload).toContain("issue_retry");
  });

  test("retry supersedes an open run without interrupting a terminal provider session", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ reject: new Error("terminal session must not be interrupted") });
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "thread-completed", "turn-completed");
    insertOpenRun(db, issueId);
    insertAgentSession(db, issueId, "demo", "thread-completed", "completed");

    const issue = await retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } });

    expect(issue.status).toBe("todo");
    expect(provider.interrupts).toEqual([]);
    expect(latestRun(db, issueId)).toMatchObject({
      status: "cancelled",
      exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueId}-attempt-2`
    });
    expect(eventWithType(db, "issue.interrupt_requested")).toBeUndefined();
  });

  test("retry leaves the running issue intact when the old turn cannot be interrupted", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ reject: new Error("interrupt rejected") });
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "thread-reject", "turn-reject");
    insertOpenRun(db, issueId);

    await expect(retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } }))
      .rejects.toThrow("旧 Session 中断失败");

    expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress" });
    expect(latestRun(db, issueId)).toMatchObject({ status: "in_progress", ended_at: "" });
    expect(eventWithType(db, "issue.interrupt_failed")?.payload).toContain("interrupt rejected");
    expect(eventWithType(db, "issue.interrupted")).toBeUndefined();
  });

  test("a failed interrupt can be retried with a new lifecycle revision", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ reject: new Error("interrupt rejected") });
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "in_progress", "thread-retry-again", "turn-retry-again");
    insertOpenRun(db, issueId);

    await expect(retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } }))
      .rejects.toThrow("旧 Session 中断失败");
    await expect(retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } }))
      .rejects.toThrow("旧 Session 中断失败");

    expect(provider.interrupts).toHaveLength(2);
    const lifecycleIDs = listEvents(db)
      .filter((event) => event.type === "run.lifecycle.intent.v1")
      .map((event) => JSON.parse(event.payload).event_id);
    expect(lifecycleIDs).toHaveLength(2);
    expect(new Set(lifecycleIDs).size).toBe(2);
  });

  test("a late failure from the interrupted run cannot fail the newly queued attempt", async () => {
    const db = await openFixtureDatabase();
    const provider = new RestartableExecutionProvider();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo", "todo", "", "");
    const running = runProjectLoopOnce({ database: db, projectId: "demo", providers: { codex: provider } });
    await waitFor(() => latestRun(db, issueId)?.provider_session_id === "thread-running");

    const retried = await retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } });
    await running;

    expect(retried.status).toBe("todo");
    expect(getIssue(db, issueId)).toMatchObject({ status: "todo", error: "" });
    expect(latestRun(db, issueId)).toMatchObject({
      status: "cancelled",
      exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueId}-attempt-2`,
      error: ""
    });
  });
}
