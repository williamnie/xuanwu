import { expect, test } from "bun:test";
import { createDefaultRouter, createRequestHandler } from "../server.ts";
import type { TestFixture } from "./runApi.testFixture.ts";

export function registerRequiresBearerAuthAndPerformsCases(testScope: TestFixture) {
  const { AUTH_TOKEN, openFixtureDatabase, ControlProvider, insertProject, insertIssue, insertRun, audit, jsonRequest, authenticatedJsonRequest, lifecycleEvents, issueStatus, timestamp } = testScope;
  test("requires bearer auth and performs idempotent interrupt with audited revisions", async () => {
      const db = await openFixtureDatabase();
      const provider = new ControlProvider();
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Interrupt", "in_progress");
      const runID = insertRun(db, issueID, "in_progress", {
        sessionID: "thread-interrupt",
        startedAt: timestamp(1),
        turnID: "turn-interrupt"
      });
      const handle = createRequestHandler(createDefaultRouter({ database: db, providers: { codex: provider } }), AUTH_TOKEN);
      const payload = {
        audit: audit("interrupt-1", "user"),
        expected_attempt_revision: 0,
        expected_revision: 0
      };
  
      const unauthorized = await handle(jsonRequest(`/api/runs/${encodeURIComponent(runID)}/actions/interrupt`, payload));
      const interrupted = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/interrupt`, payload
      ));
      const replay = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/interrupt`, payload
      ));
      const interruptedBody = await interrupted.json() as Record<string, any>;
      const replayBody = await replay.json() as Record<string, any>;
  
      expect(unauthorized.status).toBe(401);
      expect(interrupted.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(provider.interrupts).toHaveLength(1);
      expect(interruptedBody).toMatchObject({
        mutation: { action: "interrupt", applied: true, audit_event_id: "interrupt-1", replayed: false },
        run: { progress: { attempt_status: "interrupted" }, revision: 2 }
      });
      expect(replayBody.mutation.replayed).toBe(true);
      expect(lifecycleEvents(db, issueID, "interrupt-1")).toEqual([
        "run.lifecycle.intent.v1",
        "run.lifecycle.outcome.v1"
      ]);
    });
  
  test("resumes the same provider session once and rejects a stale concurrent command", async () => {
      const db = await openFixtureDatabase();
      const provider = new ControlProvider();
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Resume", "in_progress");
      const runID = insertRun(db, issueID, "in_progress", {
        sessionID: "thread-resume",
        startedAt: timestamp(1),
        turnID: "turn-old"
      });
      db.sqlite.run(`update run_attempts set status='succeeded', revision=1, ended_at=?,
        terminal_reason='provider turn completed', terminal_source_ref='fixture:completed', updated_at=?
        where run_id=?`, [timestamp(2), timestamp(2), runID]);
      const handle = createRequestHandler(createDefaultRouter({ database: db, providers: { codex: provider } }), AUTH_TOKEN);
      const payload = {
        audit: audit("resume-1", "supervisor"),
        expected_attempt_revision: 1,
        expected_revision: 0,
        prompt: "Continue from the verified provider state."
      };
  
      const resumed = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/resume`, payload
      ));
      const replay = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/resume`, payload
      ));
      const stale = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/resume`, {
          ...payload,
          audit: audit("resume-stale", "supervisor")
        }
      ));
      const resumedBody = await resumed.json() as Record<string, any>;
      const staleBody = await stale.json() as Record<string, any>;
  
      expect(resumed.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(stale.status).toBe(409);
      expect(provider.messages).toEqual([{
        prompt: "Continue from the verified provider state.",
        sessionId: "thread-resume"
      }]);
      expect(resumedBody).toMatchObject({
        mutation: { action: "resume", audit_event_id: "resume-1", replayed: false },
        run: {
          attempt_count: 2,
          attempts: [
            { kind: "initial", status: "succeeded" },
            { kind: "resume", provider_ref: { session_ref: "thread-resume", turn_ref: "turn-resumed" }, status: "running" }
          ],
          progress: { attempt_sequence: 2, attempt_status: "running" },
          revision: 2
        }
      });
      expect(staleBody.code).toBe("run_precondition_failed");
      expect(String(staleBody.message)).toContain("Run revision mismatch");
    });
  
  test("serializes retry by expected revision and records rejected concurrent requests", async () => {
      const db = await openFixtureDatabase();
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Retry", "failed");
      const runID = insertRun(db, issueID, "failed", {
        endedAt: timestamp(2),
        startedAt: timestamp(1)
      });
      const handle = createRequestHandler(createDefaultRouter({ database: db }), AUTH_TOKEN);
      const payload = { audit: audit("retry-1", "user"), expected_revision: 0 };
  
      const retried = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`, payload
      ));
      const replay = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`, payload
      ));
      const stale = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`, {
          audit: audit("retry-stale", "user"),
          expected_revision: 0
        }
      ));
      const retriedBody = await retried.json() as Record<string, any>;
      const staleBody = await stale.json() as Record<string, any>;
  
      expect(retried.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(stale.status).toBe(409);
      expect(retriedBody).toMatchObject({
        mutation: { action: "retry", applied: true, operation: "retry", requested_sequence: 2 },
        run: { revision: 1 }
      });
      expect(staleBody).toMatchObject({
        code: "run_precondition_failed",
        mutation: { action: "retry", audit_event_id: "retry-stale", operation: "retry" },
        violations: expect.arrayContaining([
          "Run revision mismatch: expected 0, actual 1",
          "a new Run request is already pending"
        ])
      });
      expect(issueStatus(db, issueID)).toBe("todo");
      expect(lifecycleEvents(db, issueID, "retry-1")).toEqual(["run.lifecycle.run_requested.v1"]);
    });
  
  test("rejects untrusted actor kinds before writing lifecycle audit", async () => {
      const db = await openFixtureDatabase();
      insertProject(db, "demo");
      const issueID = insertIssue(db, "demo", "Permission", "failed");
      const runID = insertRun(db, issueID, "failed", { endedAt: timestamp(2), startedAt: timestamp(1) });
      const handle = createRequestHandler(createDefaultRouter({ database: db }), AUTH_TOKEN);
  
      const response = await handle(authenticatedJsonRequest(
        `/api/runs/${encodeURIComponent(runID)}/actions/retry`,
        { audit: audit("llm-gate", "llm"), expected_revision: 0 }
      ));
  
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_request", message: "audit.actor.kind is invalid" });
      expect(lifecycleEvents(db, issueID, "llm-gate")).toEqual([]);
    });
}
