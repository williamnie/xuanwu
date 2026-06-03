import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createIssue } from "./issueCreate.ts";
import { updateIssue } from "./issueUpdate.ts";
import { createProject } from "./projects.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("MCP capability persistence", () => {
  test("saves project default policy and issue required/recommended MCP capabilities", async () => {
    const { cwd, db } = await openFixture();
    try {
      const project = createProject(db, {
        cwd,
        default_mcp_policy: {
          allowed: ["docs:resource:runbook"],
          recommended: ["docs:resource:runbook"],
          required: ["docs:resource:runbook"]
        },
        id: "demo"
      });
      const issue = createIssue(db, {
        project_id: project.id,
        recommended_mcp_capabilities: "docs:tool:search",
        required_mcp_capabilities: ["docs:resource:runbook"],
        title: "MCP issue"
      });
      const patched = updateIssue(db, issue.id, {
        recommended_mcp_capabilities: ["docs:resource:runbook"]
      });

      expect(JSON.parse(project.default_mcp_policy)).toEqual({
        allowed: ["docs:resource:runbook"],
        recommended: ["docs:resource:runbook"],
        required: ["docs:resource:runbook"]
      });
      expect(JSON.parse(issue.required_mcp_capabilities)).toEqual(["docs:resource:runbook"]);
      expect(JSON.parse(issue.recommended_mcp_capabilities)).toEqual(["docs:tool:search"]);
      expect(JSON.parse(patched.recommended_mcp_capabilities)).toEqual(["docs:resource:runbook"]);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ cwd: string; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-mcp-capabilities-"));
  tempRoots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  return { cwd, db: await openDatabase({ stateDir: join(root, "state") }) };
}
