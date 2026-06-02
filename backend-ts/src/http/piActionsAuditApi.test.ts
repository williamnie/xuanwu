import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
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
});

function postAction(
  router: ReturnType<typeof createDefaultRouter>,
  id: string,
  action: "request-changes" | "snooze",
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
