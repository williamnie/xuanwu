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
import { registerExposesMCPRegistryAndRecommendationTools } from "./mcpToolsExposesMCPRegistryAndRecommendationTools.cases.ts";
import { registerNormalizesRealMCPTransportErrorsTimeouts } from "./mcpToolsNormalizesRealMCPTransportErrorsTimeouts.cases.ts";
import { registerExecutesDelegatedReadPermissionMCPResources } from "./mcpToolsExecutesDelegatedReadPermissionMCPResources.cases.ts";

afterEach(async () => {
  if (previousRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
  else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousRegistry;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI MCP registry and envelope tools", () => {
  registerExposesMCPRegistryAndRecommendationTools();
  registerNormalizesRealMCPTransportErrorsTimeouts();
  registerExecutesDelegatedReadPermissionMCPResources();
});
