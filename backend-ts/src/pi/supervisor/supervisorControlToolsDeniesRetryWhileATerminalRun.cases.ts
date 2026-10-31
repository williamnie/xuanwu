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

import { trackDatabase, tempRoots, openFixture, delegatedAuthorization, insertRun, requireTool, runTool, visibleText, ToolLike, validateArgs } from "./supervisorControlToolsTestFixtures.ts";

export function registerDeniesRetryWhileATerminalRun() {
test("denies retry while a terminal Run is waiting for PI semantic acceptance", async () => {
    const fixture = await openFixture();
    const issue = createIssue(fixture.db, {
      project_id: fixture.project.id,
      status: "in_progress",
      title: "Do not rerun before PI acceptance"
    });
    const runID = insertRun(fixture.db, issue.id, "succeeded");
    const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
      conversationID: "conv-handoff-gap",
      source: "runner_chat"
    });

    const result = await runTool(tools, "run_control", {
      action: "retry",
      expected_revision: 0,
      idempotency_key: "must-not-retry-completed-run",
      reason: "user asked to retry",
      run_id: runID
    });

    expect(result.details).toMatchObject({
      action_type: "run.retry",
      decision: "deny",
      gate_reason: expect.stringContaining("PI semantic acceptance is pending"),
      status: "denied"
    });
    expect(getIssue(fixture.db, issue.id)?.status).toBe("in_progress");
    expect(listPiActionEvents(fixture.db, {
      actionId: listPiActions(fixture.db)[0]!.id
    }).map((event) => event.event_type)).toEqual(["candidate", "gate_decision"]);
  });
}
