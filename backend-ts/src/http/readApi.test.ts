import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-read-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun projects/issues read API", () => {
  test("exposes frontend-compatible project and issue read endpoints", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      insertProject(database, { id: "other", name: "Other", sortOrder: 2 });
      const issueId = insertIssue(database, {
        projectId: "demo",
        title: "Read API",
        status: "todo",
        sourceSessionId: "thread-a"
      });
      insertIssue(database, {
        projectId: "other",
        title: "Hidden",
        status: "triage",
        sourceSessionId: "thread-b"
      });

      const router = createDefaultRouter({ database });
      const projects = await router.handle(new Request(`${BASE_URL}/api/projects`));
      const issues = await router.handle(new Request(`${BASE_URL}/api/issues?projectId=demo&sourceSessionId=codex:thread-a`));
      const issue = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));

      expect(projects.status).toBe(200);
      const projectBody = await projects.json() as Array<Record<string, unknown>>;
      expect(projectBody.map((project) => project.id)).toEqual(["demo", "other"]);
      expect(projectBody[0]).toMatchObject({
        id: "demo",
        loop_status: "stopped",
        provider_capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"]
      });
      expect(issues.status).toBe(200);
      expect((await issues.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([issueId]);
      expect(issue.status).toBe(200);
      expect(await issue.json()).toMatchObject({
        id: issueId,
        project_id: "demo",
        title: "Read API",
        source_session_id: "thread-a",
        comment_count: 0
      });
    } finally {
      database.close();
    }
  });

  test("matches Go API failure status for invalid and missing issue ids", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const invalid = await router.handle(new Request(`${BASE_URL}/api/issues/not-a-number`));
      const missing = await router.handle(new Request(`${BASE_URL}/api/issues/404`));
      const unsupported = await router.handle(new Request(`${BASE_URL}/api/issues`, { method: "DELETE" }));

      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ message: "issue id 不合法" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toEqual({ message: "method not allowed" });
    } finally {
      database.close();
    }
  });
});

type ProjectFixture = { id: string; name: string; sortOrder: number };
type IssueFixture = { projectId: string; sourceSessionId: string; status: string; title: string };

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [project.id, project.name, `/tmp/${project.id}`, project.sortOrder, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, source_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [issue.projectId, issue.title, issue.status, issue.sourceSessionId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
