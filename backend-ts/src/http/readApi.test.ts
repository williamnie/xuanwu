import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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


  test("creates and updates projects with Go-compatible responses", async () => {
    const database = await openFixtureDatabase();
    const cwd = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-cwd-"));
    tempRoots.push(cwd);
    try {
      const router = createDefaultRouter({ database });

      const created = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST",
        body: JSON.stringify({ id: "demo", cwd }),
        headers: { "content-type": "application/json" }
      }));
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "demo",
        name: basename(cwd),
        cwd,
        provider: "codex",
        auto_run: 0,
        model: "codex-default",
        approval_policy: "never",
        sandbox: "workspace-write",
        sort_order: 1,
        loop_status: "stopped",
        provider_capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"]
      });

      const patched = await router.handle(new Request(`${BASE_URL}/api/projects/demo`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", provider: "CODEX" }),
        headers: { "content-type": "application/json" }
      }));
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ id: "demo", name: "Renamed", provider: "codex" });

      const projects = await router.handle(new Request(`${BASE_URL}/api/projects`));
      expect((await projects.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["demo"]);
    } finally {
      database.close();
    }
  });

  test("matches Go API failure paths for project writes", async () => {
    const database = await openFixtureDatabase();
    const cwd = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-cwd-"));
    tempRoots.push(cwd);
    try {
      const router = createDefaultRouter({ database });
      const withoutID = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ cwd })
      }));
      const invalidCWD = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ id: "bad", cwd: join(cwd, "missing") })
      }));
      await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ id: "demo", cwd })
      }));
      const duplicateCWD = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-cwd-"));
      tempRoots.push(duplicateCWD);
      const duplicateID = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ id: "demo", cwd: duplicateCWD })
      }));
      const missing = await router.handle(new Request(`${BASE_URL}/api/projects/missing`, {
        method: "PATCH", body: JSON.stringify({ name: "Missing" })
      }));

      expect(withoutID.status).toBe(400);
      expect(await withoutID.json()).toEqual({ message: "project id 不能为空" });
      expect(invalidCWD.status).toBe(400);
      expect(await invalidCWD.json()).toEqual({ message: "cwd 不存在" });
      expect(duplicateID.status).toBe(400);
      expect((await duplicateID.json() as { message: string }).message).toContain("UNIQUE constraint failed: projects.id");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
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

  test("creates issues with default triage status and persists creation history", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const router = createDefaultRouter({ database });

      const created = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({
          project_id: "demo",
          title: "Create API",
          description: "Issue body",
          priority: 4,
          template_id: "custom-template",
          prompt_template: "snapshot body",
          agent_profile_id: "Codex Pro!",
          source_session_id: "codex:thread-source",
          source_turn_id: "turn-source",
          source_excerpt: "讨论摘录",
          workflow_snapshot_json: '{"steps":[]}'
        }),
        headers: { "content-type": "application/json" }
      }));
      const createdIssue = await created.json() as Record<string, unknown>;
      const readBack = await router.handle(new Request(`${BASE_URL}/api/issues/${createdIssue.id}`));
      const list = await router.handle(new Request(`${BASE_URL}/api/issues?projectId=demo&status=triage`));
      const event = database.sqlite.query<{ type: string; payload: string }, []>(
        "select type, payload from issue_events order by id asc"
      ).get();

      expect(created.status).toBe(201);
      expect(createdIssue).toMatchObject({
        project_id: "demo",
        title: "Create API",
        description: "Issue body",
        status: "triage",
        priority: 4,
        template_id: "custom-template",
        prompt_template: "snapshot body",
        agent_profile_id: "codex-pro",
        source_session_id: "thread-source",
        source_turn_id: "turn-source",
        source_excerpt: "讨论摘录",
        workflow_snapshot_json: '{"steps":[]}'
      });
      expect(await readBack.json()).toMatchObject(createdIssue);
      expect((await list.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([createdIssue.id]);
      expect(event).toEqual({ type: "issue.created", payload: "" });
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid issue create payloads", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const router = createDefaultRouter({ database });
      const missingProject = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "missing", title: "bad" })
      }));
      const invalidStatus = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "demo", title: "bad", status: "bogus" })
      }));

      expect(missingProject.status).toBe(404);
      expect(await missingProject.json()).toEqual({ message: "资源不存在" });
      expect(invalidStatus.status).toBe(400);
      expect(await invalidStatus.json()).toEqual({ message: "status 不合法" });
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
