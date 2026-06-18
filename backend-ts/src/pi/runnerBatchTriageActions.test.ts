import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { listPiActionEvents, listPiActions, listPiRunGroupItems, listPiRunGroups } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";

describe("PI batch triage enqueue ranges", () => {
  test("delegated runner chat enqueues the requested issue range in order", async () => {
    const fixture = await openFixture();
    const kickedProjects: string[] = [];
    try {
      insertProject(fixture.db, "other", `${fixture.project.cwd}-other`);
      insertIssue(fixture.db, { id: 386, projectID: fixture.project.id, status: "done", title: "Already done" });
      const requested = [387, 388, 389, 390, 391];
      for (const id of requested) {
        insertIssue(fixture.db, { id, projectID: fixture.project.id, status: "triage", title: `P26.${id}` });
      }
      insertIssue(fixture.db, { id: 392, projectID: fixture.project.id, status: "triage", title: "Outside range" });
      insertIssue(fixture.db, { id: 3890, projectID: "other", status: "triage", title: "Other project" });
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
        project: fixture.project,
        source: "runner_chat"
      });

      const result = actions.enqueueBatchTriageIssues({
        user_phrase: "把 #387-#391 都开始做"
      }) as {
        enqueued: Array<{ id: number; status: string; title: string }>;
        enqueued_count: number;
        run_group_id: string;
        status: string;
      };

      const actionsForBatch = listPiActions(fixture.db, { status: "completed" });
      const runGroups = listPiRunGroups(fixture.db, { projectId: fixture.project.id });
      const runGroupID = runGroups[0]?.id ?? "";

      expect(result).toMatchObject({
        enqueued: requested.map((id) => ({ id, status: "todo", title: `P26.${id}` })),
        enqueued_count: 5,
        run_group_id: runGroupID,
        status: "completed"
      });
      expect(runGroups).toMatchObject([
        { expected_issue_count: 5, project_id: fixture.project.id, status: "active", user_phrase: "把 #387-#391 都开始做" }
      ]);
      expect(listPiRunGroupItems(fixture.db, runGroupID)).toMatchObject(requested.map((id, index) => ({
        enqueue_action_id: actionsForBatch.find((action) => action.issue_id === id)?.id,
        enqueue_status: "pending",
        issue_id: id,
        issue_title_snapshot: `P26.${id}`,
        position: index + 1,
        report_bucket: "active",
        report_status: "active",
        status: "active"
      })));
      expect(requested.map((id) => getIssue(fixture.db, id)?.status)).toEqual([
        "todo", "todo", "todo", "todo", "todo"
      ]);
      expect(getIssue(fixture.db, 392)).toMatchObject({ status: "triage" });
      expect(getIssue(fixture.db, 3890)).toMatchObject({ status: "triage" });
      expect(kickedProjects).toEqual([fixture.project.id]);
      expect(actionsForBatch.map((item) => item.issue_id).sort((a, b) => a - b)).toEqual(requested);
      for (const action of actionsForBatch) {
        expect(JSON.parse(action.payload_json)).toMatchObject({ run_group_id: runGroupID });
        expect(listPiActionEvents(fixture.db, { actionId: action.id }).map((event) => JSON.parse(event.payload_json)))
          .toContainEqual(expect.objectContaining({
            payload: expect.objectContaining({ run_group_id: runGroupID })
          }));
      }
      expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "todo" }).map((item) => item.id).sort((a, b) => a - b))
        .toEqual(requested);
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-batch-triage-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db, "demo", join(root, "project"));
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, id === "demo" ? 1 : 2, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(
  db: RunnerDatabase,
  input: { id: number; projectID: string; status: string; title: string }
): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, description, status, priority, created_at, updated_at)
     values (?, ?, ?, '', ?, ?, ?, ?)`,
    [input.id, input.projectID, input.title, input.status, 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
