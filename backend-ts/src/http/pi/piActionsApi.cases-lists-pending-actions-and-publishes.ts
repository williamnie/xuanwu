import { expect, test } from "bun:test";
import { getIssue } from "../../db/repositories/issues.ts";
import { createPiAction, getPiAction, listPiActions, updatePiAction } from "../../db/repositories/pi.ts";
import { EventBus } from "../../events/bus.ts";
import { createPiRunnerActions } from "../../pi/runnerTools/runnerActions.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piActionsApi.testFixture.ts";

export function registerListsPendingActionsAndPublishesCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureDatabase, postAction, createPiActionsRouter, insertProject, insertIssue, listEvents, mustGetProject, KickObserverProvider } = testScope;
  test("lists pending actions and publishes PI action SSE events", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const bus = new EventBus();
      const router = createDefaultRouter({ bus, database });
      const stream = await router.handle(new Request(`${BASE_URL}/api/events`));
      const reader = stream.body?.getReader();
      await reader?.read();
  
      const action = createPiRunnerActions(database, {
        bus,
        conversationID: "conv-1",
        project
      }).enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
  
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/actions?project_id=demo&status=pending`));
  
      expect(response.status).toBe(200);
      expect((await response.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([action.action_id]);
      expect(listPiActions(database, { status: "pending" })).toHaveLength(1);
      const event = await reader?.read();
      await reader?.cancel();
      const text = new TextDecoder().decode(event?.value);
      expect(text).toContain('"type":"pi.action_pending"');
      expect(text).toContain(`\\"action_id\\":\\"${action.action_id}\\"`);
      expect(text).toContain('\\"risk_level\\":\\"medium\\"');
    });
  
  test("approve executes a pending action once and is idempotent", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const bus = new EventBus();
      const events = bus.subscribe();
      const router = createDefaultRouter({ bus, database });
  
      const first = await postAction(router, action.action_id, "approve");
      const second = await postAction(router, action.action_id, "approve");
  
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.headers.get("deprecation")).toBe("true");
      expect(first.headers.get("link")).toContain("/api/command-center/summary?sections=attention");
      expect(await first.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(await second.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(listEvents(database).map((event) => event.type)).toEqual(["issue.status_changed"]);
      expect((await events.next())?.type).toBe("pi.action_approved");
      expect((await events.next())?.type).toBe("pi.action_executing");
      expect((await events.next())?.type).toBe("pi.action_completed");
      events.close();
    });
  
  test("rejects a pending enqueue when the Issue changed after the request", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const stored = getPiAction(database, action.action_id);
      expect(JSON.parse(stored?.expected_state_json ?? "{}")).toMatchObject({
        issue_id: issueID,
        project_id: project.id,
        status: "triage",
        updated_at: "2026-01-01T00:00:00Z"
      });
      database.sqlite.run("update issues set status='done', updated_at=? where id=?", [
        "2026-01-02T00:00:00Z", issueID
      ]);
  
      const response = await postAction(createDefaultRouter({ database }), action.action_id, "approve");
  
      expect(response.status).toBe(409);
      expect(getPiAction(database, action.action_id)).toMatchObject({
        decided_by: "system:action_revalidation",
        status: "rejected"
      });
      expect(getIssue(database, issueID)).toMatchObject({ status: "done" });
      expect(database.sqlite.query<{ reason: string }, [string]>(
        "select reason from pi_action_events where action_id=? and event_type='approval_stale'"
      ).get(action.action_id)?.reason).toContain("target_state_changed:triage->done");
    });
  
  test("rejects an older pending enqueue after a newer retry completed", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const old = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "first request" }) as { action_id: string };
      database.sqlite.run("update pi_actions set created_at=? where id=?", [
        "2026-01-01T00:00:01Z", old.action_id
      ]);
      const retry = createPiRunnerActions(database, {
        authorization: {
          allowedActions: ["issue.enqueue"],
          askOnMissingAuthorization: true,
          authorizedActions: [],
          mode: "delegated",
          scopes: [{ runner_resource: "issues" }]
        },
        project,
        source: "runner_chat"
      }).enqueueIssueProposal({ issue_id: issueID, rationale: "retry" }) as { action_id: string; status: string };
  
      const response = await postAction(createDefaultRouter({ database }), old.action_id, "approve");
  
      expect(retry.status).toBe("completed");
      expect(response.status).toBe(409);
      expect(getPiAction(database, old.action_id)).toMatchObject({ status: "rejected" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(database.sqlite.query<{ reason: string }, [string]>(
        "select reason from pi_action_events where action_id=? and event_type='approval_stale'"
      ).get(old.action_id)?.reason).toContain(`superseded_by:${retry.action_id}`);
    });
  
  test("approve issue.enqueue action kicks auto-run project loop through HTTP API", async () => {
      const database = await openFixtureDatabase();
      const provider = new KickObserverProvider();
      insertProject(database, "auto-demo", { autoRun: 1 });
      const project = mustGetProject(database, "auto-demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const kickedProjects: string[] = [];
      const router = createPiActionsRouter(database, provider, kickedProjects);
  
      const response = await postAction(router, action.action_id, "approve");
  
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(kickedProjects).toEqual(["auto-demo"]);
      expect(provider.inputs).toEqual([]);
    });
  
  test("approve issue.enqueue action does not kick manual project loop", async () => {
      const database = await openFixtureDatabase();
      const provider = new KickObserverProvider();
      insertProject(database, "manual-demo", { autoRun: 0 });
      const project = mustGetProject(database, "manual-demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const kickedProjects: string[] = [];
      const router = createPiActionsRouter(database, provider, kickedProjects);
  
      const response = await postAction(router, action.action_id, "approve");
  
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(kickedProjects).toEqual([]);
      expect(provider.inputs).toEqual([]);
    });
  
  test("reject does not execute the pending payload", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "not yet" }) as { action_id: string };
  
      const response = await postAction(createDefaultRouter({ database }), action.action_id, "reject");
  
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "rejected" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
      expect(listEvents(database)).toEqual([]);
    });
  
  test("execute rejects approved actions whose target no longer exists", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID }) as { action_id: string };
      updatePiAction(database, action.action_id, { status: "approved" });
      createPiAction(database, {
        id: "bad-action",
        action_type: "issue.enqueue", gate_decision: "ask",
        status: "approved",
        payload_json: JSON.stringify({ issue_id: 9999 })
      });
      const router = createDefaultRouter({ database });
  
      const completed = await postAction(router, action.action_id, "execute");
      const failed = await postAction(router, "bad-action", "execute");
  
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(failed.status).toBe(409);
      expect(getPiAction(database, "bad-action")).toMatchObject({
        decided_by: "system:action_revalidation",
        status: "rejected"
      });
      expect(getPiAction(database, "bad-action")?.result_json).toContain("target_issue_missing");
    });
}
