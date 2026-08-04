import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createProject } from "../db/repositories/projects.ts";
import { buildIssuePromptForTest } from "./projectLoop.ts";

const tempRoots: string[] = [];
const previousRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;

afterEach(async () => {
  if (previousRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
  else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousRegistry;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("runner issue MCP prompt context", () => {
  test("injects MCP requirements and registry metadata into executor prompt", async () => {
    const { cwd, db } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({
      servers: [{
        id: "docs",
        readiness: "ready",
        resources: [{ name: "runbook", description: "Deployment runbook", content: "hidden" }],
        status: "enabled"
      }]
    });
    try {
      const project = createProject(db, {
        cwd,
        default_mcp_policy: { allowed: ["docs:resource:runbook"] },
        id: "demo"
      });
      const issue = createIssue(db, {
        description: "Use the deployment runbook",
        project_id: project.id,
        required_mcp_capabilities: ["docs:resource:runbook"],
        title: "MCP prompt"
      });

      const prompt = buildIssuePromptForTest(project, issue);

      expect(prompt).toContain("## MCP Requirement Context");
      expect(prompt).toContain("Required MCP capabilities: [\"docs:resource:runbook\"]");
      expect(prompt).toContain("Project default MCP policy");
      expect(prompt).toContain("Deployment runbook");
      expect(prompt).not.toContain("hidden");
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ cwd: string; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-mcp-prompt-context-"));
  tempRoots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  return { cwd, db: await openDatabase({ stateDir: join(root, "state") }) };
}
