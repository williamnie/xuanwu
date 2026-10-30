import { expect, test } from "bun:test";
import { EventBus } from "../../events/bus.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./issueActionsApi.testFixture.ts";

export function registerEnqueueQueuesIdleIssuesAndCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureDatabase, RetryExecutionProvider, issueAction, issuePatch, managedExecutorHeaders, insertIssue, insertProject, waitFor, insertOpenRun, latestRun, getIssueStatus, listEvents, eventWithType } = testScope;
  test("enqueue queues idle issues and leaves actively running issues in progress", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      for (const status of ["triage", "todo", "in_progress"]) {
        const issueId = insertIssue(database, { projectId: "demo", status, title: `enqueue ${status}` });
        if (status === "in_progress") insertOpenRun(database, issueId);
  
        const response = await issueAction(database, issueId, "enqueue");
        const body = await response.json() as Record<string, unknown>;
  
        const expectedStatus = status === "in_progress" ? "in_progress" : "todo";
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: issueId, status: expectedStatus, error: "" });
      }
      expect(listEvents(database).map((event) => event.type)).toEqual([
        "issue.status_changed",
        "issue.lifecycle_control.v1",
        "issue.status_changed"
      ]);
    });
  
  test("retry moves terminal issues to todo and clears retry state", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      for (const status of ["done", "failed", "cancelled", "pending_verification"]) {
        const issueId = insertIssue(database, {
          projectId: "demo",
          status,
          title: `retry ${status}`,
          error: "previous failure",
          codexThreadId: `thread-${status}`,
          codexTurnId: `turn-${status}`,
          autoRetryNextAt: "2026-01-02T00:00:00Z",
          autoRetryReason: "network timeout"
        });
  
        const response = await issueAction(database, issueId, "retry");
        const body = await response.json() as Record<string, unknown>;
  
        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          id: issueId,
          status: "todo",
          error: "",
          codex_thread_id: `thread-${status}`,
          codex_turn_id: "",
          auto_retry_next_at: "",
          auto_retry_reason: ""
        });
      }
    });
  
  test("retry force-starts the selected issue without reviving the project-wide failed fuse", async () => {
      const database = await openFixtureDatabase();
      const provider = new RetryExecutionProvider();
      insertProject(database, "retry-blocked", { autoRun: 1, provider: provider.id });
      insertIssue(database, { projectId: "retry-blocked", status: "failed", title: "existing blocker" });
      const retryID = insertIssue(database, { projectId: "retry-blocked", status: "failed", title: "selected retry" });
  
      const response = await issueAction(database, retryID, "retry", provider);
      expect(response.status).toBe(200);
      await waitFor(() => provider.issueIDs.includes(retryID));
  
      expect(provider.issueIDs).toEqual([retryID]);
    });
  
  test("cancel releases the project lock and recomputes the runnable sibling", async () => {
      const database = await openFixtureDatabase();
      const provider = new RetryExecutionProvider();
      insertProject(database, "cancel-recompute", { autoRun: 1, provider: provider.id });
      const running = insertIssue(database, {
        projectId: "cancel-recompute",
        status: "in_progress",
        title: "running"
      });
      const sibling = insertIssue(database, {
        projectId: "cancel-recompute",
        status: "todo",
        title: "ready sibling"
      });
      insertOpenRun(database, running);
  
      const response = await issueAction(database, running, "cancel", provider);
      expect(response.status).toBe(200);
      await waitFor(() => provider.issueIDs.includes(sibling));
  
      expect(provider.issueIDs).toEqual([sibling]);
      expect(getIssueStatus(database, sibling)).toBe("in_progress");
    });
  
  test("cancel marks issues cancelled, closes open runs, and records issue_cancel", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, {
        projectId: "demo",
        status: "in_progress",
        title: "cancel running",
        codexThreadId: "thread-cancel",
        codexTurnId: "turn-cancel"
      });
      insertOpenRun(database, issueId);
  
      const response = await issueAction(database, issueId, "cancel");
      const body = await response.json() as Record<string, unknown>;
      const run = latestRun(database, issueId);
  
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ id: issueId, status: "cancelled" });
      expect(run).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
      expect(run?.ended_at).not.toBe("");
      expect(eventWithType(database, "issue.status_changed")?.payload).toBe(JSON.stringify({
        status: "cancelled",
        reason: "issue_cancel"
      }));
    });
  
  test("cancel publishes the actor-attributed terminal status to realtime observers", async () => {
      const database = await openFixtureDatabase();
      const bus = new EventBus();
      const observed: Array<{ payload?: string; type: string }> = [];
      const detach = bus.observe((event) => observed.push(event));
      try {
        insertProject(database, "demo");
        const issueId = insertIssue(database, {
          projectId: "demo",
          status: "in_progress",
          title: "cancel event",
          codexThreadId: "thread-cancel-event",
          codexTurnId: "turn-cancel-event"
        });
        insertOpenRun(database, issueId);
        const router = createDefaultRouter({ bus, database });
  
        const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/cancel`, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" }
        }));
  
        expect(response.status).toBe(200);
        expect(observed.filter((event) => event.type === "issue.status_changed")).toEqual([{
          type: "issue.status_changed",
          payload: JSON.stringify({
            actor: { kind: "operator", source: "http", thread_id: "" },
            status: "cancelled"
          }),
          issueId,
          projectId: "demo"
        }]);
      } finally {
        detach();
      }
    });
  
  test("cancel also moves queued and terminal issues to cancelled", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      for (const status of ["triage", "todo", "done", "failed", "cancelled", "pending_verification"]) {
        const issueId = insertIssue(database, {
          projectId: "demo",
          status,
          title: `cancel ${status}`,
          error: "existing error",
          autoRetryNextAt: "2026-01-02T00:00:00Z",
          autoRetryReason: "network timeout"
        });
  
        const response = await issueAction(database, issueId, "cancel");
        const body = await response.json() as Record<string, unknown>;
  
        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          id: issueId,
          status: "cancelled",
          error: "",
          auto_retry_next_at: "",
          auto_retry_reason: ""
        });
      }
    });
  
  test("denies a managed executor cancelling or changing the status of its own Issue", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, {
        codexThreadId: "thread-self",
        codexTurnId: "turn-self",
        projectId: "demo",
        status: "in_progress",
        title: "self control"
      });
      insertOpenRun(database, issueId);
      const headers = managedExecutorHeaders("thread-self");
  
      const cancelled = await issueAction(database, issueId, "cancel", undefined, headers);
      const patched = await issuePatch(database, issueId, { status: "triage" }, headers);
  
      expect(cancelled.status).toBe(409);
      expect(patched.status).toBe(409);
      expect(await cancelled.json()).toMatchObject({ message: expect.stringContaining("cannot cancel its own Issue") });
      expect(await patched.json()).toMatchObject({ message: expect.stringContaining("cannot status_update its own Issue") });
      expect(getIssueStatus(database, issueId)).toBe("in_progress");
      expect(latestRun(database, issueId)).toMatchObject({ status: "in_progress", ended_at: "" });
      expect(listEvents(database).filter((event) => event.type === "issue.executor_lifecycle_mutation_denied.v1")).toHaveLength(2);
      expect(database.sqlite.query<{ count: number }, [number]>(
        "select count(*) as count from notifications where issue_id=? and event='pi.needs_user'"
      ).get(issueId)?.count).toBe(2);
    });
}
