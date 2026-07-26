import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { getProject, listProjects } from "./projects.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-projects-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("project read repository", () => {
  test("returns an empty project list", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(listProjects(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("lists and gets projects using frontend-compatible field names", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, {
        id: "later",
        name: "Later",
        cwd: "/tmp/later",
        sort_order: 2,
        created_at: "2026-01-02T00:00:00Z"
      });
      insertProject(db, {
        id: "demo",
        name: "Demo",
        cwd: "/tmp/demo",
        sort_order: 1,
        created_at: "2026-01-01T00:00:00Z"
      });

      expect(listProjects(db).map((project) => project.id)).toEqual(["demo", "later"]);
      expect(getProject(db, "demo")).toEqual({
        id: "demo",
        name: "Demo",
        cwd: "/tmp/demo",
        provider: "codex",
        provider_config_json: "{}",
        auto_run: 0,
        model: "codex-default",
        approval_policy: "never",
        pi_managed: 0,
        sandbox: "workspace-write",
        default_agent_profile_id: "",
        default_mcp_policy: "{}",
        default_service_tier: "",
        default_skill_policy: "{}",
        loop_status: "stopped",
        sort_order: 1,
        provider_capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z"
      });
      expect(getProject(db, "missing")).toBeNull();
    } finally {
      db.close();
    }
  });
});

type ProjectFixture = {
  created_at: string;
  cwd: string;
  id: string;
  name: string;
  sort_order: number;
};

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [project.id, project.name, project.cwd, project.sort_order, project.created_at, project.created_at]
  );
}
