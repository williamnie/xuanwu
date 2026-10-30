import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { listAutomations } from "../../db/repositories/automations.ts";
import type { AgentSession } from "../../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, listIssues } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";
import { insertIssue as insertIssueRow, insertProject, useTestDatabase } from "../../testing/harness.ts";

import { HUMAN_REVIEW, HUMAN_REVIEW_RESPONSE, BATCH, VALID_ARGUMENTS, INVALID_ARGUMENTS, DELEGATED_CALLS, openDatabase, projectIDs, sessionKeys, fakeActions, detailedBatchItem, insertAgentProfile, openFixture, insertIssue, insertAgentSession } from "./runnerActionToolsFixtureHUMAN_REVIEW.ts";
import { toolByName, validateArgs, collectToolText, runTool } from "./runnerActionToolsFixtureToolByName.ts";
import { registerDefinesSchemasAndDelegatesToolCalls } from "./runnerActionToolsDefinesSchemasAndDelegatesToolCalls.cases.ts";
import { registerExecutesSafeReadsAndLowRisk } from "./runnerActionToolsExecutesSafeReadsAndLowRisk.cases.ts";
import { registerReturnsCompactExecutionStatusForOne } from "./runnerActionToolsReturnsCompactExecutionStatusForOne.cases.ts";
import { registerKeepsConfirmRequiredActionsPendingAnd } from "./runnerActionToolsKeepsConfirmRequiredActionsPendingAnd.cases.ts";
import { registerDelegatedRunnerChatBatchEnqueuesAll } from "./runnerActionToolsDelegatedRunnerChatBatchEnqueuesAll.cases.ts";
import { registerRendersRepoContextPackIntoIssue } from "./runnerActionToolsRendersRepoContextPackIntoIssue.cases.ts";
import { registerListsTheCurrentCodeAgentsAnd } from "./runnerActionToolsListsTheCurrentCodeAgentsAnd.cases.ts";



describe("PI runner action tools", () => {
  registerDefinesSchemasAndDelegatesToolCalls();
  registerExecutesSafeReadsAndLowRisk();
  registerReturnsCompactExecutionStatusForOne();
  registerKeepsConfirmRequiredActionsPendingAnd();
  registerDelegatedRunnerChatBatchEnqueuesAll();
  registerRendersRepoContextPackIntoIssue();
  registerListsTheCurrentCodeAgentsAnd();
});
