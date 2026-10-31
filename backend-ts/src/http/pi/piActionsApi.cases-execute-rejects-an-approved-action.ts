import { expect, test } from "bun:test";
import { getIssue, listIssues } from "../../db/repositories/issues.ts";
import { createPiAction, getPiAction } from "../../db/repositories/pi.ts";
import { createPiRunnerActions } from "../../pi/runnerTools/runnerActions.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piActionsApi.testFixture.ts";

export function registerExecuteRejectsAnApprovedActionCases(testScope: TestFixture) {
  const { openFixtureDatabase, batchItem, postAction, insertAgentProfile, insertProject, insertIssue, insertAgentSession, listEvents, mustGetProject, SessionSteerProvider } = testScope;
  test("execute rejects an approved action after its approval lease expires", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      createPiAction(database, {
        action_type: "issue.enqueue",
        expected_state_json: JSON.stringify({
          issue_id: issueID,
          project_id: "demo",
          status: "triage",
          updated_at: "2026-01-01T00:00:00Z"
        }),
        gate_decision: "ask",
        id: "expired-approved-action",
        issue_id: issueID,
        lease_expires_at: "2026-01-02T00:00:00Z",
        payload_json: JSON.stringify({ issue_id: issueID }),
        project_id: "demo",
        status: "approved"
      });
  
      const response = await postAction(createDefaultRouter({ database }), "expired-approved-action", "execute");
  
      expect(response.status).toBe(409);
      expect(getPiAction(database, "expired-approved-action")).toMatchObject({
        decided_by: "system:action_revalidation",
        status: "rejected"
      });
      expect(getPiAction(database, "expired-approved-action")?.result_json).toContain("dispatch:approval_expired");
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    });
  
  test("approve executes issue state repair proposals through dispatcher", async () => {
      const database = await openFixtureDatabase();
      try {
        insertProject(database, "demo");
        const project = mustGetProject(database, "demo");
        const issueID = insertIssue(database, project.id, { status: "in_progress" });
        database.sqlite.run(`insert into issue_runs
        (id, issue_id, attempt, status, provider, started_at, ended_at, exit_reason)
        values (?, ?, 1, 'done', 'codex', ?, ?, 'completed')`, [
          `run-${issueID}`, issueID, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"
        ]);
        const action = createPiRunnerActions(database, { project })
          .createIssueStateRepairProposal({
            diagnosis_code: "in_progress_session_ended",
            issue_id: issueID,
            operation: "request_pi_decision"
          }) as { action_id: string };
  
        const response = await postAction(createDefaultRouter({ database }), action.action_id, "approve");
  
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
        expect(getIssue(database, issueID)).toMatchObject({ status: "in_progress", error: "" });
        expect(listEvents(database).map((event) => event.type)).toEqual([
          "issue.pi_acceptance_requested.v1",
          "issue.state_manager_repair"
        ]);
      } finally {
        database.close();
      }
    });
  
  test("approve creates issue proposal with rendered repo context pack body", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const action = createPiRunnerActions(database, { project })
        .createIssueProposal({
          context_pack: {
            acceptance_criteria: ["User can collapse panel"],
            evidence: [{
              excerpt: "SECRET=super-secret\nexport function Panel() {}",
              path: "src/Panel.tsx",
              source_kind: "code",
              summary: "Panel component"
            }],
            intent: "Implement accordion panel",
            project: { id: "demo" },
            proposed_changes: ["Add accessible toggle"],
            validation: ["bun test src/Panel.test.tsx"]
          },
          description: "Need implementation\nTOKEN=must-not-leak",
          open_questions: ["默认展开吗？"],
          project_id: project.id,
          title: "Repo context issue"
        }) as { action_id: string };
      const router = createDefaultRouter({ database });
  
      const response = await postAction(router, action.action_id, "approve");
      const created = listIssues(database, { projectId: "demo" }).find((issue) => issue.title === "Repo context issue");
  
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(created).toMatchObject({ status: "triage", title: "Repo context issue" });
      expect(created?.description).toContain("## 一句话目标");
      expect(created?.description).toContain("## 相关证据");
      expect(created?.description).toContain("src/Panel.tsx");
      expect(created?.description).toContain("bun test src/Panel.test.tsx");
      expect(created?.description).not.toContain("super-secret");
      expect(created?.description).not.toContain("must-not-leak");
    });
  
  test("approve materializes a reviewed detailed issue batch and its dependency DAG exactly once", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const action = createPiRunnerActions(database, { project }).createIssueBatchProposal({
        project_id: "demo",
        rationale: "reviewed PRD plan",
        items: [
          batchItem("contract", "固定领域合同"),
          { ...batchItem("api", "实现任务 API"), depends_on_refs: ["contract"] }
        ]
      }) as { action_id: string; status: string };
      const router = createDefaultRouter({ database });
  
      expect(action.status).toBe("pending");
      expect(listIssues(database, { projectId: "demo" })).toHaveLength(0);
      const first = await postAction(router, action.action_id, "approve");
      const second = await postAction(router, action.action_id, "approve");
      const issues = listIssues(database, { projectId: "demo" });
  
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(await second.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(issues).toHaveLength(2);
      expect(issues.map((issue) => issue.status)).toEqual(["triage", "triage"]);
      expect(JSON.parse(database.sqlite.query<{ dependency_issue_ids_json: string }, [number]>(
        "select dependency_issue_ids_json from issues where id=?"
      ).get(issues[1]?.id ?? 0)?.dependency_issue_ids_json ?? "[]")).toEqual([issues[0]?.id]);
    });
  
  test("execute steers approved session actions through provider once", async () => {
      const database = await openFixtureDatabase();
      const provider = new SessionSteerProvider();
      insertProject(database, "demo");
      insertAgentSession(database, "demo", "codex:thread-1", "turn-1");
      createPiAction(database, {
        id: "steer-action",
        action_type: "session.steer", gate_decision: "ask",
        project_id: "demo",
        status: "approved",
        payload_json: JSON.stringify({ prompt: "adjust plan", session_key: "codex:thread-1" })
      });
      const router = createDefaultRouter({ database, providers: { codex: provider } });
  
      const first = await postAction(router, "steer-action", "execute");
      const second = await postAction(router, "steer-action", "execute");
  
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toMatchObject({ id: "steer-action", status: "completed" });
      expect(await second.json()).toMatchObject({ id: "steer-action", status: "completed" });
      expect(provider.calls).toEqual([{ mode: "steer", prompt: "adjust plan", sessionId: "thread-1", turnId: "turn-1" }]);
      expect(getPiAction(database, "steer-action")?.result_json).toContain("turn-steered");
    });
  
  test("approve executes profile assignment and needs_user escalation actions", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id, { status: "needs_user" });
      insertAgentProfile(database, "executor-codex");
      const actions = createPiRunnerActions(database, { project });
      const assign = actions.assignExecutorProfileProposal({
        agent_profile_id: "executor-codex",
        issue_id: issueID,
        rationale: "use executor profile"
      }) as { action_id: string };
      const escalation = actions.escalateNeedsUser({
        issue_id: issueID,
        reason: "missing approval",
        requested_action: "confirm deploy window"
      }) as { action_id: string };
      const router = createDefaultRouter({ database });
  
      const assigned = await postAction(router, assign.action_id, "approve");
      const escalated = await postAction(router, escalation.action_id, "approve");
  
      expect(assigned.status).toBe(200);
      expect(escalated.status).toBe(200);
      expect(await escalated.json()).toMatchObject({ id: escalation.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ agent_profile_id: "executor-codex" });
      expect(listEvents(database).map((event) => event.type)).toEqual(["issue.comment"]);
      expect(listEvents(database)[0]?.payload).toContain("needs_user");
    });
}
