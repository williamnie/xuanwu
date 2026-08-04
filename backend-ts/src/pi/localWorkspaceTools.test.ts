import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { ensureDefaultPiAgent } from "../db/defaultPiAgent.ts";
import {
  createPiConversation,
  getPiConversation,
  listPiActions
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiLocalWorkspaceTools, PI_LOCAL_WORKSPACE_TOOL_NAMES } from "./localWorkspaceTools.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI local workspace tools", () => {
  test("creates and attaches a project, then writes a PRD without creating Work", async () => {
    const fixture = await openFixture();
    try {
      const projectRoot = join(fixture.root, "fashion-studio");
      const prompt = `在 ${projectRoot} 新建项目并把 PRD 写到 PRD.md`;
      const tools = createPiLocalWorkspaceTools(fixture.db, undefined, runnerContext(prompt));
      expect(tools.map((tool) => tool.name)).toEqual([...PI_LOCAL_WORKSPACE_TOOL_NAMES]);
      expect(validateArgs(toolByName(tools, "project_create"), { cwd: projectRoot, id: "fashion-studio" }))
        .toEqual({ cwd: projectRoot, id: "fashion-studio" });

      const created = await execute(tools, "project_create", {
        cwd: projectRoot,
        id: "fashion-studio",
        name: "Fashion Studio"
      });
      const written = await execute(tools, "workspace_write_file", {
        content: "# Fashion Studio PRD\n\n## MVP\n生成服装模特图。\n",
        path: "PRD.md",
        project_id: "fashion-studio"
      });

      expect(created.details).toMatchObject({
        action_type: "project.create",
        decision: "execute",
        result: {
          conversation_attached: true,
          directory_created: true,
          project: { cwd: projectRoot, id: "fashion-studio" },
          provider_started: false
        },
        status: "completed"
      });
      expect(written.details).toMatchObject({
        action_type: "workspace.write_file",
        decision: "execute",
        result: {
          path: join(realpathSync(projectRoot), "PRD.md"),
          project_id: "fashion-studio",
          provider_started: false,
          status: "created"
        },
        status: "completed"
      });
      expect(readFileSync(join(projectRoot, "PRD.md"), "utf8")).toContain("生成服装模特图");
      expect(getProject(fixture.db, "fashion-studio")).toMatchObject({ cwd: projectRoot, pi_managed: 1 });
      expect(getPiConversation(fixture.db, "conv-local")).toMatchObject({ project_id: "fashion-studio" });
      expect(fixture.db.sqlite.query("select count(*) as count from issues").get()).toEqual({ count: 0 });
      expect(listPiActions(fixture.db).map((action) => action.action_type).sort()).toEqual([
        "project.create",
        "workspace.write_file"
      ].sort());
    } finally {
      fixture.db.close();
    }
  });

  test("keeps writes inside an explicitly targeted project and refuses source code", async () => {
    const fixture = await openFixture();
    try {
      const projectRoot = join(fixture.root, "docs-only");
      const tools = createPiLocalWorkspaceTools(fixture.db, undefined, runnerContext(`创建 ${projectRoot}`));
      await execute(tools, "project_create", { cwd: projectRoot, id: "docs-only" });

      await expect(execute(tools, "workspace_write_file", {
        content: "escape",
        path: "../outside.md",
        project_id: "docs-only"
      })).rejects.toThrow("path must stay inside the project root");
      await expect(execute(tools, "workspace_write_file", {
        content: "export const value = 1;",
        path: "src/index.ts",
        project_id: "docs-only"
      })).rejects.toThrow("use a coding Work/Run for source files");
      expect(existsSync(join(fixture.root, "outside.md"))).toBe(false);
    } finally {
      fixture.db.close();
    }
  });

  test("backs up an existing text artifact before an explicit replacement", async () => {
    const fixture = await openFixture();
    try {
      const projectRoot = join(fixture.root, "replace-doc");
      const tools = createPiLocalWorkspaceTools(fixture.db, undefined, runnerContext(`在 ${projectRoot} 更新 README.md`));
      await execute(tools, "project_create", { cwd: projectRoot, id: "replace-doc" });
      await execute(tools, "workspace_write_file", {
        content: "first\n",
        path: "README.md",
        project_id: "replace-doc"
      });
      const replaced = await execute(tools, "workspace_write_file", {
        content: "second\n",
        mode: "replace",
        path: "README.md",
        project_id: "replace-doc"
      });
      const result = (replaced.details as { result: { backup_path: string } }).result;

      expect(readFileSync(join(projectRoot, "README.md"), "utf8")).toBe("second\n");
      expect(readFileSync(result.backup_path, "utf8")).toBe("first\n");
    } finally {
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-local-workspace-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  ensureDefaultPiAgent(db);
  createPiConversation(db, {
    id: "conv-local",
    pi_agent_id: "runner-default",
    pi_session_id: "conv-local",
    session_file: join(root, "conv-local.jsonl")
  });
  return { db, root };
}

function runnerContext(prompt: string) {
  const actions = ["project.create", "workspace.make_directory", "workspace.write_file"];
  return {
    authorization: {
      allowedActions: actions,
      authorizedActions: actions.map((action_type) => ({ action_type })),
      mode: "delegated" as const,
      scopes: [{ runner_resource: "projects" }, { runner_resource: "workspace" }]
    },
    conversationID: "conv-local",
    source: "runner_chat",
    sourceTurn: { userPrompt: prompt }
  };
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function validateArgs(tool: ToolDefinition, input: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: input } as never);
}

async function execute(tools: ToolDefinition[], name: string, input: Record<string, unknown>) {
  return await toolByName(tools, name).execute(
    `call-${name}`,
    input as never,
    undefined,
    undefined,
    {} as never
  ) as { details: unknown };
}
