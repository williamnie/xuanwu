import { expect, test } from "bun:test";
import { getAgentSession } from "../../db/repositories/agentSessions.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { createPiAction, listIssueSupervisorEvents } from "../../db/repositories/pi.ts";
import { getIssueAsWork } from "../../domain/work/issueAdapter.ts";
import { resolvePiNotificationPreference } from "../../pi/notifications/notificationPreferenceResolver.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import type { TestFixture } from "./piActionDispatch.testFixture.ts";

export function registerSessionResumeFollowupSendsACases(testScope: TestFixture) {
  const { fixtureDb, insertProject, insertIssue, insertIssueRunSession, SupervisorProvider } = testScope;
  test("session.resume_followup sends a new session message and updates turn refs", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 305, projectID: "demo", sessionID: "thread-305", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "resume-action",
        issue_id: 305,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-305-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 305,
          prompt: "Inspect current state and continue safely.",
          provider: "codex",
          provider_session_id: "thread-305"
        }),
        project_id: "demo",
        status: "approved"
      });
      await dispatchPiAction({ database: db, providers: { codex: provider } }, action);
  
      expect(provider.calls).toEqual([{ prompt: "Inspect current state and continue safely.", sessionId: "thread-305" }]);
      expect(JSON.parse(getAgentSession(db, "codex:thread-305")?.raw_ref ?? "{}")).toMatchObject({
        provider_turn_id: "turn-followup"
      });
      expect(listIssueRuns(db, 305).at(-1)).toMatchObject({ provider_turn_id: "turn-followup" });
      expect(listIssueEvents(db, 305).map((event) => event.type)).toContain("issue.supervisor_resume_followup");
    });
  
  test("run.interrupt dispatches an approved revision-bound control action", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      insertProject(db, "demo");
      insertIssueRunSession(db, {
        issueID: 306,
        projectID: "demo",
        sessionID: "thread-306",
        turnID: "turn-306"
      });
      const action = createPiAction(db, {
        action_type: "run.interrupt",
        approved_by: "test:user",
        id: "run-interrupt-action",
        issue_id: 306,
        payload_json: JSON.stringify({
          action: "interrupt",
          expected_attempt_revision: 0,
          expected_revision: 0,
          reason: "stop current run",
          run_id: "xw:run:issue_runs:issue-306-attempt-1"
        }),
        project_id: "demo",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db, providers: { codex: provider } }, action))
        .resolves.toMatchObject({ mutation: { action: "interrupt" } });
      expect(provider.calls).toContainEqual(expect.objectContaining({
        sessionId: "thread-306",
        turnId: "turn-306"
      }));
      expect(db.sqlite.query<{ status: string }, []>(
        "select status from run_attempts where issue_run_id='issue-306-attempt-1' order by sequence desc limit 1"
      ).get()).toEqual({ status: "interrupted" });
    });
  
  test("work.cancel dispatches an approved revision-bound control action", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssue(db, { issueID: 307, projectID: "demo", status: "triage" });
      const workID = "xw:work:issues:307" as const;
      const work = getIssueAsWork(db, 307);
      if (!work) throw new Error("missing Work projection");
      const action = createPiAction(db, {
        action_type: "work.cancel",
        approved_by: "test:user",
        id: "work-cancel-action",
        issue_id: 307,
        payload_json: JSON.stringify({
          action: "cancel",
          expected_revision: work.revision,
          reason: "cancel current Work",
          work_id: workID
        }),
        project_id: "demo",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db }, action))
        .resolves.toMatchObject({ mutation: { applied: true }, work: { status: "cancelled" } });
      expect(getIssue(db, 307)).toMatchObject({ status: "cancelled" });
    });
  
  test("notification preference approval dispatches the persisted structured choice", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      const action = createPiAction(db, {
        action_type: "notification.preference.update",
        approved_by: "test:user",
        conversation_id: "conv-notification",
        id: "notification-preference-action",
        payload_json: JSON.stringify({
          mode: "quiet",
          project_id: "demo",
          scope: "project",
          temporary: false
        }),
        project_id: "demo",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db }, action)).resolves.toMatchObject({
        preference: { mode: "quiet", project_id: "demo", scope: "project" }
      });
      expect(resolvePiNotificationPreference(db, { projectID: "demo" })).toMatchObject({
        effective: { mode: "quiet" },
        source: "project"
      });
    });
  
  test("issue.retry_after records due time without resuming the provider", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 306, projectID: "demo", sessionID: "thread-306", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "issue.retry_after",
        id: "retry-after-action",
        issue_id: 306,
        payload_json: JSON.stringify({
          issue_id: 306,
          reason: "provider_rate_limited",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-306-attempt-1",
          retry_after_at: "2026-06-10T08:10:00Z",
          source_event_id: 7
        }),
        project_id: "demo",
        status: "approved"
      });
      await dispatchPiAction({ database: db, providers: { codex: provider } }, action);
  
      expect(provider.calls).toEqual([]);
      expect(getIssue(db, 306)).toMatchObject({
        auto_retry_next_at: "2026-06-10T08:10:00Z",
        auto_retry_reason: "provider_rate_limited",
        status: "in_progress"
      });
      expect(listIssueEvents(db, 306).map((event) => event.type)).toContain("issue.retry_after_scheduled");
    });
  
  test("issue.retry queues a stale issue and records supervisor result", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      const kickedProjects: string[] = [];
      insertProject(db, "demo", { autoRun: 1 });
      insertIssueRunSession(db, { issueID: 309, projectID: "demo", sessionID: "thread-309", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "issue.retry",
        id: "retry-action",
        issue_id: 309,
        payload_json: JSON.stringify({
          diagnosis_code: "provider_transient_network_error",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-309-attempt-1",
          issue_id: 309,
          reason: "transient provider disconnect"
        }),
        project_id: "demo",
        status: "approved"
      });
      db.sqlite.run("update issues set updated_at=? where id=309", ["2026-06-10T07:02:00Z"]);
  
      await dispatchPiAction({
        database: db,
        providers: { codex: provider },
        startProjectLoop: (_runtime, projectID) => kickedProjects.push(projectID)
      }, action);
  
      expect(getIssue(db, 309)).toMatchObject({ status: "todo", auto_retry_next_at: "" });
      expect(listIssueRuns(db, 309).at(-1)).toMatchObject({
        ended_at: expect.stringMatching(/Z$/),
        exit_reason: "superseded_by:xw:run:issue_runs:issue-309-attempt-2",
        status: "cancelled"
      });
      expect(listIssueEvents(db, 309).map((event) => event.type)).toEqual(expect.arrayContaining([
        "issue.status_changed",
        "issue.supervisor_retry"
      ]));
      expect(kickedProjects).toEqual(["demo"]);
      expect(listIssueSupervisorEvents(db, { issueId: 309 })).toContainEqual(expect.objectContaining({
        action_id: "retry-action",
        action_type: "issue.retry",
        event_type: "result"
      }));
    });
}
