import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";

describe("PI runner action gate", () => {
  test("delegated mode only auto-executes actions covered by an authorization envelope", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Delegated" });
      const denied = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: issueID + 1, project_id: fixture.project.id }],
          mode: "delegated"
        },
        project: fixture.project
      }).commentIssue({ issue_id: issueID, body: "not covered" }) as { action_id: string; decision: string; status: string };
      const allowed = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated"
        },
        project: fixture.project
      }).commentIssue({ issue_id: issueID, body: "covered" }) as { action_id: string; decision: string; status: string };
      const allowedAction = listPiActions(fixture.db).find((action) => action.gate_decision === "execute");

      expect(denied).toMatchObject({ decision: "deny", status: "denied" });
      expect(allowed).toMatchObject({ type: "issue.comment", issue_id: issueID });
      expect(allowedAction).toMatchObject({
        action_type: "issue.comment",
        gate_decision: "execute",
        status: "completed"
      });
      expect(listIssueEvents(fixture.db, issueID).map((event) => event.payload)).toEqual([
        expect.stringContaining("covered")
      ]);
      expect(listPiActionEvents(fixture.db, { actionId: denied.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision"
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("delegated authorization auto-executes covered confirm action proposals", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Ready" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated"
        },
        project: fixture.project
      });
      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "delegated ready" }) as {
        action_id: string; decision: string; status: string;
      };
      const stored = getPiAction(fixture.db, result.action_id);

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(stored).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(listPiActionEvents(fixture.db, { actionId: result.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-action-gate-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function insertIssue(db: RunnerDatabase, input: { projectID: string; status: string; title: string }): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [input.projectID, input.title, input.status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
