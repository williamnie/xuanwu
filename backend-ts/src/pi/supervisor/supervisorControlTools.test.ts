import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { createProject, type Project } from "../../db/repositories/projects.ts";
import { getIssueAsWork, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { listBuiltinAssistantTools } from "../tools/builtinToolRegistry.ts";
import {
  createPiSupervisorControlTools,
  SUPERVISOR_CONTROL_TOOL_NAMES,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
} from "./supervisorControlTools.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, tempRoots, openFixture, delegatedAuthorization, insertRun, requireTool, runTool, visibleText, type ToolLike, validateArgs } from "./supervisorControlToolsTestFixtures.ts";
import { registerPublishesDeterministicSchemasWithReadWrite } from "./supervisorControlToolsPublishesDeterministicSchemasWithReadWrite.cases.ts";
import { registerKeepsDestructiveWorkCancellationPendingEven } from "./supervisorControlToolsKeepsDestructiveWorkCancellationPendingEven.cases.ts";
import { registerDeniesRetryWhileATerminalRun } from "./supervisorControlToolsDeniesRetryWhileATerminalRun.cases.ts";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Supervisor Work/Run control tools", () => {
  registerPublishesDeterministicSchemasWithReadWrite();
  registerKeepsDestructiveWorkCancellationPendingEven();
  registerDeniesRetryWhileATerminalRun();
});
