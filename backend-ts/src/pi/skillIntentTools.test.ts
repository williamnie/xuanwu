import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { createPiRunnerActionTools } from "./runnerActionTools.ts";

const tempRoots: string[] = [];
const previousCodexHome = Bun.env.CODEX_HOME;

afterEach(async () => {
  if (previousCodexHome === undefined) delete Bun.env.CODEX_HOME;
  else Bun.env.CODEX_HOME = previousCodexHome;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI skill intent tools", () => {
  test("lists, reads, recommends, and audits skill intents through PI tools", async () => {
    const { db, project, root } = await openFixture();
    await writeSkill(root, "codex-issue-runner", "Use when working on runner PI issues and verification.");
    await writeSkill(root, "local-fixture", "Use when local fixture skill metadata should be visible.");
    await writeBadSkill(root, "broken");
    Bun.env.CODEX_HOME = root;
    try {
      const issueID = insertIssue(db, project.id, "todo", "PI runner issue");
      const tools = createPiRunnerActionTools(createPiRunnerActions(db, { project }));

      expect(toolNames(tools)).toEqual(expect.arrayContaining([
        "skill_list", "skill_read", "skill_recommend", "skill_intent_audit"
      ]));
      expect(validateToolArguments(toolByName(tools, "skill_read") as never, { name: "skill_read", arguments: { id: "codex-issue-runner" } } as never))
        .toEqual({ id: "codex-issue-runner" });
      const recommend = await runTool(tools, "skill_recommend", {
        description: "Runner PI issue needs verification",
        project_id: project.id,
        title: "PI runner"
      });
      const list = await runTool(tools, "skill_list", {});
      const audit = await runTool(tools, "skill_intent_audit", { issue_id: issueID });

      expect(list.details.items.map((item: { id: string }) => item.id)).toContain("local-fixture");
      expect(list.details.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing_front_matter", source_path: "codex-home:broken/SKILL.md" })
      ]));
      expect(JSON.stringify(list.details)).not.toContain(root);
      expect(recommend.details.items.map((item: { id: string }) => item.id)).toContain("codex-issue-runner");
      expect(recommend.details.items.every((item: Record<string, unknown>) => item.instructions === undefined)).toBe(true);
      expect(JSON.stringify(recommend.details).length).toBeLessThan(8_192);
      expect(audit.details).toMatchObject({ issue_id: issueID, status: "ok" });
    } finally {
      db.close();
    }
  });

  test("delegated issue proposals deny skill intents outside the authorization allowlist", async () => {
    const { db, project } = await openFixture();
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowedSkillIntents: ["codex-issue-runner"],
          authorizedActions: [{ action_type: "issue.create", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        project
      });

      const denied = actions.createIssueProposal({
        description: "Needs browser skill",
        recommended_skill_intents: ["browser:control-in-app-browser"],
        title: "Denied skill"
      }) as { decision: string; status: string };
      const allowed = actions.createIssueProposal({
        description: "Needs runner skill",
        required_skill_intents: ["codex-issue-runner"],
        title: "Allowed skill"
      }) as { decision: string; status: string };

      expect(denied).toMatchObject({ decision: "deny", status: "denied" });
      expect(allowed).toMatchObject({ decision: "execute", status: "completed" });
      expect(listIssues(db, { projectId: project.id }).map((issue) => issue.title)).toEqual(["Allowed skill"]);
      expect(JSON.parse(getIssue(db, 1)?.required_skill_intents ?? "[]")).toEqual(["codex-issue-runner"]);
      expect(listPiActions(db).map((action) => action.status).sort()).toEqual(["completed", "denied"]);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; project: Project; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-skill-tools-"));
  tempRoots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", cwd, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing project");
  return { db, project, root };
}

async function writeSkill(root: string, id: string, description: string): Promise<void> {
  const dir = join(root, "skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n`);
}

async function writeBadSkill(root: string, id: string): Promise<void> {
  const dir = join(root, "skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# Missing front matter");
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, title: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, title, status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function toolNames(tools: ReturnType<typeof createPiRunnerActionTools>): string[] {
  return tools.map((tool) => tool.name);
}

function toolByName(tools: ReturnType<typeof createPiRunnerActionTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function runTool(tools: ReturnType<typeof createPiRunnerActionTools>, name: string, params: Record<string, unknown>) {
  return await toolByName(tools, name).execute("tool-call", params as never, undefined, undefined, {} as never) as { details: any };
}
