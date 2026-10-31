import { expect, test } from "bun:test";
import { listNotifications } from "../../db/repositories/notifications.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { createPiAction } from "../../db/repositories/pi.ts";
import { EventBus } from "../../events/bus.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import type { TestFixture } from "./piActionDispatch.testFixture.ts";

export function registerIssueSupervisorDecisionRecordsPiCases(testScope: TestFixture) {
  const { fixtureDb, insertProject, insertIssueRunSession } = testScope;
  test("issue.supervisor_decision records PI judgement only", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 307, projectID: "demo", sessionID: "thread-307", turnID: "turn-old" });
      const beforeRun = listIssueRuns(db, 307).at(-1);
      const action = createPiAction(db, {
        action_type: "issue.supervisor_decision",
        id: "decision-action",
        issue_id: 307,
        payload_json: JSON.stringify({
          decision: { decision: "noop", rationale: "observe" },
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-307-attempt-1",
          issue_id: 307
        }),
        project_id: "demo",
        status: "approved"
      });
  
      await dispatchPiAction({ database: db }, action);
  
      expect(getIssue(db, 307)).toMatchObject({ status: "in_progress", auto_retry_next_at: "" });
      expect(listIssueRuns(db, 307).at(-1)).toEqual(beforeRun);
      expect(listIssueEvents(db, 307).map((event) => event.type)).toEqual(["issue.supervisor_decision"]);
    });
  
  test("needs_user.escalate writes a redacted comment notification and app event once", async () => {
      const db = await fixtureDb();
      const bus = new EventBus();
      const events: unknown[] = [];
      const stop = bus.observe((event) => events.push(event));
      try {
        insertProject(db, "demo");
        insertIssueRunSession(db, { issueID: 421, projectID: "demo", sessionID: "thread-421", turnID: "turn-421" });
        const action = createPiAction(db, {
          action_type: "needs_user.escalate",
          id: "needs-user-action",
          issue_id: 421,
          payload_json: JSON.stringify({
            diagnosis_code: "provider_auth_failed",
            issue_id: 421,
            message: "Codex auth failed TOKEN=secret-value\n    at leak (/Users/xiaobei/private/app.ts:1)",
            next_step: "Refresh provider credentials and retry issue #421.",
            provider: "codex"
          }),
          project_id: "demo",
          status: "approved"
        });
  
        await dispatchPiAction({ bus, database: db }, action);
        await dispatchPiAction({ bus, database: db }, action);
  
        const comments = listIssueEvents(db, 421).filter((item) => item.type === "issue.comment");
        const notifications = listNotifications(db, { projectID: "demo", unreadOnly: true });
        const text = JSON.stringify({ comments, events, notifications });
        expect(comments).toHaveLength(1);
        expect(JSON.parse(comments[0]?.payload ?? "{}")).toMatchObject({
          author: "agent",
          body: expect.stringContaining("#421「Supervisor issue」现在需要你处理")
        });
        expect(notifications).toMatchObject([
          expect.objectContaining({
            event: "pi.needs_user",
            issue_id: 421,
            message: expect.stringContaining("我没有继续自动重试"),
            read_at: ""
          })
        ]);
        expect(JSON.parse(String((events[0] as { payload?: string } | undefined)?.payload ?? "{}"))).toMatchObject({
          composer: "pi_needs_user_v1",
          user_facing_message: expect.stringContaining("当前执行记录是 issue=in_progress")
        });
        expect(getIssue(db, 421)).toMatchObject({ status: "needs_user" });
        expect(listIssueRuns(db, 421).at(-1)).toMatchObject({
          ended_at: expect.stringMatching(/Z$/),
          exit_reason: "pi_semantic_decision",
          status: "needs_user"
        });
        expect(events).toMatchObject([
          expect.objectContaining({ type: "pi.needs_user", issueId: 421, projectId: "demo" })
        ]);
        expect(text).toContain("provider 授权或账号状态需要确认");
        expect(text).toContain("Refresh provider credentials");
        expect(text).not.toContain("secret-value");
        expect(text).not.toContain("/Users/xiaobei");
        expect(text).not.toContain("at leak");
      } finally {
        stop();
      }
    });
  
  test("guardian needs_user skips stale issue preconditions without notifying", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 422, projectID: "demo", sessionID: "thread-422", turnID: "turn-422" });
      const action = createPiAction(db, {
        action_type: "needs_user.escalate",
        id: "needs-user-stale-action",
        issue_id: 422,
        payload_json: JSON.stringify({
          diagnosis_code: "requires_human_decision",
          expected_issue_updated_at: "2026-06-10T06:59:00Z",
          issue_id: 422,
          message: "stale escalation",
          provider: "codex"
        }),
        project_id: "demo",
        source: "pi_guardian_orchestrator",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db }, action)).resolves.toMatchObject({
        reason: "issue_changed",
        skipped: true
      });
  
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toEqual([]);
      expect(listIssueEvents(db, 422).filter((item) => item.type === "issue.comment")).toEqual([]);
      expect(getIssue(db, 422)).toMatchObject({ status: "in_progress" });
    });
  
  test("guardian needs_user revalidates stale snapshots and notifies when the current Run is terminal", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 424, projectID: "demo", sessionID: "thread-424", turnID: "turn-424" });
      db.sqlite.run(
        "update issues set status='failed', updated_at=? where id=?",
        ["2026-06-10T07:05:00Z", 424]
      );
      db.sqlite.run(
        "update issue_runs set status='failed', ended_at=? where issue_id=?",
        ["2026-06-10T07:05:00Z", 424]
      );
      const action = createPiAction(db, {
        action_type: "needs_user.escalate",
        id: "needs-user-terminal-revalidated",
        issue_id: 424,
        payload_json: JSON.stringify({
          diagnosis_code: "requires_human_decision",
          expected_issue_status: "in_progress",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-424-attempt-1",
          expected_run_status: "in_progress",
          issue_id: 424,
          message: "terminal escalation",
          provider: "codex"
        }),
        project_id: "demo",
        source: "pi_guardian_orchestrator",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db }, action)).resolves.toMatchObject({
        notification: expect.objectContaining({ issue_id: 424 })
      });
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toHaveLength(1);
      expect(listIssueEvents(db, 424).filter((item) => item.type === "issue.comment")).toHaveLength(1);
    });
  
  test("guardian needs_user waits while the executor session is still active", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 423, projectID: "demo", sessionID: "thread-423", turnID: "turn-423" });
      const now = new Date().toISOString();
      db.sqlite.run("update agent_sessions set updated_at=? where session_key=?", [now, "codex:thread-423"]);
      const action = createPiAction(db, {
        action_type: "needs_user.escalate",
        id: "needs-user-active-session-action",
        issue_id: 423,
        payload_json: JSON.stringify({
          diagnosis_code: "requires_human_decision",
          expected_issue_status: "in_progress",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_provider_session_id: "thread-423",
          expected_provider_turn_id: "turn-423",
          expected_run_id: "issue-423-attempt-1",
          expected_run_status: "in_progress",
          expected_session_status: "running",
          expected_session_turn_id: "turn-423",
          expected_session_updated_at: now,
          issue_id: 423,
          message: "active session escalation",
          provider: "codex"
        }),
        project_id: "demo",
        source: "pi_guardian_orchestrator",
        status: "approved"
      });
  
      await expect(dispatchPiAction({ database: db }, action)).resolves.toMatchObject({
        reason: "recent_session_activity",
        skipped: true
      });
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toEqual([]);
      expect(listIssueEvents(db, 423).filter((item) => item.type === "issue.comment")).toEqual([]);
      expect(getIssue(db, 423)).toMatchObject({ status: "in_progress" });
    });
}
