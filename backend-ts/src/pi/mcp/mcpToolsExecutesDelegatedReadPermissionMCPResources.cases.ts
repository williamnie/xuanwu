import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createPiRunnerActions } from "../runnerTools/runnerActions.ts";
import { createPiRunnerActionTools } from "../runnerTools/runnerActionTools.ts";

import { tempRoots, previousRegistry, openFixture, writeRealMcpServer, offlineServer, docsServer, realMcpServer, missingMcpServer, REAL_MCP_SERVER_SCRIPT, toolNames, toolByName, runTool } from "./mcpToolsTestFixtures.ts";

export function registerExecutesDelegatedReadPermissionMCPResources() {
test("executes delegated read-permission MCP resources when allowlist covers them", async () => {
    const { db, project, root } = await openFixture();
    const serverScript = await writeRealMcpServer(root);
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [realMcpServer(serverScript)] });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowed_mcp_capabilities: ["docs:resource:internal"],
          authorizedActions: [{ action_type: "mcp.resource.read", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        project
      });
      const result = await actions.readMcpResource({ capability_id: "docs:resource:internal" }) as {
        content: string;
        decision?: string;
        status?: string;
      };
      const action = listPiActions(db).find((item) => item.action_type === "mcp.resource.read");

      expect(result).toMatchObject({ content: "real deploy safely" });
      expect(action).toMatchObject({
        action_type: "mcp.resource.read",
        gate_decision: "execute",
        requires_confirmation: 1,
        risk_level: "medium",
        status: "completed"
      });
      expect(listPiActionEvents(db, { actionId: action?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      db.close();
    }
  });
}
