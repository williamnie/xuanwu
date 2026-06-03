import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createPiAction, getPiAction, listPiActionEvents } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-actions-audit-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI action audit API", () => {
  test("request changes and snooze keep approvals pending with audit timeline", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const router = createDefaultRouter({ database });

      const changes = await postAction(router, action.action_id, "request-changes", {
        comment: "Need a narrower verification plan"
      });
      const snoozed = await postAction(router, action.action_id, "snooze", {
        until: "2026-06-03T00:00:00Z",
        reason: "wait for maintainer window"
      });
      const events = listPiActionEvents(database, { actionId: action.action_id });

      expect(changes.status).toBe(200);
      expect(await changes.json()).toMatchObject({
        id: action.action_id,
        requested_changes: "Need a narrower verification plan",
        status: "changes_requested"
      });
      expect(snoozed.status).toBe(200);
      expect(await snoozed.json()).toMatchObject({
        id: action.action_id,
        snoozed_until: "2026-06-03T00:00:00Z",
        status: "snoozed"
      });
      expect(events.map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval",
        "approval_decision",
        "approval_decision"
      ]);
      expect(events.at(-1)).toMatchObject({ decision: "snooze", reason: "wait for maintainer window" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    } finally {
      database.close();
    }
  });

  test("snooze requires a next reminder time", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const router = createDefaultRouter({ database });

      const response = await postAction(router, action.action_id, "snooze", { reason: "later" });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        message: expect.stringContaining("snoozed_until")
      });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    } finally {
      database.close();
    }
  });

  test("execute refuses approved actions that never passed the approval gate", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      createPiAction(database, {
        id: "ungated-approved",
        action_type: "issue.enqueue",
        project_id: "demo",
        status: "approved",
        payload_json: JSON.stringify({ issue_id: issueID })
      });

      const response = await postAction(createDefaultRouter({ database }), "ungated-approved", "execute", {});

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        message: expect.stringContaining("approval gate")
      });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    } finally {
      database.close();
    }
  });

  test("approve refuses actions denied by the gate", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      createPiAction(database, {
        id: "denied-action",
        action_type: "issue.enqueue",
        gate_decision: "deny",
        gate_reason: "action is forbidden by policy",
        project_id: "demo",
        status: "denied",
        payload_json: JSON.stringify({ issue_id: issueID })
      });

      const response = await postAction(createDefaultRouter({ database }), "denied-action", "approve", {});

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        message: expect.stringContaining("denied")
      });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    } finally {
      database.close();
    }
  });

  test("approve returns a clear error for snoozed or changes-requested actions", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const changes = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID }) as { action_id: string };
      const snoozed = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID }) as { action_id: string };
      const router = createDefaultRouter({ database });
      await postAction(router, changes.action_id, "request-changes", { comment: "revise first" });
      await postAction(router, snoozed.action_id, "snooze", { until: "2026-06-03T12:00:00Z" });

      const approveChanges = await postAction(router, changes.action_id, "approve", {});
      const approveSnooze = await postAction(router, snoozed.action_id, "approve", {});

      expect(approveChanges.status).toBe(409);
      expect(approveSnooze.status).toBe(409);
      expect(getPiAction(database, changes.action_id)).toMatchObject({ status: "changes_requested" });
      expect(getPiAction(database, snoozed.action_id)).toMatchObject({ status: "snoozed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    } finally {
      database.close();
    }
  });

  test("approve leaves ungated pending actions unchanged", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      createPiAction(database, {
        id: "ungated-pending",
        action_type: "issue.enqueue",
        project_id: "demo",
        status: "pending",
        payload_json: JSON.stringify({ issue_id: issueID })
      });

      const response = await postAction(createDefaultRouter({ database }), "ungated-pending", "approve", {});

      expect(response.status).toBe(409);
      expect(getPiAction(database, "ungated-pending")).toMatchObject({ status: "pending" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
    } finally {
      database.close();
    }
  });

  test("audit timeline endpoint returns action events across actions", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const router = createDefaultRouter({ database });

      const byAction = await router.handle(new Request(`${BASE_URL}/api/pi/actions/${action.action_id}/events`));
      const byProject = await router.handle(new Request(`${BASE_URL}/api/pi/audit-events?project_id=demo`));

      expect(byAction.status).toBe(200);
      expect((await byAction.json() as Array<Record<string, unknown>>).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval"
      ]);
      expect(byProject.status).toBe(200);
      expect((await byProject.json() as Array<Record<string, unknown>>).map((event) => event.action_id)).toEqual([
        action.action_id,
        action.action_id,
        action.action_id
      ]);
    } finally {
      database.close();
    }
  });

  test("audit timeline endpoint filters by delegation and redacts secrets", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      createPiAction(database, {
        id: "delegated-secret-action",
        action_type: "issue.comment",
        delegation_id: "delegation-a",
        issue_id: issueID,
        project_id: "demo",
        status: "failed"
      });
      database.sqlite.run(
        `insert into pi_action_events
          (action_id, project_id, issue_id, event_type, actor, reason, payload_json, result_json, error, delegation_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["delegated-secret-action", "demo", issueID, "execution_error", "executor",
          "failed with Authorization: Bearer bearer-secret",
          JSON.stringify({ token: "payload-secret", cwd: "/Users/secret/project" }),
          JSON.stringify({ path: "/tmp/secret/out.txt" }),
          "OPENAI_API_KEY=error-secret at /Users/secret/log.txt",
          "delegation-a", "2026-01-01T00:00:00Z"]
      );
      database.sqlite.run(
        `insert into pi_action_events
          (action_id, project_id, issue_id, event_type, delegation_id, created_at)
         values (?, ?, ?, ?, ?, ?)`,
        ["other-action", "demo", issueID, "gate_decision", "delegation-b", "2026-01-01T00:00:01Z"]
      );

      const response = await createDefaultRouter({ database }).handle(
        new Request(`${BASE_URL}/api/pi/audit-events?project_id=demo&issue_id=${issueID}&delegation_id=delegation-a`)
      );
      const body = await response.json() as Array<Record<string, unknown>>;
      const text = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.map((event) => event.action_id)).toEqual(["delegated-secret-action"]);
      expect(text).toContain("[redacted]");
      expect(text).toContain("[redacted-path]");
      expect(text).not.toContain("bearer-secret");
      expect(text).not.toContain("payload-secret");
      expect(text).not.toContain("error-secret");
      expect(text).not.toContain("/Users/secret");
      expect(text).not.toContain("/tmp/secret");
    } finally {
      database.close();
    }
  });
});

function postAction(
  router: ReturnType<typeof createDefaultRouter>,
  id: string,
  action: "approve" | "execute" | "request-changes" | "snooze",
  body: Record<string, unknown>
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/pi/actions/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, "Queue me", "triage", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("missing project");
  return project;
}
