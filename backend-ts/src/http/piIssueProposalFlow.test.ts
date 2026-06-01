import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues, type Issue } from "../db/repositories/issues.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-issue-flow-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI issue proposal refinement/comment flow", () => {
  test("creates triage proposal and keeps refinement/comment readable in issue detail", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const actions = createPiRunnerActions(database, { project });
      const createAction = actions.createIssueProposal({
        acceptance_criteria: "- 用户可验收",
        description: "新增 proposal body",
        title: "PI proposal",
        verification_plan: "bun test"
      }) as { action_id: string };
      const refinementAction = actions.createUpdateRefinementProposal({
        issue_id: issueID,
        acceptance_criteria: "- 已细化",
        problem: "需要补 refinement",
        verification_plan: "bun test"
      }) as { action_id: string };
      const comment = actions.commentIssue({ issue_id: issueID, body: "Looks actionable." });
      const router = createDefaultRouter({ database });

      const created = await postAction(router, createAction.action_id, "approve");
      const refined = await postAction(router, refinementAction.action_id, "approve");
      const issues = listIssues(database, { projectId: project.id });

      expect(created.status).toBe(200);
      expect(refined.status).toBe(200);
      expect(await created.json()).toMatchObject({ id: createAction.action_id, status: "completed" });
      expect(await refined.json()).toMatchObject({ id: refinementAction.action_id, status: "completed" });
      expect(comment).toMatchObject({ type: "issue.comment", issue_id: issueID });
      expect(issues).toHaveLength(2);
      expect(findIssue(issues, "PI proposal")).toMatchObject({ status: "triage" });
      expect(getIssue(database, issueID)?.description).toContain("### Acceptance criteria\n- 已细化");
      expect(getIssue(database, issueID)?.comment_count).toBe(1);
      expect(listEvents(database).map((event) => event.type)).toEqual(["issue.comment", "issue.created"]);
    } finally {
      database.close();
    }
  });
});

function postAction(
  router: ReturnType<typeof createDefaultRouter>,
  id: string,
  action: string
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/pi/actions/${id}/${action}`, { method: "POST" }));
}

function findIssue(issues: Issue[], title: string): Issue | undefined {
  return issues.find((issue) => issue.title === title);
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

function listEvents(db: RunnerDatabase): Array<{ type: string }> {
  return db.sqlite.query<{ type: string }, []>("select type from issue_events order by id asc").all();
}

function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("missing project");
  return project;
}
